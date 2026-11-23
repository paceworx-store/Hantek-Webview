// Hantek DSO-6022BE / 6022BL driver over WebUSB.
// Protocol is that of the open-source firmware by Ho-Ro (https://github.com/Ho-Ro/Hantek6022API, GPLv3),
// the same firmware OpenHantek6022 uses. Works with navigator.usb in Chrome/Edge, or the `usb` npm package's WebUSB shim.

import { FIRMWARE_6022BE, FIRMWARE_6022BL } from './firmware.js';

export const FW_VERSION = 0x0210;
const VID_EMPTY = 0x04b4;   // device without firmware
const VID_LOADED = 0x04b5;  // device running our firmware
const PID_BE = 0x6022, PID_BL = 0x602a;

export const USB_FILTERS = [
  { vendorId: VID_EMPTY, productId: PID_BE }, { vendorId: VID_LOADED, productId: PID_BE },
  { vendorId: VID_EMPTY, productId: PID_BL }, { vendorId: VID_LOADED, productId: PID_BL },
];

const REQ = { FIRMWARE: 0xa0, EEPROM: 0xa2, CH1_GAIN: 0xe0, CH2_GAIN: 0xe1, RATE: 0xe2,
              START: 0xe3, NUMCH: 0xe4, ACDC: 0xe5, CALFREQ: 0xe6 };
const EP_IN = 6;             // bulk IN endpoint 0x86
const CHUNK = 64 * 1024;     // bytes per bulk transfer
const IN_FLIGHT = 6;         // overlapping transfers to keep up with the FIFO

// Sample rate codes understood by the firmware -> samples/second per channel.
export const SAMPLE_RATES = [
  [102, 20e3], [104, 40e3], [105, 50e3], [110, 100e3], [120, 200e3], [140, 400e3], [150, 500e3],
  [1, 1e6], [2, 2e6], [4, 4e6], [5, 5e6], [8, 8e6], [10, 10e6], [12, 12e6], [15, 15e6],
  [16, 16e6], [24, 24e6], [30, 30e6], [48, 48e6],
];

// Hardware gain steps. 128 ADC counts = 5.12/gain volts (x1 probe): nominal ranges ±5, ±2.5, ±1, ±0.5 V.
export const GAINS = [1, 2, 5, 10];
export const gainFullScale = g => 5.12 / g;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const bcd = d => (d.deviceVersionMajor << 8) | (d.deviceVersionMinor << 4) | d.deviceVersionSubminor;

function parseHex(text) {
  const recs = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const len = parseInt(line.slice(1, 3), 16), addr = parseInt(line.slice(3, 7), 16), type = parseInt(line.slice(7, 9), 16);
    if (type === 1) break;
    if (type !== 0) throw new Error('Unsupported hex record type ' + type);
    const data = new Uint8Array(len);
    let sum = len + (addr >> 8) + (addr & 255) + type;
    for (let i = 0; i < len; i++) { data[i] = parseInt(line.substr(9 + 2 * i, 2), 16); sum += data[i]; }
    if (((sum + parseInt(line.substr(9 + 2 * len, 2), 16)) & 255) !== 0) throw new Error('Firmware checksum error');
    recs.push({ addr, data });
  }
  return recs;
}

export class Hantek6022 {
  constructor(usb) {
    this.usb = usb;
    this.dev = null;
    this.numChannels = 2;
    this.gain = [1, 1];
    this.acdc = 0x11;
    this.rateCode = 1;
    // Calibration: per channel, per gain -> { offset (ADC counts), gain (factor) }
    this.cal = [0, 1].map(() => Object.fromEntries(GAINS.map(g => [g, { offset: 0, gain: g <= 2 ? 1.01 : g === 5 ? 0.99 : 1.0 }])));
    this.busy = Promise.resolve();
  }

  get connected() { return !!this.dev && this.dev.opened; }
  get serial() { return this.dev?.serialNumber || ''; }
  get model() { return this.dev?.productId === PID_BL ? 'DSO-6022BL' : 'DSO-6022BE'; }

  static isOurs(d) { return USB_FILTERS.some(f => f.vendorId === d.vendorId && f.productId === d.productId); }
  static isReady(d) { return d.vendorId === VID_LOADED && bcd(d) === FW_VERSION; }

