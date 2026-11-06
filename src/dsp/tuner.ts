// Tuner: the YIN pitch detector (de Cheveigné and Kawahara, 2002) on the
// input, decimated by 4 to 12 kHz. A 640-sample window and lags down to
// 38 Hz cover drop tunings and a bass's low E. Runs every 1024 input
// samples; no allocation.

const DEC = 4;
const W = 640;                 // window, decimated samples
const HOP = 256;               // analyse every HOP decimated samples
const THRESH = 0.12;

export class Tuner {
  private buf: Float32Array;
  private idx = 0;
  private count = 0;
  private dec = 0;
  private z1 = 0; private z2 = 0; private z3 = 0;
  private d: Float32Array;
  private raw: Float32Array;
  private win: Float32Array;
  private readonly fsDec: number;
  private readonly maxLag: number;
  private readonly lpA: number;
  /** Last detected pitch in Hz, 0 when there is no clear note. */
  freq = 0;
  /** 0..1, how periodic the last window was. */
  clarity = 0;

  constructor(sampleRate: number) {
    this.fsDec = sampleRate / DEC;
    this.maxLag = Math.floor(this.fsDec / 38);
    this.buf = new Float32Array(W + this.maxLag);
    this.win = new Float32Array(W + this.maxLag);
    this.d = new Float32Array(this.maxLag + 1);
    this.raw = new Float32Array(this.maxLag + 1);
    this.lpA = 1 - Math.exp(-2 * Math.PI * 1400 / sampleRate);
  }

  push(x: Float32Array, n: number): void {
    const a = this.lpA, len = this.buf.length;
    for (let i = 0; i < n; i++) {
      // three one-poles before throwing away 3 of every 4 samples
      this.z1 += (x[i] - this.z1) * a; this.z2 += (this.z1 - this.z2) * a; this.z3 += (this.z2 - this.z3) * a;
      if (++this.dec < DEC) continue;
      this.dec = 0;
      this.buf[this.idx] = this.z3;
      if (++this.idx >= len) this.idx = 0;
      if (++this.count >= HOP) { this.count = 0; this.analyse(); }
    }
  }

  private analyse(): void {
    const len = this.buf.length, win = this.win, d = this.d, raw = this.raw, maxLag = this.maxLag;
    let energy = 0;
    for (let i = 0; i < len; i++) { const v = this.buf[(this.idx + i) % len]; win[i] = v; energy += v * v; }
    if (energy / len < 1e-7) { this.freq = 0; this.clarity = 0; return; }   // about -70 dBFS: nothing playing
    // difference function and its cumulative mean normalisation
    d[0] = 1;
    let running = 0, lag = -1;
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const v = win[i] - win[i + tau]; s += v * v; }
      raw[tau] = s;
      running += s;
      d[tau] = running > 0 ? s * tau / running : 1;
    }
    const minLag = Math.floor(this.fsDec / 1400);
    for (let tau = Math.max(2, minLag); tau < maxLag; tau++) {
      if (d[tau] < THRESH) {
        while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++;
        lag = tau; break;
      }
    }
    if (lag < 0) { this.freq = 0; this.clarity = 0; return; }
    // parabolic interpolation around the dip, on the raw difference (the
    // normalised one is skewed at short lags, which pulls high notes sharp)
    const a = raw[lag - 1], b = raw[lag], c = raw[lag + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
    this.freq = this.fsDec / (lag + shift);
    this.clarity = 1 - d[lag];
  }
}
