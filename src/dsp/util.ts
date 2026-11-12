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

/**
 * Fractional-delay read with 4-point Hermite interpolation, for modulated
 * lines: linear interpolation low-passes a moving read and modulates its
 * highs with the fractional position. Needs delay >= 3 (it reads two
 * samples newer than the linear one).
 */
export function readDelayCubic(buf: Float32Array, writeIdx: number, delay: number): number {
  const len = buf.length;
  let r = writeIdx - delay;
  while (r < 0) r += len;
  const i0 = r | 0, f = r - i0;
  let im = i0 - 1; if (im < 0) im += len;
  let i1 = i0 + 1; if (i1 >= len) i1 -= len;
  let i2 = i1 + 1; if (i2 >= len) i2 -= len;
  const xm = buf[im], x0 = buf[i0], x1 = buf[i1], x2 = buf[i2];
  const c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
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

  /** A first-order section (b0 + b1 s) / (a0 + a1 s), through the bilinear transform. */
  firstOrder(fs: number, b0: number, b1: number, a0: number, a1: number): void {
    const c = 2 * fs;
    this.norm(b0 + b1 * c, b0 - b1 * c, 0, a0 + a1 * c, a0 - a1 * c, 0);
  }

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

/**
 * A first-order section from its analog prototype (b0 + b1 s) / (a0 + a1 s),
 * through the bilinear transform: the shelves that dividers with a cap
 * across one leg make (bright caps, treble bleeds).
 */
export class FirstOrder {
  private b0 = 1; private b1 = 0; private a1 = 0; private z = 0;
  reset(): void { this.z = 0; }
  set(fs: number, b0: number, b1: number, a0: number, a1: number): void {
    const c = 2 * fs, A0 = a0 + a1 * c;
    this.b0 = (b0 + b1 * c) / A0; this.b1 = (b0 - b1 * c) / A0; this.a1 = (a0 - a1 * c) / A0;
  }
  /** A plain gain. */
  gain(g: number): void { this.b0 = g; this.b1 = 0; this.a1 = 0; }
  tick(x: number): number { const y = this.b0 * x + this.z; this.z = this.b1 * x - this.a1 * y; return y; }
}

/**
 * A third-order section from its analog prototype (b0 + b1 s + b2 s^2 + b3 s^3) /
 * (a0 + a1 s + a2 s^2 + a3 s^3), through the bilinear transform (transposed direct form, doubles).
 */
export class Cubic {
  private b0 = 1; private b1 = 0; private b2 = 0; private b3 = 0; private a1 = 0; private a2 = 0; private a3 = 0;
  private z1 = 0; private z2 = 0; private z3 = 0;
  reset(): void { this.z1 = this.z2 = this.z3 = 0; }
  bypass(): void { this.b0 = 1; this.b1 = this.b2 = this.b3 = this.a1 = this.a2 = this.a3 = 0; }
  set(fs: number, b0: number, b1: number, b2: number, b3: number, a0: number, a1: number, a2: number, a3: number): void {
    const c = 2 * fs, c2 = c * c, c3 = c2 * c;
    const B0 = b0 + b1 * c + b2 * c2 + b3 * c3, B1 = 3 * b0 + b1 * c - b2 * c2 - 3 * b3 * c3;
    const B2 = 3 * b0 - b1 * c - b2 * c2 + 3 * b3 * c3, B3 = b0 - b1 * c + b2 * c2 - b3 * c3;
    const A0 = a0 + a1 * c + a2 * c2 + a3 * c3, A1 = 3 * a0 + a1 * c - a2 * c2 - 3 * a3 * c3;
    const A2 = 3 * a0 - a1 * c - a2 * c2 + 3 * a3 * c3, A3 = a0 - a1 * c + a2 * c2 - a3 * c3;
    this.b0 = B0 / A0; this.b1 = B1 / A0; this.b2 = B2 / A0; this.b3 = B3 / A0;
    this.a1 = A1 / A0; this.a2 = A2 / A0; this.a3 = A3 / A0;
  }
  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y + this.z3;
    this.z3 = this.b3 * x - this.a3 * y;
    return y;
  }
}

