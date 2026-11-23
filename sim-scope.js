// Simulated 6022BE for demo mode: same interface as Hantek6022.
import { GAINS, SAMPLE_RATES } from './scope-driver.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class SimScope {
  constructor() {
    this.numChannels = 2; this.gain = [1, 1]; this.rateCode = 1; this.calHz = 1000; this.acdc = 0x11;
    this.cal = [0, 1].map(() => Object.fromEntries(GAINS.map(g => [g, { offset: 0, gain: 1 }])));
    this.dev = { opened: true };
    this.t = 0;
  }
  get connected() { return true; }
  get serial() { return 'DEMO'; }
  get model() { return 'Demo scope'; }
  async open() { return 'ready'; }
  async close() {}
  async readCalibration() {}
  async setSampleRate(c) { this.rateCode = c; }
  async setChannels(n) { this.numChannels = n; }
  async setGain(ch, g) { this.gain[ch] = g; }
  async setCoupling() {}
  async setCalFrequency(hz) { this.calHz = hz; }
  voltsPerCount(ch) { return 5.12 / (this.gain[ch] * 128); }
  zeroCount() { return 128; }
  get rate() { return SAMPLE_RATES.find(r => r[0] === this.rateCode)[1]; }

  // CH1: calibration square wave 0..2 V. CH2: a 'sensor-like' waveform (sine + harmonic + noise + occasional glitch).
  _fill(buf, n, t0) {
    const nch = this.numChannels, dt = 1 / this.rate;
    const q = [0, 1].map(c => this.voltsPerCount(c));
    for (let i = 0; i < n; i++) {
      const t = t0 + i * dt;
      const ph = (t * this.calHz) % 1;
      // finite edge rate (~20 MHz bandwidth) + ringing
      const e = Math.min(ph, Math.abs(ph - 0.5)) / this.calHz;
      let a = ph < 0.5 ? 2 : 0;
      if (e < 2e-7) a = (ph < 0.5 ? 2 : 0) + (ph < 0.5 ? -1 : 1) * 2 * Math.exp(-e / 3e-8) * 0.5;
      a += (Math.random() - 0.5) * 0.03;
      buf[i * nch] = clamp(128 + a / q[0]);
      if (nch === 2) {
        const w = 2 * Math.PI * 120 * t;
        let b = 1.2 * Math.sin(w) + 0.3 * Math.sin(3 * w + 0.4) + (Math.random() - 0.5) * 0.06;
        if ((t * 7) % 1 < 0.0006) b += 1.5;
        buf[i * nch + 1] = clamp(128 + b / q[1]);
      }
    }
  }
  async capture(samples) {
    const n = samples, buf = new Uint8Array(n * this.numChannels);
    this.t += 0.0137 + Math.random() * 0.05;
    this._fill(buf, n, this.t);
    await sleep(Math.max(4, n / this.rate * 1000));
    return { raw: buf, channels: this.numChannels };
  }
  stream(onData, chunk = 16 * 1024) {
    let running = true;
    const done = (async () => {
      let t = this.t;
      while (running) {
        const n = Math.floor(chunk / this.numChannels), buf = new Uint8Array(n * this.numChannels);
        this._fill(buf, n, t); t += n / this.rate;
        await sleep(n / this.rate * 1000);
        if (running) onData(buf);
      }
    })();
    return { stop: () => { running = false; return done; }, done };
  }
}
const clamp = x => Math.max(0, Math.min(255, Math.round(x)));
