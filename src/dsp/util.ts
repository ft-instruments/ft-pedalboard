// Small numeric helpers shared by the DSP. No allocation, no browser APIs.

/** Rational tanh approximation, good to ~1e-3 over |x| < 3 and clamped beyond. */
export function tanhf(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

/** Soft clipper with unit slope at 0 and hard limit at ±1. */
export function softClip(x: number): number {
  if (x > 1.5) return 1;
  if (x < -1.5) return -1;
  return x - (x * x * x) * 0.148148; // x - 4/27 x^3, peaks at ±1 for x = ±1.5
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function midiToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** xorshift32; deterministic so offline renders are repeatable. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) { this.s = seed | 0 || 1; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x | 0;
    return ((x >>> 0) / 4294967296);
  }
  /** -1..1 */
  bi(): number { return this.next() * 2 - 1; }
}

/** One-pole parameter smoother (exponential glide to target). */
export class Smooth {
  value: number;
  target: number;
  private coef: number;
  constructor(initial: number, sampleRate: number, ms = 20) {
    this.value = this.target = initial;
    this.coef = 1 - Math.exp(-1 / (ms * 1e-3 * sampleRate));
  }
  set(t: number): void { this.target = t; }
  jump(t: number): void { this.value = this.target = t; }
  tick(): number { return (this.value += (this.target - this.value) * this.coef); }
  get settled(): boolean { return Math.abs(this.target - this.value) < 1e-6; }
}

/** Fractional-delay read with linear interpolation from a circular buffer. */
export function readDelay(buf: Float32Array, writeIdx: number, delay: number): number {
  const len = buf.length;
  let r = writeIdx - delay;
  while (r < 0) r += len;
  const i0 = r | 0;
  const frac = r - i0;
  let i1 = i0 + 1; if (i1 >= len) i1 -= len;
  return buf[i0] + (buf[i1] - buf[i0]) * frac;
}

/** DC blocker (first-order high-pass at ~10 Hz). */
export class DCBlock {
  private x1 = 0; private y1 = 0; private r: number;
  constructor(sampleRate: number, hz = 10) { this.r = 1 - (2 * Math.PI * hz) / sampleRate; }
  tick(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x; this.y1 = y;
    return y;
  }
}

/** One-pole low-pass, coefficient from a cutoff in Hz. */
export class OnePoleLP {
  z = 0; a = 0.1;
  constructor(sampleRate: number, hz: number) { this.set(sampleRate, hz); }
  set(sampleRate: number, hz: number): void { this.a = 1 - Math.exp(-2 * Math.PI * hz / sampleRate); }
  tick(x: number): number { return (this.z += (x - this.z) * this.a); }
}

export class OnePoleHP {
  private lp: OnePoleLP;
  constructor(sampleRate: number, hz: number) { this.lp = new OnePoleLP(sampleRate, hz); }
  set(sampleRate: number, hz: number): void { this.lp.set(sampleRate, hz); }
  reset(): void { this.lp.z = 0; }
  tick(x: number): number { return x - this.lp.tick(x); }
}

export function dbToGain(db: number): number { return Math.pow(10, db / 20); }

/**
 * Biquad, transposed direct form II, coefficients from the RBJ cookbook.
 * State in doubles so a filter far below fs (the oversampled tone stack,
 * a cab's low end) stays clean.
 */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = 0; private z2 = 0;

  reset(): void { this.z1 = this.z2 = 0; }

  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  private norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  bypass(): void { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; }

  lowpass(fs: number, f: number, q: number): void {
    const w = 2 * Math.PI * Math.min(f, fs * 0.49) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  highpass(fs: number, f: number, q: number): void {
    const w = 2 * Math.PI * Math.min(f, fs * 0.49) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  /** Band-pass, 0 dB at the centre. */
  bandpass(fs: number, f: number, q: number): void {
    const w = 2 * Math.PI * Math.min(f, fs * 0.49) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  peak(fs: number, f: number, q: number, db: number): void {
    const A = Math.pow(10, db / 40), w = 2 * Math.PI * Math.min(f, fs * 0.49) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }

  lowShelf(fs: number, f: number, db: number): void {
    const A = Math.pow(10, db / 40), w = 2 * Math.PI * Math.min(f, fs * 0.49) / fs, c = Math.cos(w), s = Math.sin(w);
    const al = s / Math.SQRT2, k = 2 * Math.sqrt(A) * al;
    this.norm(A * ((A + 1) - (A - 1) * c + k), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - k),
      (A + 1) + (A - 1) * c + k, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - k);
  }

  highShelf(fs: number, f: number, db: number): void {
    const A = Math.pow(10, db / 40), w = 2 * Math.PI * Math.min(f, fs * 0.49) / fs, c = Math.cos(w), s = Math.sin(w);
    const al = s / Math.SQRT2, k = 2 * Math.sqrt(A) * al;
    this.norm(A * ((A + 1) + (A - 1) * c + k), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - k),
      (A + 1) - (A - 1) * c + k, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - k);
  }

  /** |H| at `f` Hz, for the UI's response curves. */
  mag(fs: number, f: number): number {
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

/** Rate of the nonlinear stages: drive and amp run at 8x (4x left the fuzz aliasing at -32 dB on a 2.8 kHz tone). */
export const OS = 8;
const OS_SECTIONS = 6;

/**
 * OS-times up/down sampler: zero-stuffing and decimation, each through a
 * 12th-order Butterworth low-pass at 0.45 of the base rate.
 */
export class Oversampler {
  private up: Biquad[] = [];
  private down: Biquad[] = [];

  constructor(sampleRate: number) {
    const fsOs = sampleRate * OS, fc = Math.min(20000, sampleRate * 0.45);
    for (let k = 0; k < OS_SECTIONS; k++) {
      // Butterworth pole pairs: Q of section k of an order-2N filter
      const q = 1 / (2 * Math.cos(Math.PI * (2 * k + 1) / (4 * OS_SECTIONS)));
      const u = new Biquad(); u.lowpass(fsOs, fc, q); this.up.push(u);
      const d = new Biquad(); d.lowpass(fsOs, fc, q); this.down.push(d);
    }
  }

  reset(): void { for (const b of this.up) b.reset(); for (const b of this.down) b.reset(); }

  /** n base-rate samples of `x` into n * OS samples of `out`. */
  upsample(x: Float32Array, out: Float32Array, n: number): void {
    const up = this.up;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < OS; k++) {
        let v = k === 0 ? x[i] * OS : 0;
        for (let s = 0; s < OS_SECTIONS; s++) v = up[s].tick(v);
        out[i * OS + k] = v;
      }
    }
  }

  /** n * OS samples of `x` back into n base-rate samples of `out`. */
  downsample(x: Float32Array, out: Float32Array, n: number): void {
    const down = this.down;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < OS; k++) {
        let v = x[i * OS + k];
        for (let s = 0; s < OS_SECTIONS; s++) v = down[s].tick(v);
        if (k === OS - 1) out[i] = v;
      }
    }
  }
}
