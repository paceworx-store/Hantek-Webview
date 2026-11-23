// Signal processing: triggering, measurements, FFT.

// ---- Trigger ---------------------------------------------------------------
// Returns fractional sample index of the trigger point, or -1.
// cfg: { type: 'rising'|'falling'|'pulse_gt'|'pulse_lt', level, hyst, width (s), dt }
// Search is limited to [from, to).
export function findTrigger(v, cfg, from, to) {
  const { level, hyst } = cfg;
  from = Math.max(1, from | 0); to = Math.min(v.length, to | 0);
  const lo = level - hyst, hi = level + hyst;
  if (cfg.type === 'rising' || cfg.type === 'falling') {
    const rising = cfg.type === 'rising';
    // arm state from history before `from`
    let armed = false;
    for (let i = Math.max(0, from - 2000); i < from; i++) {
      if (rising ? v[i] < lo : v[i] > hi) armed = true;
      else if (rising ? v[i] >= level : v[i] <= level) armed = false;
    }
    for (let i = from; i < to; i++) {
      const x = v[i];
      if (rising) {
        if (x < lo) armed = true;
        else if (armed && x >= level) return i - 1 + frac(v[i - 1], x, level);
      } else {
        if (x > hi) armed = true;
        else if (armed && x <= level) return i - 1 + frac(v[i - 1], x, level);
      }
    }
    return -1;
  }
  // Pulse width (positive pulse): rising edge then falling edge; trigger on the falling edge.
  const minW = cfg.width / cfg.dt;
  let state = v[0] > level ? 1 : 0, start = -1;
  for (let i = 1; i < to; i++) {
    const x = v[i];
    if (state === 0 && x >= hi) { state = 1; start = i; }
    else if (state === 1 && x <= lo) {
      state = 0;
      if (start >= 0 && i >= from) {
        const w = i - start;
        if (cfg.type === 'pulse_gt' ? w > minW : w < minW) return i - 1 + frac(v[i - 1], x, level);
      }
    }
  }
  return -1;
}
const frac = (a, b, l) => (b === a ? 0 : Math.min(1, Math.max(0, (l - a) / (b - a))));

// ---- Measurements ------------------------------------------------------------
export const MEASUREMENTS = {
  freq: { label: 'Frequency', unit: 'Hz' },
  period: { label: 'Period', unit: 's' },
  duty: { label: 'Duty cycle (+)', unit: '%' },
  pwhi: { label: 'High pulse width', unit: 's' },
  pwlo: { label: 'Low pulse width', unit: 's' },
  dc: { label: 'DC average', unit: 'V' },
  rms: { label: 'True RMS', unit: 'V' },
  acrms: { label: 'AC RMS', unit: 'V' },
  max: { label: 'Maximum', unit: 'V' },
  min: { label: 'Minimum', unit: 'V' },
  pp: { label: 'Peak to peak', unit: 'V' },
  rise: { label: 'Rise time (10-90%)', unit: 's' },
  fall: { label: 'Fall time (90-10%)', unit: 's' },
  edges: { label: 'Edge count (rising)', unit: '' },
};