/** The amps' oversampling at 44.1/48 kHz (the factor never drops below it at higher rates). */
export const OS = 8;
/** The amps' internal rate (with OS as the floor). */
export const AMP_RATE = 700e3;
/** The largest oversampling factor (buffers are sized for it). */
export const OS_MAX = 32;
/**
 * The drives' internal rate: the factor is the smallest power of two that
 * reaches it, so 16x at 44.1 and 48 kHz, 8x at 88.2 and 96 kHz. At 8x and
 * 44.1 kHz the fuzz, rasp, metal, octave and muff folded products back at
 * -38..-57 dB (the fixer audit); at 96 kHz (also 8x) they were 15-30 dB lower.
 */
export const DRIVE_RATE = 700e3;
/** The hard clippers' and the fuzz's internal rate (32x at 44.1/48 kHz): at 16x they still folded back at -55..-65 dB on 4-6 kHz tones. */
export const DRIVE_RATE_HARD = 1400e3;
/** The oversampling factor that takes `fs` to at least `rate` (a power of two, 2..OS_MAX, never under `min`). */
export function osFactor(fs: number, rate: number, min = 2): number {
  let f = 1;
  while (f < OS_MAX && fs * f < rate * 0.99) f *= 2;
  return Math.max(min, f);
}

/**
 * Coefficients of a polyphase IIR halfband filter: two chains of first-order
 * allpasses (in z^2) whose average is a low-pass at a quarter of the rate
 * (Valenzuela & Constantinides; the closed-form elliptic design as in
 * Laurent de Soras' public-domain HIIR). `attn` dB in the stopband,
 * `tr` the transition width relative to the (higher) rate. Even-indexed
 * coefficients form the first chain, odd-indexed the second.
 */
export function halfbandCoefs(attn: number, tr: number): number[] {
  let k = Math.tan((1 - 2 * tr) * Math.PI / 4); k *= k;
  const kk = Math.pow(1 - k * k, 0.25), e = 0.5 * (1 - kk) / (1 + kk), e4 = e * e * e * e;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const ap = Math.pow(10, -attn / 10), a = ap / (1 - ap);
  let order = Math.ceil(Math.log(a * a / 16) / Math.log(q));
  if (order % 2 === 0) order++;
  if (order < 3) order = 3;
  const out: number[] = [];
  for (let c = 1; c <= (order - 1) / 2; c++) {
    let num = 0, den = 0;
    for (let i = 0; i < 30; i++) num += (i % 2 ? -1 : 1) * Math.pow(q, i * (i + 1)) * Math.sin((2 * i + 1) * c * Math.PI / order);
    for (let i = 1; i < 30; i++) den += (i % 2 ? -1 : 1) * Math.pow(q, i * i) * Math.cos(2 * i * c * Math.PI / order);
    const ww = num * Math.pow(q, 0.25) / (den + 0.5), w2 = ww * ww;
    const x = Math.sqrt((1 - w2 * k) * (1 - w2 / k)) / (1 + w2);
    out.push((1 - x) / (1 + x));
  }
  return out;
}

/** One 2x stage: the two allpass chains, run at the lower rate (polyphase). */
class Halfband {
  readonly c0: Float64Array; readonly c1: Float64Array;
  private x0: Float64Array; private y0: Float64Array; private x1: Float64Array; private y1: Float64Array;
  constructor(coefs: number[]) {
    this.c0 = Float64Array.from(coefs.filter((_, i) => i % 2 === 0));
    this.c1 = Float64Array.from(coefs.filter((_, i) => i % 2 === 1));
    this.x0 = new Float64Array(this.c0.length); this.y0 = new Float64Array(this.c0.length);
    this.x1 = new Float64Array(this.c1.length); this.y1 = new Float64Array(this.c1.length);
  }
  reset(): void { this.x0.fill(0); this.y0.fill(0); this.x1.fill(0); this.y1.fill(0); }
  /** The first chain on `v`. */
  p0(v: number): number {
    const c = this.c0, x = this.x0, y = this.y0;
    for (let i = 0; i < c.length; i++) { const o = c[i] * (v - y[i]) + x[i]; x[i] = v; y[i] = o; v = o; }
    return v;
  }
  /** The second chain on `v`. */
  p1(v: number): number {
    const c = this.c1, x = this.x1, y = this.y1;
    for (let i = 0; i < c.length; i++) { const o = c[i] * (v - y[i]) + x[i]; x[i] = v; y[i] = o; v = o; }
    return v;
  }
}

