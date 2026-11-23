import { Hantek6022, USB_FILTERS, SAMPLE_RATES, GAINS } from './scope-driver.js';
import { SimScope } from './sim-scope.js';
import { findTrigger, measureAll, MEASUREMENTS, spectrum, si } from './dsp.js';

// ---------------------------------------------------------------- constants
const TIMEBASES = [];
for (let e = -7; e <= 2; e++) for (const m of [1, 2, 5]) TIMEBASES.push(m * 10 ** e);   // 100 ns/div … 500 s/div
TIMEBASES.splice(TIMEBASES.indexOf(200), 2); // stop at 100 s/div
const BASE_RANGES = [0.05, 0.1, 0.2, 0.5, 1, 2, 5];
const PROBES = [[1, 'x1'], [10, 'x10'], [20, 'x20'], [100, 'x100']];
const SIG_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const STREAM_FROM = 1.0;          // window (s) at or above which we stream (>= 100 ms/div)
const MAX_RATE = { 1: 48e6, 2: 24e6 };
const BUFFER_MAX = 32, BUFFER_SAMPLES = 24e6;
const DIV_X = 10, DIV_Y = 10;

// ---------------------------------------------------------------- state
const DEFAULTS = {
  view: 'scope', tb: TIMEBASES.indexOf(1e-3), maxSamples: 100000, theme: 'light',
  ch: [{ on: true, range: 5, probe: 1, coupling: 'DC', offset: 0 }, { on: true, range: 5, probe: 1, coupling: 'DC', offset: 0 }],
  math: 'off',
  trig: { mode: 'auto', src: 0, type: 'rising', level: 1, pre: 50, width: 1e-3 },
  rulers: { t: null, v: null }, persist: false, sigHz: 1000,
  meas: [{ ch: 0, type: 'freq' }, { ch: 0, type: 'pp' }, { ch: 1, type: 'rms' }],
};
let S = load();
function load() {
  try { const s = JSON.parse(localStorage.getItem('hantekScope') || 'null'); if (s) return deepMerge(structuredClone(DEFAULTS), s); } catch { }
  return structuredClone(DEFAULTS);
}
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]); else a[k] = b[k]; } return a; }
let saveTimer;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem('hantekScope', JSON.stringify(S)); } catch { } }, 300); }

let scope = null, demo = false;
let running = false, looping = false;
let buffer = [], bufIdx = -1, live = null;      // live: partial streaming sweep
let ref = null;
let applied = {};                                // hardware state actually sent
let waiting = false, lastTrig = 0, wfCount = 0, wfRate = 0, gapWarn = 0, overRange = [false, false];
let stats = new Map(), statsKey = '';
let zoom = { z: 1, c: 0 };                       // zoom factor and centre (seconds rel. to view start)
let dirty = true;
let persistLayer = null;
let specCache = { wave: null, data: null };

const $ = id => document.getElementById(id);
const canvas = $('plot');
let ctx = canvas.getContext('2d');

// ---------------------------------------------------------------- helpers
const tdiv = () => TIMEBASES[S.tb];
const windowLen = () => DIV_X * tdiv();
const rangesFor = p => BASE_RANGES.map(r => r * p);
const gainFor = v => { for (const g of [...GAINS].reverse()) if (5.12 / g >= v * 0.98) return g; return 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const needB = () => S.ch[1].on || !['off', '-a'].includes(S.math) || (S.trig.mode !== 'none' && S.trig.src == 1);

function hwConfig() {
  const W = windowLen();
  const nch = needB() ? 2 : 1;
  const rates = SAMPLE_RATES.filter(r => r[1] <= MAX_RATE[nch]);
  let pick = rates[0];
  for (const r of rates) if (r[1] * W <= S.maxSamples) pick = r;
  const streaming = W >= STREAM_FROM;
  const decim = Math.max(1, Math.ceil(pick[1] * W / S.maxSamples));
  const gains = [0, 1].map(c => gainFor(S.ch[c].range / S.ch[c].probe));
  const acdc = (S.ch[0].coupling === 'DC' ? 1 : 0) | ((S.ch[1].coupling === 'DC' ? 1 : 0) << 4);
  return { W, nch, rateCode: pick[0], rate: pick[1], streaming, decim, gains, acdc };
}
const cfgKey = c => [c.nch, c.rateCode, c.streaming, c.decim, c.gains, c.acdc, c.W].join('|');

function parseSI(str) {
  const m = String(str).trim().replace(',', '.').match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([pnuµmkM]?)/i);
  if (!m) return NaN;
  const mul = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, M: 1e6 }[m[2]] ?? 1;
  return parseFloat(m[1]) * mul;
}
function niceUp(x) { const e = 10 ** Math.floor(Math.log10(x)); for (const m of [1, 2, 5, 10]) if (m * e >= x * 0.999) return m * e; return 10 * e; }

// ---------------------------------------------------------------- UI setup
function fillSelect(sel, items, value) {
  sel.innerHTML = items.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  if (value !== undefined) sel.value = String(value);
}
function refreshControls() {
  document.documentElement.dataset.theme = S.theme;
  fillSelect($('timebase'), TIMEBASES.map((t, i) => [i, si(t, 's', 3) + '/div']), S.tb);
  $('samples').value = String(S.maxSamples);
  $('view').value = S.view;
  for (const c of [0, 1]) {
    const g = document.querySelector(`.group[data-ch="${c}"]`), ch = S.ch[c];
    g.querySelector('.chip').classList.toggle('on', ch.on);
    fillSelect(g.querySelector('.range'), rangesFor(ch.probe).map(r => [r, '±' + si(r, 'V', 3)]), ch.range);
    g.querySelector('.coupling').value = ch.coupling;
    fillSelect(g.querySelector('.probe'), PROBES, ch.probe);
  }
  $('math').value = S.math;
  $('trigMode').value = S.trig.mode; $('trigSrc').value = String(S.trig.src); $('trigType').value = S.trig.type;
  $('trigLevel').value = si(S.trig.level, 'V', 3); $('trigPre').value = S.trig.pre;
  $('trigWidth').value = si(S.trig.width, 's', 3);
  $('trigWidth').classList.toggle('hidden', !S.trig.type.startsWith('pulse'));
  $('rulerT').classList.toggle('on', !!S.rulers.t); $('rulerV').classList.toggle('on', !!S.rulers.v);
  $('persist').classList.toggle('on', S.persist);
  $('refBtn').classList.toggle('on', !!ref);
  fillSelect($('sigFreq'), SIG_FREQS.map(f => [f, si(f, 'Hz', 3)]), S.sigHz);
  updateRunBtn(); renderMeasTable(); dirty = true;
}
function changed() { save(); refreshControls(); resetStats(); persistLayer = null; dirty = true; }