// Compute all measurements for v[a..b) with sample period dt. Results may be NaN.
export function measureAll(v, a, b, dt) {
  const n = b - a;
  const r = Object.fromEntries(Object.keys(MEASUREMENTS).map(k => [k, NaN]));
  if (n < 2) return r;
  let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0;
  for (let i = a; i < b; i++) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x; sum += x; sum2 += x * x; }
  const mean = sum / n;
  r.max = mx; r.min = mn; r.pp = mx - mn; r.dc = mean;
  r.rms = Math.sqrt(sum2 / n);
  r.acrms = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const pp = mx - mn;
  if (pp <= 0) return r;
  const mid = (mx + mn) / 2, h = pp * 0.1;
  // edge detection with hysteresis
  const rises = [], falls = [];
  let st = v[a] > mid ? 1 : 0;
  for (let i = a + 1; i < b; i++) {
    const x = v[i];
    if (st === 0 && x > mid + h) { st = 1; rises.push(back(v, i, mid, -1, a)); }
    else if (st === 1 && x < mid - h) { st = 0; falls.push(back(v, i, mid, +1, a)); }
  }
  r.edges = rises.length;
  if (rises.length >= 2) {
    const per = (rises[rises.length - 1] - rises[0]) / (rises.length - 1) * dt;
    r.period = per; r.freq = 1 / per;
    // high/low widths
    let hi = 0, hn = 0, lo = 0, ln = 0;
    for (const s of rises) { const f = falls.find(x => x > s); if (f !== undefined) { const nr = rises.find(x => x > f); if (nr !== undefined) { hi += f - s; hn++; lo += nr - f; ln++; } } }
    if (hn) { r.pwhi = hi / hn * dt; r.duty = 100 * (hi / hn) / ((hi / hn) + (lo / ln)); }
    if (ln) r.pwlo = lo / ln * dt;
  }
  // rise/fall time 10-90 on first full edge
  const l10 = mn + pp * 0.1, l90 = mn + pp * 0.9;
  r.rise = edgeTime(v, a, b, l10, l90, true) * dt;
  r.fall = edgeTime(v, a, b, l10, l90, false) * dt;
  return r;
}
// walk back from i to find the fractional crossing of `level`
function back(v, i, level, dir, a) {
  let j = i;
  while (j > a && (dir < 0 ? v[j - 1] >= level : v[j - 1] <= level)) j--;
  if (j <= a) return i;
  return j - 1 + frac(v[j - 1], v[j], level);
}
function edgeTime(v, a, b, l10, l90, rising) {
  // average over all edges found
  let tot = 0, cnt = 0, start = -1;
  let st = 0; // 0 = waiting for outside, 1 = left start band
  for (let i = a + 1; i < b; i++) {
    const x = v[i];
    if (rising) {
      if (x <= l10) { st = 1; start = -1; }
      else if (st === 1 && start < 0 && x > l10) start = i - 1 + frac(v[i - 1], x, l10);
      if (st === 1 && start >= 0 && x >= l90) { tot += i - 1 + frac(v[i - 1], x, l90) - start; cnt++; st = 0; start = -1; }
    } else {
      if (x >= l90) { st = 1; start = -1; }
      else if (st === 1 && start < 0 && x < l90) start = i - 1 + frac(v[i - 1], x, l90);
      if (st === 1 && start >= 0 && x <= l10) { tot += i - 1 + frac(v[i - 1], x, l10) - start; cnt++; st = 0; start = -1; }
    }
  }
  return cnt ? tot / cnt : NaN;
}

// ---- FFT -------------------------------------------------------------------
const fftCache = new Map();
function plan(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  // Blackman-Harris window
  const w = new Float64Array(n); let ws = 0;
  for (let i = 0; i < n; i++) { const x = 2 * Math.PI * i / (n - 1); w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x); ws += w[i]; }
  const p = { rev, cos, sin, w, ws }; fftCache.set(n, p); return p;
}
// Returns dBV (RMS) magnitude spectrum of v[a..a+n), n = power of 2. length n/2.
export function spectrum(v, a, n) {
  const { rev, cos, sin, w, ws } = plan(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[rev[i]] = (v[a + i]) * w[i];
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
      const c = cos[k * step], si = sin[k * step], i = s + k, j = i + half;
      const tr = re[j] * c - im[j] * si, ti = re[j] * si + im[j] * c;
      re[j] = re[i] - tr; im[j] = im[i] - ti; re[i] += tr; im[i] += ti;
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    const mag = Math.hypot(re[i], im[i]) / ws * (i === 0 ? 1 : 2) / (i === 0 ? 1 : Math.SQRT2);
    out[i] = 20 * Math.log10(mag + 1e-12);
  }
  return out;
}

// ---- Formatting ------------------------------------------------------------
const PREFIX = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
export function si(x, unit = '', digits = 4) {
  if (x === undefined || x === null || !isFinite(x)) return '—';
  if (Math.abs(x) < 1e-10) return '0 ' + unit;
  const ax = Math.abs(x);
  for (const [m, p] of PREFIX) if (ax >= m * 0.9995) return `${+(x / m).toPrecision(digits)} ${p}${unit}`;
  return `${+(x / 1e-12).toPrecision(digits)} p${unit}`;
}