/** Halfband stopband: 100 dB in the design, ~112 dB measured from 28 kHz at 48 kHz. */
const OS_ATTN = 100;

/**
 * `factor`-times up/down sampler (2, 4, 8, 16 or 32): cascaded 2x polyphase
 * IIR halfband stages each way. Passband to min(20 kHz, 0.45 fs);
 * everything that would fold back into it is rejected by >100 dB (between
 * fs/2 and fs - 20 kHz the first stage's transition lets products fold to
 * 20 kHz-fs/2 only, above the audio band). Each stage is designed for its
 * own rate, so a higher factor only adds stages. Minimum-phase-ish allpass
 * sections: no FIR latency, a few samples of group delay in the passband.
 */
export class Oversampler {
  readonly factor: number;
  private up: Halfband[] = [];
  private down: Halfband[] = [];
  private bufA: Float64Array; private bufB: Float64Array;

  constructor(sampleRate: number, factor = OS) {
    this.factor = factor;
    const fp = Math.min(20000, sampleRate * 0.45);
    for (let s = 0, r = 2 * sampleRate; (1 << s) < factor; s++, r *= 2) {
      // stage s works at rate r: its transition is centred on r / 4 and runs from fp
      const tr = Math.min(0.45, 2 * (r / 4 - fp) / r);
      const c = halfbandCoefs(OS_ATTN, tr);
      this.up.push(new Halfband(c)); this.down.push(new Halfband(c));
    }
    this.bufA = new Float64Array(factor); this.bufB = new Float64Array(factor);
  }

  reset(): void { for (const b of this.up) b.reset(); for (const b of this.down) b.reset(); }

  /** n base-rate samples of `x` into n * factor samples of `out`. */
  upsample(x: Float32Array, out: Float32Array, n: number): void {
    const st = this.up, ns = st.length, F = this.factor;
    for (let i = 0; i < n; i++) {
      let a = this.bufA, b = this.bufB, len = 1;
      a[0] = x[i];
      for (let s = 0; s < ns; s++) {
        const h = st[s];
        for (let j = 0; j < len; j++) { const v = a[j]; b[2 * j] = h.p0(v); b[2 * j + 1] = h.p1(v); }
        const t = a; a = b; b = t; len <<= 1;
      }
      const o = i * F;
      for (let j = 0; j < F; j++) out[o + j] = a[j];
    }
  }

  /** n * factor samples of `x` back into n base-rate samples of `out`. */
  downsample(x: Float32Array, out: Float32Array, n: number): void {
    const st = this.down, ns = st.length, F = this.factor;
    for (let i = 0; i < n; i++) {
      let a = this.bufA, b = this.bufB, len = F >> 1;
      const o = i * F, top = st[ns - 1];
      for (let j = 0; j < len; j++) a[j] = 0.5 * (top.p0(x[o + 2 * j + 1]) + top.p1(x[o + 2 * j]));
      for (let s = ns - 2; s >= 0; s--) {
        const h = st[s];
        len >>= 1;
        for (let j = 0; j < len; j++) b[j] = 0.5 * (h.p0(a[2 * j + 1]) + h.p1(a[2 * j]));
        const t = a; a = b; b = t;
      }
      out[i] = a[0];
    }
  }
}