function setTimebase(i) {
  if (i < 0 || i >= TIMEBASES.length) return;
  const k = TIMEBASES[i] / tdiv();
  if (S.rulers.t) S.rulers.t = S.rulers.t.map(t => t * k);   // keep rulers in the same place on screen
  S.tb = i; zoom = { z: 1, c: 0 }; changed();
}
$('timebase').onchange = e => setTimebase(+e.target.value);
$('tbDown').onclick = () => setTimebase(S.tb - 1);
$('tbUp').onclick = () => setTimebase(S.tb + 1);
$('samples').onchange = e => { S.maxSamples = +e.target.value; changed(); };
$('view').onchange = e => { S.view = e.target.value; changed(); };
$('math').onchange = e => { S.math = e.target.value; changed(); };
for (const c of [0, 1]) {
  const g = document.querySelector(`.group[data-ch="${c}"]`);
  g.querySelector('.chip').onclick = () => { S.ch[c].on = !S.ch[c].on; changed(); };
  g.querySelector('.range').onchange = e => { S.ch[c].range = +e.target.value; changed(); };
  g.querySelector('.coupling').onchange = e => { S.ch[c].coupling = e.target.value; changed(); };
  g.querySelector('.probe').onchange = e => {
    const old = S.ch[c].probe, p = +e.target.value;
    S.ch[c].probe = p; S.ch[c].range = rangesFor(p).reduce((a, r) => Math.abs(Math.log(r / (S.ch[c].range / old * p))) < Math.abs(Math.log(a / (S.ch[c].range / old * p))) ? r : a);
    S.ch[c].offset *= p / old; if (S.trig.src == c) S.trig.level *= p / old;
    changed();
  };
}
$('trigMode').onchange = e => { S.trig.mode = e.target.value; if (S.trig.mode === 'single' && !running) start(); changed(); };
$('trigSrc').onchange = e => { S.trig.src = +e.target.value; changed(); };
$('trigType').onchange = e => { S.trig.type = e.target.value; changed(); };
$('trigLevel').onchange = e => { const v = parseSI(e.target.value); if (isFinite(v)) S.trig.level = v; changed(); };
$('trigWidth').onchange = e => { const v = parseSI(e.target.value); if (v > 0) S.trig.width = v; changed(); };
$('trigPre').onchange = e => { S.trig.pre = Math.max(0, Math.min(100, +e.target.value || 0)); changed(); };
$('rulerT').onclick = () => { const W = windowLen(), p = viewPre(); S.rulers.t = S.rulers.t ? null : [W * (0.3 - p), W * (0.7 - p)]; changed(); };
$('rulerV').onclick = () => { const c = rulerCh(), r = S.ch[c].range; S.rulers.v = S.rulers.v ? null : [r * 0.4 - S.ch[c].offset, -r * 0.4 - S.ch[c].offset]; changed(); };
$('persist').onclick = () => { S.persist = !S.persist; changed(); };
$('refBtn').onclick = () => { const w = currentWave(); ref = ref ? null : (w ? { ...w, data: w.data.map(d => d && d.slice()) } : null); changed(); };
$('themeBtn').onclick = () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; colors = null; changed(); };
$('bufPrev').onclick = () => navBuffer(-1);
$('bufNext').onclick = () => navBuffer(+1);
$('runBtn').onclick = () => running ? stop() : start();
$('connectBtn').onclick = () => connect();
$('ovConnect').onclick = () => connect();
$('ovDemo').onclick = () => startDemo();
$('autoSetup').onclick = () => autoSetup();
$('sigFreq').onchange = e => { S.sigHz = +e.target.value; scope?.setCalFrequency(S.sigHz).catch(showError); save(); };
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); running ? stop() : start(); }
  if (e.code === 'ArrowLeft') navBuffer(-1);
  if (e.code === 'ArrowRight') navBuffer(1);
});

// popovers
function popover(btnId, popId) {
  const btn = $(btnId), pop = $(popId);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const show = !pop.classList.contains('show');
    document.querySelectorAll('.pop').forEach(p => p.classList.remove('show'));
    if (!show) return;
    pop.classList.add('show');
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left)) + 'px';
    pop.style.top = (r.bottom + ph + 8 < innerHeight ? r.bottom + 6 : r.top - ph - 6) + 'px';
  });
  pop.addEventListener('click', e => e.stopPropagation());
}
popover('addMeas', 'measPop'); popover('sigGenBtn', 'sigPop'); popover('saveBtn', 'savePop');
document.addEventListener('click', () => document.querySelectorAll('.pop').forEach(p => p.classList.remove('show')));
fillSelect($('measType'), Object.entries(MEASUREMENTS).map(([k, m]) => [k, m.label]));
$('measOk').onclick = () => { S.meas.push({ ch: +$('measCh').value, type: $('measType').value }); changed(); };
$('measReset').onclick = () => { resetStats(); renderMeasTable(); };

// ---------------------------------------------------------------- device
function setDevState(text, cls) { $('devName').textContent = text; $('devState').className = cls || ''; $('connectBtn').textContent = scope && !demo ? 'Disconnect' : 'Connect'; }
function showOverlay(msg) { $('overlay').classList.remove('hide'); $('connectMsg').textContent = msg || ''; }
function hideOverlay() { $('overlay').classList.add('hide'); }
function showError(e) { console.error(e); $('warnInfo').textContent = String(e.message || e); }

async function connect() {
  if (scope && !demo) { await stop(); await scope.close(); scope = null; setDevState('Not connected'); showOverlay(); return; }
  if (!navigator.usb) { showOverlay('This browser has no WebUSB. Please use Google Chrome or Microsoft Edge.'); return; }
  let dev;
  try { dev = await navigator.usb.requestDevice({ filters: USB_FILTERS }); } catch { return; }
  await openDevice(dev);
}
let opening = false;
async function openDevice(dev) {
  if ((scope && !demo) || opening) return;
  opening = true;
  const hs = new Hantek6022(navigator.usb);
  let res;
  try {
    await stop();
    showOverlay('Connecting…');
    res = await hs.open(dev, m => showOverlay(m));
  } catch (e) {
    showOverlay('Could not open the scope: ' + (e.message || e) + '. Close OpenHantek or the Hantek software if they are running, then unplug and re-plug the scope.');
    return;
  } finally { opening = false; }
  if (res === 'reconnect') {
    showOverlay('Firmware loaded. Waiting for the scope to restart…');
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if ((scope && !demo) || opening) return;
      const d = (await navigator.usb.getDevices()).find(Hantek6022.isReady);
      if (d) return openDevice(d);
    }
    showOverlay('Firmware loaded. Now click Connect again and choose “DSO-6022BE” (only needed the first time).');
    return;
  }
  scope = hs; demo = false; applied = {};
  await scope.setCalFrequency(S.sigHz).catch(() => { });
  setDevState(`${scope.model} · ${scope.serial}`, 'ok');
  hideOverlay(); start();
}
async function startDemo() {
  await stop();
  scope = new SimScope(); demo = true; applied = {};
  await scope.setCalFrequency(S.sigHz);
  setDevState('Demo mode (no scope)', 'demo');
  hideOverlay(); start();
}
if (navigator.usb) {
  navigator.usb.addEventListener('connect', e => {
    if ((!scope || demo) && Hantek6022.isOurs(e.device)) openDevice(e.device);
  });
  navigator.usb.addEventListener('disconnect', e => {
    if (scope && !demo && scope.dev === e.device) {
      running = false; scope = null; setDevState('Not connected'); updateRunBtn();
      showOverlay('The scope was disconnected. Plug it back in and click Connect.');
    }
  });
}
async function autoConnect() {
  if (!navigator.usb) { showOverlay('This browser has no WebUSB. Please use Google Chrome or Microsoft Edge.'); return; }
  const devs = (await navigator.usb.getDevices()).filter(Hantek6022.isOurs);
  const d = devs.find(Hantek6022.isReady) || devs[0];
  if (d) openDevice(d); else showOverlay();
}