  // Open a device; uploads firmware first if needed. `onStatus` gets progress text.
  // Returns 'ready', or 'reconnect' when firmware was uploaded and the device re-enumerates
  // (the caller should then wait for the new device and call open() again).
  async open(device, onStatus = () => {}) {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);
    if (!Hantek6022.isReady(device)) {
      onStatus('Uploading firmware…');
      const fw = device.productId === PID_BL ? FIRMWARE_6022BL : FIRMWARE_6022BE;
      await this._ctrlOut(device, REQ.FIRMWARE, 0xe600, [1]); // hold CPU in reset
      for (const r of parseHex(fw)) await this._ctrlOut(device, REQ.FIRMWARE, r.addr, r.data);
      await this._ctrlOut(device, REQ.FIRMWARE, 0xe600, [0]); // run
      try { await device.close(); } catch { /* device is already gone */ }
      return 'reconnect';
    }
    this.dev = device;
    try { await device.selectAlternateInterface(0, 0); } catch { /* bulk is the default */ }
    await this.readCalibration().catch(() => {});
    await this.setChannels(2);
    await this.setGain(0, 1); await this.setGain(1, 1);
    await this.setCoupling(0, true); await this.setCoupling(1, true);
    await this.setCalFrequency(1000);
    return 'ready';
  }

  async close() {
    const d = this.dev; this.dev = null;
    if (d?.opened) { try { await this._ctrlOut(d, REQ.START, 0, [0]); await d.close(); } catch { } }
  }

  async _ctrlOut(dev, request, value, data) {
    const r = await dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index: 0 },
                                           data instanceof Uint8Array ? data : new Uint8Array(data));
    if (r.status !== 'ok') throw new Error(`USB request 0x${request.toString(16)} failed: ${r.status}`);
  }
  async _ctrlIn(request, value, length) {
    const r = await this.dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request, value, index: 0 }, length);
    if (r.status !== 'ok') throw new Error(`USB request 0x${request.toString(16)} failed: ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }
  // Serialise all device access so UI changes don't interleave with a capture.
  _locked(fn) { const p = this.busy.then(fn, fn); this.busy = p.catch(() => {}); return p; }
  _cmd(req, byte) { return this._locked(() => this._ctrlOut(this.dev, req, 0, [byte])); }

  async readCalibration() {
    const c = await this._locked(() => this._ctrlIn(REQ.EEPROM, 0x08, 80));
    const ok = v => v !== 0 && v !== 255;
    const base = { 10: [0, 1], 5: [6, 7], 2: [8, 9], 1: [14, 15] };
    for (const g of GAINS) for (const ch of [0, 1]) {
      const e = this.cal[ch][g];
      const i = base[g][ch];
      if (ok(c[i])) e.offset = c[i] - 128;
      if (ok(c[i + 48])) e.offset += (c[i + 48] - 128) / 250;   // fine offset
      if (ok(c[i + 32])) e.gain *= 1 + (c[i + 32] - 128) / 500; // gain trim
    }
  }

  setSampleRate(code) { this.rateCode = code; return this._cmd(REQ.RATE, code); }
  setChannels(n) { this.numChannels = n; return this._cmd(REQ.NUMCH, n); }
  setGain(ch, g) { this.gain[ch] = g; return this._cmd(ch ? REQ.CH2_GAIN : REQ.CH1_GAIN, g); }
  setCoupling(ch, dc) {
    const sh = ch ? 4 : 0;
    this.acdc = (this.acdc & ~(0xf << sh)) | ((dc ? 1 : 0) << sh);
    return this._cmd(REQ.ACDC, this.acdc);   // only has an effect on scopes with the AC/DC mod or a 6022BL
  }
  setCalFrequency(hz) {
    let b;
    if (hz < 1000) b = Math.floor((hz + 5) / 10) + 100;
    else if (hz < 5750) b = Math.min(Math.floor((hz + 50) / 100) + 200, 255);
    else b = Math.floor((hz + 500) / 1000);
    return this._cmd(REQ.CALFREQ, b);
  }

  // Volts per ADC count for a channel at its current gain (x1 probe).
  voltsPerCount(ch) { const g = this.gain[ch]; return 5.12 * this.cal[ch][g].gain / (g * 128); }
  zeroCount(ch) { return 128 + this.cal[ch][this.gain[ch]].offset; }

  // Capture `samples` samples per channel in one contiguous block.
  // Returns { raw: Uint8Array (interleaved if 2 ch), channels, dropped } .
  capture(samples, discard = 1024) {
    return this._locked(async () => {
      const nch = this.numChannels;
      const want = (samples + discard) * nch;
      const total = Math.ceil(want / 512) * 512;
      const buf = new Uint8Array(total);
      await this._ctrlOut(this.dev, REQ.START, 0, [1]);
      let filled = 0;
      try {
        let next = 0;
        const queue = [];
        const submit = () => {
          if (next >= total) return;
          const off = next, len = Math.min(CHUNK, total - off);
          next += len;
          queue.push(this.dev.transferIn(EP_IN, len).then(r => ({ r, off })));
        };
        for (let i = 0; i < IN_FLIGHT; i++) submit();
        while (queue.length) {
          const { r, off } = await queue.shift();
          if (r.status !== 'ok') throw new Error('Bulk read failed: ' + r.status);
          const d = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
          buf.set(d, off);   // transfers complete in order on one endpoint
          filled += d.length;
          submit();
        }
      } finally {
        await this._ctrlOut(this.dev, REQ.START, 0, [0]).catch(() => {});
      }
      return { raw: buf.subarray(discard * nch, discard * nch + samples * nch), channels: nch };
    });
  }

  // Continuous streaming for roll mode: calls onData(Uint8Array) until the returned stop() is called.
  stream(onData, chunk = 16 * 1024) {
    let running = true;
    const done = this._locked(async () => {
      await this._ctrlOut(this.dev, REQ.START, 0, [1]);
      try {
        const queue = [];
        const submit = () => queue.push(this.dev.transferIn(EP_IN, chunk));
        for (let i = 0; i < 4; i++) submit();
        while (running && queue.length) {
          const r = await queue.shift();
          if (r.status !== 'ok') throw new Error('Bulk read failed: ' + r.status);
          if (running) onData(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
          if (running) submit();
        }
        // let already-queued transfers drain
        await Promise.allSettled(queue);
      } finally {
        await this._ctrlOut(this.dev, REQ.START, 0, [0]).catch(() => {});
      }
    });
    return { stop: () => { running = false; return done; }, done };
  }
}
