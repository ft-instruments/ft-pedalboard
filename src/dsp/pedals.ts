// More pedals: an envelope filter and a pitch shifter. Both mono (one instance per channel).
//
// EnvFilter: the auto-wah family (Mutron III, Q-Tron): a rectifying envelope follower on the input sweeps the
// cutoff of a resonant state-variable filter (Zavalishin's TPT form, so the sweep stays stable and the Q holds
// at any cutoff). The input is in volts like everything else: `sens` is how many volts it takes to open the
// filter fully, on a log scale, so it responds the same way to a real guitar as to the demo.
//
// PitchShift: two crossfading read taps on a delay line whose delay slides at (1 - ratio) samples per sample
// (the granular / "rotating head" shifter). The windows are sin^2, which sum to 1, so a steady note keeps its
// level. The wet path carries about half the window (30 ms) of delay, as every granular shifter does; the
// dry path in `mix` does not.

import { readDelayCubic, dbToGain } from './util.ts';


export class EnvFilter {
  private readonly fs: number;
  private env = 0;
  private ic1 = 0; private ic2 = 0;
  private g = 0.05; private k = 0.5;
  private a1 = 0; private a2 = 0; private a3 = 0;
  /** The sweep position 0..1, for the picture. */
  pos = 0;
  constructor(sampleRate: number) { this.fs = sampleRate; this.coef(); }
  reset(): void { this.env = 0; this.ic1 = 0; this.ic2 = 0; this.pos = 0; }
  private coef(): void {
    const { g, k } = this;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /**
   * In place. sens 0..1, freq (the closed cutoff, Hz), range (octaves the envelope sweeps it),
   * reson 0..1, decay (s), type 0 low / 1 band / 2 high, dir 0 up / 1 down, level (dB).
   */
  process(x: Float32Array, n: number, sens: number, freq: number, range: number, reson: number, decay: number, type: number, dir: number, level: number): void {
    const fs = this.fs;
    const atk = 1 - Math.exp(-1 / (0.004 * fs)), rel = 1 - Math.exp(-1 / (Math.max(0.005, decay) * fs));
    const sg = 3 * Math.pow(60, sens);                       // 3 .. 180 per volt: an open filter takes 0.3 V .. 5 mV
    const Q = 1 + reson * reson * 16, kk = 1 / Q;
    const t = Math.round(type), down = Math.round(dir) === 1;
    const top = Math.min(0.45 * fs, freq * Math.pow(2, range));
    const ratio = top / freq;
    const out = dbToGain(level) * (t === 1 ? 1 : 1 / Math.sqrt(Q));
    let env = this.env, ic1 = this.ic1, ic2 = this.ic2;
    for (let i = 0; i < n; i += 8) {
      const m = Math.min(8, n - i);
      // the envelope follows block-wise at 8 samples: fast enough for a 4 ms attack
      for (let j = 0; j < m; j++) {
        const a = Math.abs(x[i + j]);
        env += (a - env) * (a > env ? atk : rel);
      }
      const v = env * sg, e = v / (1 + v);                    // 0..1, soft at the top
      this.pos = e;
      const f = freq * Math.pow(ratio, down ? 1 - e : e);
      this.g = Math.tan(Math.PI * Math.min(f, 0.45 * fs) / fs);
      this.k = kk;
      this.coef();
      const a1 = this.a1, a2 = this.a2, a3 = this.a3;
      for (let j = 0; j < m; j++) {
        const s = x[i + j];
        const v3 = s - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
        const y = t === 0 ? v2 : t === 1 ? kk * v1 : s - kk * v1 - v2;
        x[i + j] = y * out;
      }
    }
    if (!Number.isFinite(ic1) || !Number.isFinite(ic2)) { ic1 = 0; ic2 = 0; env = 0; }
    this.env = env; this.ic1 = ic1; this.ic2 = ic2;
  }
}

export class PitchShift {
  private buf: Float32Array;
  private idx = 0;
  private phase = 0;
  private readonly wd: number;
  /** The last ratio, for the picture. */
  ratio = 1;
  constructor(sampleRate: number) {
    const w = Math.round(sampleRate * 0.06);
    this.wd = w - 8;
    this.buf = new Float32Array(w + 8);
  }
  reset(): void { this.buf.fill(0); this.idx = 0; this.phase = 0; }
  /** In place. shift in semitones, fine in cents, mix 0..1, level dB. */
  process(x: Float32Array, n: number, shift: number, fine: number, mix: number, level: number): void {
    const st = Math.round(shift) + fine / 100;
    const r = Math.pow(2, st / 12);
    this.ratio = r;
    const buf = this.buf, len = buf.length, wd = this.wd;
    const step = (1 - r) / wd, out = dbToGain(level);
    const bypass = Math.abs(st) < 1e-3;
    let idx = this.idx, p = this.phase;
    for (let i = 0; i < n; i++) {
      const s = x[i];
      buf[idx] = s;
      let wet = s;
      if (!bypass) {
        let p2 = p + 0.5; if (p2 >= 1) p2 -= 1;
        const w1 = Math.sin(Math.PI * p), w2 = Math.sin(Math.PI * p2);
        wet = readDelayCubic(buf, idx, 4 + wd * p) * w1 * w1 + readDelayCubic(buf, idx, 4 + wd * p2) * w2 * w2;
        p += step;
        if (p >= 1) p -= 1; else if (p < 0) p += 1;
      }
      if (++idx >= len) idx = 0;
      x[i] = (s + (wet - s) * mix) * out;
    }
    this.idx = idx; this.phase = p;
  }
}