async function applyHw(cfg) {
  const a = applied;
  if (a.nch !== cfg.nch) { await scope.setChannels(cfg.nch); a.nch = cfg.nch; }
  if (a.rate !== cfg.rateCode) { await scope.setSampleRate(cfg.rateCode); a.rate = cfg.rateCode; }
  for (const c of [0, 1]) if (a['g' + c] !== cfg.gains[c]) { await scope.setGain(c, cfg.gains[c]); a['g' + c] = cfg.gains[c]; }
  if (a.acdc !== cfg.acdc) { await scope.setCoupling(0, cfg.acdc & 1); await scope.setCoupling(1, cfg.acdc & 0x10); a.acdc = cfg.acdc; }
}

// ---------------------------------------------------------------- acquisition
function updateRunBtn() {
  const b = $('runBtn');
  b.classList.toggle('running', running);
  b.innerHTML = running
    ? '<svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="1.5" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 20 20"><path d="M6 3.5v13l11-6.5z" fill="currentColor"/></svg>';
}
function start() {
  if (!scope) { showOverlay(); return; }
  running = true; bufIdx = -1; updateRunBtn(); loop();
}
async function stop() {
  running = false; updateRunBtn();
  while (looping) await sleep(10);
}
async function loop() {
  if (looping) return;
  looping = true;
  try {
    while (running && scope) {
      const cfg = hwConfig();
      await applyHw(cfg);
      if (cfg.streaming) await runStream(cfg); else await runBlock(cfg);
    }
  } catch (e) {
    showError(e);
    running = false;
  }
  waiting = false; live = null; looping = false; updateRunBtn(); dirty = true;
}

function toVolts(raw, nch, rate) {
  const n = raw.length / nch, out = [null, null];
  overRange = [false, false];
  for (let c = 0; c < nch; c++) {
    const zero = scope.zeroCount(c), k = scope.voltsPerCount(c) * S.ch[c].probe;
    const a = new Float32Array(n);
    let sum = 0, clip = false;
    for (let i = 0, j = c; i < n; i++, j += nch) { const x = raw[j]; if (x === 0 || x === 255) clip = true; a[i] = (x - zero) * k; sum += a[i]; }
    if (S.ch[c].coupling === 'AC') { const m = sum / n; for (let i = 0; i < n; i++) a[i] -= m; }
    overRange[c] = clip;
    out[c] = a;
  }
  return out;
}
function mathOf(d) {
  const [A, B] = d;
  if (S.math === 'off' || !A) return null;
  if (S.math === '-a') return A.map(x => -x);
  if (!B) return null;
  const f = { 'a+b': (a, b) => a + b, 'a-b': (a, b) => a - b, 'b-a': (a, b) => b - a, 'a*b': (a, b) => a * b }[S.math];
  const m = new Float32Array(A.length); for (let i = 0; i < A.length; i++) m[i] = f(A[i], B[i]); return m;
}

async function runBlock(cfg) {
  const { W, rate, nch } = cfg, dt = 1 / rate;
  const winS = Math.max(16, Math.ceil(W * rate));
  const trigOn = S.trig.mode !== 'none';
  const factor = trigOn ? (W < 0.02 ? 2 : 1.5) : 1;
  const total = Math.max(Math.ceil(winS * factor), trigOn ? 16384 : 0, winS);
  const t0 = performance.now();
  const { raw } = await scope.capture(total);
  const dur = performance.now() - t0, expect = total / rate * 1000;
  if (!demo && expect > 3 && dur > expect * 1.2 + 8) gapWarn = performance.now();
  if (!running) return;
  const data = toVolts(raw, nch, rate);
  if (nch === 1) data[1] = null;
  const preS = Math.round(S.trig.pre / 100 * winS);
  let ti = -1;
  if (trigOn) {
    const src = data[S.trig.src] || data[0];
    const r = S.ch[S.trig.src].range;
    ti = findTrigger(src, { type: S.trig.type, level: S.trig.level, hyst: Math.max(r * 0.015, scope.voltsPerCount(S.trig.src) * S.ch[S.trig.src].probe * 1.5), width: S.trig.width, dt },
      Math.max(1, preS), total - (winS - preS));
  }
  const now = performance.now();
  if (ti < 0 && trigOn) {
    const autoAfter = Math.max(200, W * 3000);
    if (!(S.trig.mode === 'auto' && now - lastTrig > autoAfter)) { waiting = true; dirty = true; await sleep(0); return; }
  } else if (ti >= 0) lastTrig = now;
  waiting = false;
  // keep only the displayed window (+ a little margin)
  const center = ti >= 0 ? ti : preS;
  const a = Math.max(0, Math.floor(center - preS) - 2), b = Math.min(total, a + winS + 4);
  const slice = data.map(d => d && d.slice(a, b));
  slice[2] = mathOf(slice);
  pushWave({ dt, data: slice, tTrig: (center - a) * dt, triggered: ti >= 0, rate, nch, time: Date.now(), streaming: false, overRange: [...overRange] });
  if (S.trig.mode === 'single' && ti >= 0) { running = false; updateRunBtn(); }
  await sleep(0);
}

async function runStream(cfg) {
  const { W, rate, nch, decim } = cfg, key = cfgKey(cfg);
  const bins = Math.ceil(W * rate / decim);
  const mk = () => ({ dt: decim / rate, data: [new Float32Array(bins), nch === 2 ? new Float32Array(bins) : null, null], n: 0, tTrig: 0, rate, nch, streaming: true, triggered: false, overRange: [false, false] });
  live = mk();
  const acc = [0, 0]; let accN = 0;
  const chunk = Math.max(512, Math.min(65536, Math.round(rate * nch / 25 / 512) * 512));
  const handle = scope.stream(raw => {
    const v = toVolts(raw, nch, rate);
    for (let c = 0; c < nch; c++) if (overRange[c]) live.overRange[c] = true;
    const n = raw.length / nch;
    for (let i = 0; i < n; i++) {
      acc[0] += v[0][i]; if (nch === 2) acc[1] += v[1][i];
      if (++accN === decim) {
        live.data[0][live.n] = acc[0] / decim; if (nch === 2) live.data[1][live.n] = acc[1] / decim;
        acc[0] = acc[1] = 0; accN = 0;
        if (++live.n >= bins) {
          const w = live; w.data[2] = mathOf(w.data); w.time = Date.now();
          pushWave(w); live = mk();
        }
      }
    }
    dirty = true;
  }, chunk);
  while (running && key === cfgKey(hwConfig())) await sleep(40);
  await handle.stop();
  live = null;
}

function pushWave(w) {
  buffer.push(w);
  let tot = buffer.reduce((s, x) => s + x.data[0].length, 0);
  while (buffer.length > BUFFER_MAX || (buffer.length > 1 && tot > BUFFER_SAMPLES)) tot -= buffer.shift().data[0].length;
  bufIdx = -1;
  wfCount++;
  updateStats(w);
  addPersist(w);
  dirty = true;
}
function currentWave() { return bufIdx >= 0 ? buffer[bufIdx] : buffer[buffer.length - 1]; }
function navBuffer(d) {
  if (!buffer.length) return;
  if (running) stop();
  let i = bufIdx < 0 ? buffer.length - 1 : bufIdx;
  i = Math.max(0, Math.min(buffer.length - 1, i + d));
  bufIdx = i; dirty = true; renderMeasTable();
}
setInterval(() => { wfRate = wfCount; wfCount = 0; dirty = true; }, 1000);

// ---------------------------------------------------------------- auto setup
async function autoSetup() {
  if (!scope) return;
  await stop();
  for (const c of [0, 1]) { S.ch[c].range = rangesFor(S.ch[c].probe).at(-1); S.ch[c].offset = 0; S.ch[c].coupling = 'DC'; }
  const grab = async (code, rate, n) => {
    await scope.setChannels(2); await scope.setSampleRate(code); await scope.setGain(0, 1); await scope.setGain(1, 1);
    applied = {};
    const { raw } = await scope.capture(n);
    const d = toVolts(raw, 2, rate);
    return d.map(v => measureAll(v, 0, v.length, 1 / rate));
  };
  let m = await grab(1, 1e6, 100000);
  if (m.some(x => x.edges > 500)) m = await grab(24, 24e6, 200000);
  let best = -1;
  for (const c of [0, 1]) {
    const x = m[c], peak = Math.max(Math.abs(x.max), Math.abs(x.min));
    if (x.pp > S.ch[c].range * 0.04) {
      S.ch[c].on = true;
      S.ch[c].range = rangesFor(S.ch[c].probe).find(r => r >= peak * 1.08) ?? rangesFor(S.ch[c].probe).at(-1);
      if (isFinite(x.freq) && best < 0) best = c;
    }
  }
  if (best >= 0) {
    const f = m[best].freq, target = 4 / f / DIV_X;
    S.tb = TIMEBASES.findIndex(t => t >= target * 0.999); if (S.tb < 0) S.tb = TIMEBASES.length - 1;
    S.trig = { ...S.trig, mode: 'auto', src: best, type: 'rising', level: +((m[best].max + m[best].min) / 2).toPrecision(3), pre: 50 };
  } else S.tb = TIMEBASES.indexOf(1e-3);
  zoom = { z: 1, c: 0 };
  changed(); start();
}

// ---------------------------------------------------------------- measurements
function resetStats() { stats = new Map(); }
function updateStats(w) {
  const key = cfgKey(hwConfig()) + JSON.stringify(S.ch) + S.math;
  if (key !== statsKey) { stats = new Map(); statsKey = key; }
  const res = [0, 1, 2].map(c => w.data[c] ? measureAll(w.data[c], ...measRange(w), w.dt) : null);
  w.meas = res;
  S.meas.forEach((m, i) => {
    const v = res[m.ch]?.[m.type];
    const s = stats.get(i) || { n: 0, min: Infinity, max: -Infinity, sum: 0, sum2: 0 };
    if (isFinite(v)) { s.n++; s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.sum += v; s.sum2 += v * v; }
    stats.set(i, s);
  });
  measDirty = true;
}
// sample range of the wave that is on screen (whole window, or the zoomed part)
function measRange(w) {
  const { tL, span } = viewSpan(w);
  const n = w.n ?? w.data[0]?.length ?? 0;
  const a = Math.max(0, Math.floor((tL + w.tTrig) / w.dt)), b = Math.min(n, Math.ceil((tL + span + w.tTrig) / w.dt) + 1);
  return [a, Math.max(a, b)];
}
let measDirty = true;
function renderMeasTable() {
  const w = currentWave();
  const names = ['A', 'B', 'Math'], cols = ['var(--chA)', 'var(--chB)', 'var(--math)'];
  $('measBody').innerHTML = S.meas.map((m, i) => {
    const info = MEASUREMENTS[m.type], s = stats.get(i);
    const v = w?.meas?.[m.ch]?.[m.type];
    const f = x => (s && s.n ? si(x, info.unit) : '—');
    const avg = s?.n ? s.sum / s.n : NaN, sd = s?.n > 1 ? Math.sqrt(Math.max(0, s.sum2 / s.n - avg * avg)) : NaN;
    return `<tr><td><span class="dot" style="background:${cols[m.ch]}"></span>${names[m.ch]}</td><td>${info.label}</td>
      <td><b>${si(v, info.unit)}</b></td><td>${f(s?.min)}</td><td>${f(s?.max)}</td><td>${f(avg)}</td><td>${s?.n > 1 ? si(sd, info.unit) : '—'}</td><td>${s?.n ?? 0}</td>
      <td><button class="x" data-i="${i}" title="Remove">✕</button></td></tr>`;
  }).join('') || `<tr><td colspan="9" style="text-align:left;color:var(--muted)">No measurements. Click “+ Measurement” to add one.</td></tr>`;
  $('measBody').querySelectorAll('.x').forEach(b => b.onclick = () => { S.meas.splice(+b.dataset.i, 1); changed(); });
  measDirty = false;
}
setInterval(() => { if (measDirty) renderMeasTable(); }, 250);

// ---------------------------------------------------------------- view geometry
const M = { l: 62, r: 62, t: 8, b: 26 };
function layout() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const full = { x: M.l, y: M.t, w: Math.max(50, W - M.l - M.r), h: Math.max(50, H - M.t - M.b) };
  if (S.view === 'scope') return { scope: full };
  if (S.view === 'spectrum') return { spec: full };
  const h1 = Math.floor((H - M.t - 2 * M.b - 10) * 0.55);
  return { scope: { ...full, h: h1 }, spec: { ...full, y: M.t + h1 + M.b + 10, h: H - M.t - h1 - 2 * M.b - 10 } };
}
function viewPre(w) { return (w ?? currentWave() ?? live)?.streaming || (running && hwConfig().streaming) ? 0 : S.trig.pre / 100; }
function viewSpan(w) {
  const W = windowLen(), base = -viewPre(w) * W, span = W / zoom.z;
  let tL = base + zoom.c - span / 2;
  if (zoom.z === 1) tL = base;
  tL = Math.max(base, Math.min(base + W - span, tL));
  return { tL, span, base, W };
}
const chColor = c => [colors.chA, colors.chB, colors.math][c];
function yOf(R, c, v) {
  const ch = S.ch[c === 2 ? 0 : c];
  return R.y + R.h / 2 - (v + ch.offset) / ch.range * R.h / 2;
}
function vOf(R, c, y) { const ch = S.ch[c === 2 ? 0 : c]; return (R.y + R.h / 2 - y) / (R.h / 2) * ch.range - ch.offset; }
const xOf = (R, t, vs) => R.x + (t - vs.tL) / vs.span * R.w;
const tOf = (R, x, vs) => vs.tL + (x - R.x) / R.w * vs.span;
const rulerCh = () => (S.ch[0].on || !S.ch[1].on ? 0 : 1);

// ---------------------------------------------------------------- rendering
let colors = null;
function readColors() {
  const cs = getComputedStyle(document.documentElement), g = n => cs.getPropertyValue('--' + n).trim();
  colors = Object.fromEntries(['plot', 'grid', 'grid2', 'axis', 'chA', 'chB', 'math', 'ref', 'trig', 'text', 'muted', 'panel', 'stop', 'warn', 'border'].map(n => [n, g(n)]));
}
function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr);
  persistLayer = null; dirty = true;
}
new ResizeObserver(resize).observe(canvas);

function frame() {
  if (dirty) { dirty = false; try { render(); } catch (e) { console.error(e); } }
  requestAnimationFrame(frame);
}
function render() {
  if (!colors) readColors();
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors.plot; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const L = layout();
  const w = live && bufIdx < 0 ? live : currentWave();
  if (L.scope) renderScope(L.scope, w);
  if (L.spec) renderSpectrum(L.spec, live && bufIdx < 0 ? (currentWave() ?? live) : w);
  updateStatus();
}

function grid(R) {
  ctx.save();
  ctx.strokeStyle = colors.grid2; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < DIV_X * 5; i++) if (i % 5) { const x = Math.round(R.x + R.w * i / (DIV_X * 5)) + .5; ctx.moveTo(x, R.y + R.h / 2 - 3); ctx.lineTo(x, R.y + R.h / 2 + 3); }
  for (let i = 1; i < DIV_Y * 5; i++) if (i % 5) { const y = Math.round(R.y + R.h * i / (DIV_Y * 5)) + .5; ctx.moveTo(R.x + R.w / 2 - 3, y); ctx.lineTo(R.x + R.w / 2 + 3, y); }
  ctx.stroke();
  ctx.strokeStyle = colors.grid; ctx.setLineDash([1, 3]);
  ctx.beginPath();
  for (let i = 1; i < DIV_X; i++) { const x = Math.round(R.x + R.w * i / DIV_X) + .5; ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h); }
  for (let i = 1; i < DIV_Y; i++) { const y = Math.round(R.y + R.h * i / DIV_Y) + .5; ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = colors.grid; ctx.strokeRect(Math.round(R.x) + .5, Math.round(R.y) + .5, Math.round(R.w), Math.round(R.h));
  ctx.restore();
}
function label(text, x, y, color, align = 'left', base = 'middle', bg) {
  ctx.font = '11.5px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = align; ctx.textBaseline = base;
  if (bg) { const m = ctx.measureText(text), w = m.width + 8; const bx = align === 'right' ? x - w + 4 : align === 'center' ? x - w / 2 : x - 4; ctx.fillStyle = bg; ctx.fillRect(bx, y - 9, w, 18); }
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

function drawTrace(R, wv, arr, c, vs, color, width = 1.5, dash) {
  const n = wv.n ?? arr.length;
  if (!n) return;
  const dt = wv.dt;
  const i0 = Math.max(0, Math.floor((vs.tL + wv.tTrig) / dt) - 1), i1 = Math.min(n - 1, Math.ceil((vs.tL + vs.span + wv.tTrig) / dt) + 1);
  if (i1 <= i0) return;
  const pxPer = R.w / (vs.span / dt);
  ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  const X = i => R.x + (i * dt - wv.tTrig - vs.tL) / vs.span * R.w;
  if (pxPer < 0.7) {
    // min/max envelope per pixel column
    let col = Math.floor(X(i0)), mn = Infinity, mx = -Infinity, first = true;
    for (let i = i0; i <= i1; i++) {
      const x = Math.floor(X(i)), v = arr[i];
      if (x !== col) {
        if (mn <= mx) { const y1 = yOf(R, c, mx), y2 = yOf(R, c, mn); if (first) { ctx.moveTo(col + .5, y1); first = false; } else ctx.lineTo(col + .5, y1); ctx.lineTo(col + .5, y2 + (y2 - y1 < 1 ? 1 : 0)); }
        col = x; mn = Infinity; mx = -Infinity;
      }
      if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    if (mn <= mx) { ctx.lineTo(col + .5, yOf(R, c, mx)); ctx.lineTo(col + .5, yOf(R, c, mn)); }
  } else {
    let pen = false;
    for (let i = i0; i <= i1; i++) { const v = arr[i]; if (v !== v) { pen = false; continue; } const x = X(i), y = yOf(R, c, v); pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; }
  }
  ctx.stroke();
  if (pxPer > 7) {
    ctx.fillStyle = color;
    for (let i = i0; i <= i1; i++) { const v = arr[i]; if (v === v) { ctx.beginPath(); ctx.arc(X(i), yOf(R, c, v), 2.2, 0, 7); ctx.fill(); } }
  }
  ctx.restore();
}

function visibleChannels(wv) { return [0, 1, 2].filter(c => wv?.data[c] && (c === 2 ? S.math !== 'off' : S.ch[c].on)); }

function addPersist(wv) {
  if (!S.persist) return;
  const R = layout().scope; if (!R) return;
  const dpr = devicePixelRatio || 1;
  if (!persistLayer || persistLayer.width !== canvas.width || persistLayer.height !== canvas.height) {
    persistLayer = document.createElement('canvas'); persistLayer.width = canvas.width; persistLayer.height = canvas.height;
  }
  const pc = persistLayer.getContext('2d');
  pc.setTransform(1, 0, 0, 1, 0, 0);
  pc.globalCompositeOperation = 'destination-out'; pc.fillStyle = 'rgba(0,0,0,0.10)'; pc.fillRect(0, 0, persistLayer.width, persistLayer.height);
  pc.globalCompositeOperation = 'source-over';
  pc.setTransform(dpr, 0, 0, dpr, 0, 0);
  const saved = ctx; // reuse drawTrace by temporarily swapping the context
  const vs = viewSpan(wv);
  ctxSwap(pc, () => { pc.globalAlpha = 0.45; for (const c of visibleChannels(wv)) drawTrace(R, wv, wv.data[c], c, vs, chColor(c), 1.2); });
  void saved;
}
function ctxSwap(other, fn) { const keep = ctx; ctx = other; try { fn(); } finally { ctx = keep; } }

function renderScope(R, wv) {
  grid(R);
  const vs = viewSpan(wv);
  // axes: A on the left, B on the right
  for (const [c, side] of [[0, 'l'], [1, 'r']]) {
    if (!S.ch[c].on) continue;
    const ch = S.ch[c];
    for (let i = 0; i <= DIV_Y; i++) {
      const y = R.y + R.h * i / DIV_Y, v = ch.range - i * 2 * ch.range / DIV_Y - ch.offset;
      label(si(+v.toPrecision(3), 'V', 3), side === 'l' ? R.x - 6 : R.x + R.w + 6, Math.min(Math.max(y, R.y + 6), R.y + R.h - 6), chColor(c), side === 'l' ? 'right' : 'left');
    }
    // zero marker
    const y0 = yOf(R, c, 0);
    if (y0 >= R.y && y0 <= R.y + R.h) {
      ctx.fillStyle = chColor(c); ctx.beginPath();
      if (side === 'l') { ctx.moveTo(R.x, y0); ctx.lineTo(R.x - 6, y0 - 5); ctx.lineTo(R.x - 6, y0 + 5); }
      else { ctx.moveTo(R.x + R.w, y0); ctx.lineTo(R.x + R.w + 6, y0 - 5); ctx.lineTo(R.x + R.w + 6, y0 + 5); }
      ctx.fill();
    }
  }
  for (let i = 0; i <= DIV_X; i++) {
    const t = vs.tL + vs.span * i / DIV_X;
    label(si(+t.toPrecision(4), 's', 3), R.x + R.w * i / DIV_X, R.y + R.h + 13, colors.axis, i === 0 ? 'left' : i === DIV_X ? 'right' : 'center');
  }
  // reference
  if (ref) for (const c of visibleChannels(ref)) drawTrace(R, ref, ref.data[c], c, vs, colors.ref, 1.3, [5, 3]);
  // persistence layer
  if (S.persist && persistLayer) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(persistLayer, 0, 0); ctx.restore(); }
  // traces
  if (wv) for (const c of visibleChannels(wv).reverse()) drawTrace(R, wv, wv.data[c], c, vs, chColor(c), S.persist ? 1 : 1.5);
  // trigger marker
  const showTrig = S.trig.mode !== 'none' && !(wv?.streaming);
  if (showTrig) {
    const x = xOf(R, 0, vs), y = yOf(R, S.trig.src, S.trig.level);
    ctx.save();
    ctx.strokeStyle = colors.trig; ctx.globalAlpha = 0.6; ctx.setLineDash([3, 3]);
    if (x >= R.x && x <= R.x + R.w) { ctx.beginPath(); ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h); ctx.stroke(); }
    ctx.restore();
    if (x >= R.x - 1 && x <= R.x + R.w + 1 && y >= R.y && y <= R.y + R.h) {
      ctx.fillStyle = colors.trig; ctx.strokeStyle = colors.plot; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  renderRulers(R, vs, wv);
  // badges
  const badges = [];
  if (!running && buffer.length) badges.push(['Stopped', colors.muted]);
  if (running && waiting) badges.push([S.trig.mode === 'single' ? 'Single: waiting for trigger…' : 'Waiting for trigger…', colors.trig]);
  if (wv && !wv.triggered && !wv.streaming && S.trig.mode !== 'none' && running && !waiting) badges.push(['Auto (no trigger)', colors.muted]);
  if (wv?.streaming && live && bufIdx < 0) badges.push(['Slow sampling', colors.muted]);
  if (zoom.z > 1) badges.push([`Zoom ×${+zoom.z.toPrecision(3)} (double-click to reset)`, colors.accent || colors.axis]);
  for (const c of [0, 1]) if (wv?.overRange?.[c] && S.ch[c].on) badges.push([`${'AB'[c]}: over range`, colors.stop]);
  let bx = R.x + R.w - 8;
  for (const [t, col] of badges) { ctx.font = '12px "Segoe UI", system-ui, sans-serif'; const tw = ctx.measureText(t).width; label(t, bx, R.y + 14, col, 'right', 'middle', colors.plot); bx -= tw + 18; }
  if (!wv && scope) label(running ? 'Acquiring…' : 'Press ▶ (Space) to start', R.x + R.w / 2, R.y + R.h / 2, colors.muted, 'center');
}

function sampleAt(wv, c, t) {
  const arr = wv?.data[c]; if (!arr) return NaN;
  const n = wv.n ?? arr.length, f = (t + wv.tTrig) / wv.dt, i = Math.floor(f);
  if (i < 0 || i + 1 >= n) return NaN;
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}
function renderRulers(R, vs, wv) {
  const lines = [];
  ctx.save(); ctx.lineWidth = 1; ctx.setLineDash([6, 4]); ctx.strokeStyle = colors.axis;
  if (S.rulers.t) {
    const [t1, t2] = S.rulers.t;
    S.rulers.t.forEach((t, k) => {
      const x = xOf(R, t, vs);
      if (x < R.x || x > R.x + R.w) return;
      ctx.beginPath(); ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h); ctx.stroke();
      label(k ? '2' : '1', x, R.y + R.h - 10, colors.plot, 'center', 'middle', colors.axis);
    });
    lines.push([`Time rulers   1: ${si(t1, 's')}   2: ${si(t2, 's')}   Δ ${si(t2 - t1, 's')}   1/Δ ${si(1 / Math.abs(t2 - t1), 'Hz')}`, colors.text]);
    for (const c of visibleChannels(wv)) {
      const a = sampleAt(wv, c, t1), b = sampleAt(wv, c, t2);
      lines.push([`${['A', 'B', 'Math'][c]}   1: ${si(a, 'V')}   2: ${si(b, 'V')}   Δ ${si(b - a, 'V')}`, chColor(c)]);
    }
  }
  if (S.rulers.v) {
    const c = rulerCh(), [v1, v2] = S.rulers.v;
    ctx.strokeStyle = chColor(c);
    S.rulers.v.forEach((v, k) => {
      const y = yOf(R, c, v); if (y < R.y || y > R.y + R.h) return;
      ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke();
      label(k ? '2' : '1', R.x + 10, y, colors.plot, 'center', 'middle', chColor(c));
    });
    lines.push([`Signal rulers (${'AB'[c]})   1: ${si(v1, 'V')}   2: ${si(v2, 'V')}   Δ ${si(v1 - v2, 'V')}`, chColor(c)]);
  }
  ctx.restore();
  if (lines.length) {
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    const wmax = Math.max(...lines.map(l => ctx.measureText(l[0]).width)) + 16;
    ctx.save(); ctx.globalAlpha = 0.93; ctx.fillStyle = colors.plot; ctx.strokeStyle = colors.border;
    ctx.fillRect(R.x + 8, R.y + 28, wmax, lines.length * 18 + 8); ctx.strokeRect(R.x + 8.5, R.y + 28.5, wmax, lines.length * 18 + 8); ctx.restore();
    lines.forEach(([t, col], i) => label(t, R.x + 16, R.y + 41 + i * 18, col));
  }
}

function renderSpectrum(R, wv) {
  grid(R);
  const chans = visibleChannels(wv);
  const maxR = Math.max(...[0, 1].filter(c => S.ch[c].on).map(c => S.ch[c].range), 0.05);
  const top = Math.ceil(20 * Math.log10(maxR) / 10) * 10, dbDiv = 10;
  for (let i = 0; i <= DIV_Y; i++) label(`${top - i * dbDiv} dBV`, R.x - 6, Math.min(Math.max(R.y + R.h * i / DIV_Y, R.y + 6), R.y + R.h - 6), colors.axis, 'right');
  if (!wv || !(wv.n ?? wv.data[0]?.length)) return;
  if (specCache.wave !== wv || specCache.n !== (wv.n ?? 0) || specCache.key !== S.math + chans) {
    const [a, b] = measRange(wv), len = b - a;
    let n = 1; while (n * 2 <= Math.min(len, 1 << 16)) n *= 2;
    specCache = { wave: wv, n: wv.n ?? 0, key: S.math + chans, fs: 1 / wv.dt, N: n, data: n >= 64 ? chans.map(c => [c, spectrum(wv.data[c], a, n)]) : [] };
  }
  const { fs, N, data } = specCache, fmax = fs / 2;
  for (let i = 0; i <= DIV_X; i++) label(si(fmax * i / DIV_X, 'Hz', 3), R.x + R.w * i / DIV_X, R.y + R.h + 13, colors.axis, i === 0 ? 'left' : i === DIV_X ? 'right' : 'center');
  ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
  const peaks = [];
  for (const [c, sp] of data) {
    ctx.strokeStyle = chColor(c); ctx.lineWidth = 1.2; ctx.beginPath();
    const bins = sp.length, perPx = bins / R.w;
    let pk = 3;
    for (let i = 3; i < bins; i++) if (sp[i] > sp[pk]) pk = i;
    peaks.push([c, pk * fs / N, sp[pk]]);
    const Y = db => R.y + (top - db) / (dbDiv * DIV_Y) * R.h;
    for (let px = 0; px < R.w; px++) {
      const a = Math.floor(px * perPx), b = Math.max(a + 1, Math.floor((px + 1) * perPx));
      let m = -999; for (let i = a; i < b && i < bins; i++) if (sp[i] > m) m = sp[i];
      px ? ctx.lineTo(R.x + px, Y(m)) : ctx.moveTo(R.x, Y(m));
    }
    ctx.stroke();
  }
  ctx.restore();
  peaks.forEach(([c, f, db], i) => label(`${['A', 'B', 'Math'][c]} peak  ${si(f, 'Hz')}  ${db.toFixed(1)} dBV`, R.x + 10, R.y + 14 + i * 18, chColor(c), 'left', 'middle', colors.plot));
  label(`${N} point FFT · Blackman-Harris · ${si(fs / N, 'Hz')} per bin`, R.x + R.w - 8, R.y + R.h - 12, colors.muted, 'right', 'middle', colors.plot);
}

function updateStatus() {
  const cfg = scope ? hwConfig() : null;
  if (cfg) {
    const eff = cfg.rate / cfg.decim, n = Math.round(cfg.W * eff);
    $('acqInfo').textContent = `${si(eff, 'S/s', 3)} · ${si(n, 'S', 3)} · ${cfg.nch} ch${cfg.streaming ? ' · streaming' : ` · ${wfRate} wfm/s`}`;
  } else $('acqInfo').textContent = '';
  const now = performance.now();
  $('warnInfo').textContent = gapWarn && now - gapWarn < 3000 ? 'USB too slow: samples lost, use fewer samples or one channel' : $('warnInfo').textContent.startsWith('USB too slow') ? '' : $('warnInfo').textContent;
  $('bufPos').textContent = buffer.length ? `${bufIdx < 0 ? buffer.length : bufIdx + 1} / ${buffer.length}` : '0 / 0';
}
setInterval(() => { dirty = true; }, 500);

// ---------------------------------------------------------------- mouse
let drag = null;
canvas.addEventListener('mousedown', e => {
  const L = layout(), R = L.scope; if (!R) return;
  const p = { x: e.offsetX, y: e.offsetY }, wv = currentWave() ?? live, vs = viewSpan(wv);
  const inX = p.x >= R.x && p.x <= R.x + R.w, inY = p.y >= R.y && p.y <= R.y + R.h;
  if (!inY) return;
  if (S.trig.mode !== 'none' && !wv?.streaming) {
    const tx = xOf(R, 0, vs), ty = yOf(R, S.trig.src, S.trig.level);
    if (Math.abs(p.x - tx) < 10 && Math.abs(p.y - ty) < 10) { drag = { kind: 'trig' }; return; }
  }
  if (S.rulers.t) for (const k of [0, 1]) if (Math.abs(p.x - xOf(R, S.rulers.t[k], vs)) < 6 && inX) { drag = { kind: 'rt', k }; return; }
  if (S.rulers.v) for (const k of [0, 1]) if (Math.abs(p.y - yOf(R, rulerCh(), S.rulers.v[k])) < 6 && inX) { drag = { kind: 'rv', k }; return; }
  if (p.x < R.x && S.ch[0].on) { drag = { kind: 'off', c: 0, y: p.y, o: S.ch[0].offset }; return; }
  if (p.x > R.x + R.w && S.ch[1].on) { drag = { kind: 'off', c: 1, y: p.y, o: S.ch[1].offset }; return; }
  if (inX && zoom.z > 1) drag = { kind: 'pan', x: p.x, c: zoom.c };
});
addEventListener('mousemove', e => {
  const R = layout().scope; if (!R) return;
  const rect = canvas.getBoundingClientRect(), p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const wv = currentWave() ?? live, vs = viewSpan(wv);
  if (!drag) {
    let cur = 'crosshair';
    if (S.trig.mode !== 'none' && Math.abs(p.x - xOf(R, 0, vs)) < 10 && Math.abs(p.y - yOf(R, S.trig.src, S.trig.level)) < 10) cur = 'move';
    else if (S.rulers.t && S.rulers.t.some(t => Math.abs(p.x - xOf(R, t, vs)) < 6)) cur = 'ew-resize';
    else if (S.rulers.v && S.rulers.v.some(v => Math.abs(p.y - yOf(R, rulerCh(), v)) < 6)) cur = 'ns-resize';
    else if (p.x < R.x || p.x > R.x + R.w) cur = 'ns-resize';
    else if (zoom.z > 1) cur = 'grab';
    if (e.target === canvas) canvas.style.cursor = cur;
    return;
  }
  const clampY = y => Math.max(R.y, Math.min(R.y + R.h, y));
  if (drag.kind === 'trig') {
    S.trig.level = +vOf(R, S.trig.src, clampY(p.y)).toPrecision(3);
    if (zoom.z === 1) S.trig.pre = Math.round(Math.max(0, Math.min(100, (p.x - R.x) / R.w * 100)));
    $('trigLevel').value = si(S.trig.level, 'V', 3); $('trigPre').value = S.trig.pre;
  } else if (drag.kind === 'rt') S.rulers.t[drag.k] = tOf(R, Math.max(R.x, Math.min(R.x + R.w, p.x)), vs);
  else if (drag.kind === 'rv') S.rulers.v[drag.k] = vOf(R, rulerCh(), clampY(p.y));
  else if (drag.kind === 'off') {
    const ch = S.ch[drag.c], step = ch.range / DIV_Y;
    ch.offset = Math.round((drag.o + (drag.y - p.y) / (R.h / 2) * ch.range) / step * 2) * step / 2;
  } else if (drag.kind === 'pan') zoom.c = drag.c - (p.x - drag.x) / R.w * vs.span;
  dirty = true;
});
addEventListener('mouseup', () => { if (drag) { if (drag.kind === 'off' || drag.kind === 'trig') { resetStats(); persistLayer = null; } drag = null; save(); dirty = true; } });
canvas.addEventListener('wheel', e => {
  const R = layout().scope; if (!R || e.offsetX < R.x || e.offsetX > R.x + R.w) return;
  e.preventDefault();
  const wv = currentWave() ?? live, vs = viewSpan(wv);
  const tm = tOf(R, e.offsetX, vs);
  const nz = Math.max(1, Math.min(1000, zoom.z * (e.deltaY < 0 ? 1.25 : 0.8)));
  // keep the time under the mouse fixed
  const frac = (e.offsetX - R.x) / R.w, span = vs.W / nz;
  zoom = { z: nz, c: tm - frac * span + span / 2 - vs.base };
  persistLayer = null; measDirtyFromZoom(); dirty = true;
}, { passive: false });
canvas.addEventListener('dblclick', () => { zoom = { z: 1, c: 0 }; persistLayer = null; measDirtyFromZoom(); dirty = true; });
function measDirtyFromZoom() { const w = currentWave(); if (w) { w.meas = [0, 1, 2].map(c => w.data[c] ? measureAll(w.data[c], ...measRange(w), w.dt) : null); measDirty = true; } }

// ---------------------------------------------------------------- save / open
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
function csvOf(waves, withIndex) {
  const hasB = waves.some(w => w.data[1]), hasM = waves.some(w => w.data[2]);
  const head = [withIndex ? 'Waveform' : null, 'Time (s)', 'Channel A (V)', hasB ? 'Channel B (V)' : null, hasM ? 'Math' : null].filter(Boolean).join(',');
  const parts = [head + '\n'];
  waves.forEach((w, k) => {
    const n = w.n ?? w.data[0].length; let s = '';
    for (let i = 0; i < n; i++) {
      s += (withIndex ? (k + 1) + ',' : '') + (i * w.dt - w.tTrig).toPrecision(9) + ',' + w.data[0][i].toPrecision(5) + (hasB ? ',' + (w.data[1] ? w.data[1][i].toPrecision(5) : '') : '') + (hasM ? ',' + (w.data[2] ? w.data[2][i].toPrecision(5) : '') : '') + '\n';
      if (s.length > 1 << 20) { parts.push(s); s = ''; }
    }
    parts.push(s);
  });
  return new Blob(parts, { type: 'text/csv' });
}
$('saveCsv').onclick = () => { const w = currentWave(); if (w) download(`scope-${stamp()}.csv`, csvOf([w], false)); };
$('saveAllCsv').onclick = () => { if (buffer.length) download(`scope-buffer-${stamp()}.csv`, csvOf(buffer, true)); };
$('savePng').onclick = () => canvas.toBlob(b => download(`scope-${stamp()}.png`, b));
$('openCsv').onclick = () => $('fileIn').click();
$('fileIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = '';
  try { loadCsv(await f.text()); } catch (err) { showError(err); }
};
// Reads CSVs saved by this app and PicoScope CSV exports (header row, optional units row like "(ms),(V),(V)").
function loadCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(/[,;\t]/).map(s => s.trim().replace(/^"|"$/g, ''));
  let row = 1, units = head.map(h => (h.match(/\(([^)]*)\)/) || [])[1] || '');
  if (/^\s*\(/.test(lines[1])) { units = lines[1].split(/[,;\t]/).map(s => s.trim().replace(/[()"]/g, '')); row = 2; }
  const mul = u => ({ s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9, v: 1, mv: 1e-3, uv: 1e-6, 'µv': 1e-6, kv: 1e3 })[u.toLowerCase()] ?? 1;
  const idxW = head.findIndex(h => /^waveform/i.test(h));
  const idxT = head.findIndex(h => /time/i.test(h));
  const chIdx = [/(channel )?a\b/i, /(channel )?b\b/i, /math/i].map(re => head.findIndex((h, i) => i !== idxT && i !== idxW && re.test(h)));
  if (idxT < 0 || chIdx[0] < 0) throw new Error('CSV not recognised: need a Time column and a Channel A column');
  const groups = new Map();
  for (; row < lines.length; row++) {
    const f = lines[row].split(/[,;\t]/);
    const g = idxW >= 0 ? f[idxW] : '1';
    if (!groups.has(g)) groups.set(g, { t: [], v: [[], [], []] });
    const G = groups.get(g), t = parseFloat(f[idxT]);
    if (!isFinite(t)) continue;
    G.t.push(t * mul(units[idxT] || 's'));
    chIdx.forEach((ix, c) => { if (ix >= 0) { const v = parseFloat(f[ix]); G.v[c].push(isFinite(v) ? v * mul(units[ix] || 'V') : NaN); } });
  }
  stop();
  const waves = [...groups.values()].filter(G => G.t.length > 1).map(G => {
    const dt = (G.t[G.t.length - 1] - G.t[0]) / (G.t.length - 1);
    return { dt, tTrig: -G.t[0], data: G.v.map((a, c) => a.length ? Float32Array.from(a) : null), triggered: true, streaming: false, rate: 1 / dt, time: Date.now(), overRange: [false, false] };
  });
  if (!waves.length) throw new Error('No data in CSV');
  const w0 = waves[0], dur = (w0.data[0].length - 1) * w0.dt;
  S.tb = TIMEBASES.findIndex(t => t * DIV_X >= dur * 0.999); if (S.tb < 0) S.tb = TIMEBASES.length - 1;
  S.trig.pre = Math.round(Math.max(0, Math.min(100, w0.tTrig / windowLen() * 100)));
  for (const c of [0, 1]) {
    const arr = w0.data[c]; S.ch[c].on = !!arr;
    if (arr) { let pk = 0; for (const v of arr) if (Math.abs(v) > pk) pk = Math.abs(v); S.ch[c].range = rangesFor(S.ch[c].probe).find(r => r >= pk * 1.05) ?? rangesFor(S.ch[c].probe).at(-1); }
  }
  buffer = []; zoom = { z: 1, c: 0 }; resetStats();
  for (const w of waves) { buffer.push(w); updateStats(w); }
  bufIdx = buffer.length - 1;
  hideOverlay(); changed();
}

// ---------------------------------------------------------------- go
refreshControls();
requestAnimationFrame(frame);
autoConnect();
window.__app = { get S() { return S; }, startDemo, loadCsv, get buffer() { return buffer; } };
