// Hall reverb (from ft-mycelia): 8-line feedback delay network (Householder mixing) with
// slowly modulated read positions (no metallic ringing, chorus-like
// bloom), per-line damping and high-pass, input diffusion and pre-delay.
// Optional "shimmer": an octave-up granular pitch shifter in the feedback
// path, low-passed so it blooms rather than screams.
//
// Damping is Jot's (Jot & Chaigne, "Digital delay networks for designing
// artificial reverberators", AES 1991): each line's one-pole filter is set
// from its own length, so that every line loses the same dB per second at
// low frequencies (the decay knob: the time to -60 dB) and at the top (that
// time times 0.35..0.85 at 4 kHz, the tone knob). A plain shared low-pass loses more
// per second in the short lines than in the long ones, which colours the
// tail and made it ~15% shorter than the knob. The input has its own
// tone low-pass. `er` adds early reflections, a few sparse taps (4 to 33
// ms, stretched with the size, alternating sides and signs) in front of the
// dense tail: a room has them, a plate doesn't.

import { readDelay, tanhf } from './util.ts';

const N = 8;
const BASE = [1499, 1889, 2311, 2707, 3169, 3559, 4003, 4519];   // samples at 48 kHz
const MOD_RATE = [0.11, 0.17, 0.23, 0.31, 0.13, 0.19, 0.29, 0.37];
const AP_MS = [3.1, 5.3, 8.7, 13.9];
const AP_G = 0.62;
const MAX_SCALE = 1.45;
const MOD_DEPTH = 9;          // samples
const ER_L = [4.3, 9.7, 15.1, 21.9, 29.3], ER_R = [5.9, 11.3, 17.7, 24.7, 33.1];   // ms at the largest size
const ER_G = [0.62, -0.5, 0.42, -0.33, 0.26];

class PitchUp {
  private buf: Float32Array;
  private idx = 0;
  private phase = 0;
  private readonly W: number;
  constructor(sampleRate: number) {
    this.W = Math.round(sampleRate * 0.045);
    this.buf = new Float32Array(this.W + 4);
  }
  clear(): void { this.buf.fill(0); }
  tick(x: number): number {
    const W = this.W;
    this.buf[this.idx] = x;
    const p = this.phase;
    let p2 = p + 0.5; if (p2 >= 1) p2 -= 1;
    const a = readDelay(this.buf, this.idx, W * (1 - p)) * Math.sin(Math.PI * p);
    const b = readDelay(this.buf, this.idx, W * (1 - p2)) * Math.sin(Math.PI * p2);
    this.phase += 1 / W; if (this.phase >= 1) this.phase -= 1;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return a + b;
  }
}

export class Hall {
  private lines: Float32Array[] = [];
  private idx = new Int32Array(N);
  private lengths = new Float64Array(N);
  private gains = new Float32Array(N);
  private damp = new Float32Array(N);    // each line's damping pole
  private dampG = new Float32Array(N);   // and its input gain (the line's decay at DC times 1 - pole)
  private inLp = 0;
  private er: Float32Array; private erIdx = 0;
  private erTapL = new Int32Array(5); private erTapR = new Int32Array(5);
  private lp = new Float32Array(N);
  private hp = new Float32Array(N);
  private modPhase = new Float32Array(N);
  private tmp = new Float32Array(N);
  private ap: Float32Array[] = [];
  private apIdx = new Int32Array(4);
  private pre: Float32Array;
  private preIdx = 0;
  private shimmer: PitchUp;
  private shimLp = 0;
  private readonly fs: number;
  private curSize = -1; private curDecay = -1; private curTone = -1;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const ratio = sampleRate / 48000;
    for (let i = 0; i < N; i++) {
      this.lines.push(new Float32Array(Math.ceil(BASE[i] * ratio * MAX_SCALE + MOD_DEPTH * 2 + 8)));
      this.modPhase[i] = i / N;
    }
    for (let i = 0; i < 4; i++) this.ap.push(new Float32Array(Math.max(2, Math.round(AP_MS[i] * 1e-3 * sampleRate))));
    this.pre = new Float32Array(Math.round(0.018 * sampleRate));
    this.er = new Float32Array(Math.ceil(0.035 * sampleRate) + 2);
    this.shimmer = new PitchUp(sampleRate);
    this.setSize(0.6, 3, 0.5);
  }

  clear(): void {
    for (const l of this.lines) l.fill(0);
    for (const a of this.ap) a.fill(0);
    this.pre.fill(0); this.lp.fill(0); this.hp.fill(0); this.er.fill(0); this.inLp = 0;
    this.shimmer.clear(); this.shimLp = 0;
  }

  private setSize(size: number, decay: number, tone: number): void {
    if (size === this.curSize && decay === this.curDecay && tone === this.curTone) return;
    this.curSize = size; this.curDecay = decay; this.curTone = tone;
    const scale = (0.45 + size) * this.fs / 48000;
    const hf = 0.35 + 0.5 * tone;    // the decay time at 4 kHz, relative
    const c = Math.cos(2 * Math.PI * 4000 / this.fs), c1 = Math.cos(2 * Math.PI * 1000 / this.fs);
    const trip = Math.pow(10, 0.083 / 20 * (48000 / this.fs) * (48000 / this.fs));
    for (let i = 0; i < N; i++) {
      this.lengths[i] = BASE[i] * scale;
      // the pole that makes the loop's gain at 4 kHz g^(1/hf), with g at DC
      const g0 = Math.pow(10, (-3 * this.lengths[i]) / (decay * this.fs)), r2 = Math.pow(g0, 2 / hf - 2);
      const p = 1 - r2 * c, q = 1 - r2;
      const b = (p - Math.sqrt(p * p - q * q)) / q;
      // the damping takes a little at 1 kHz too: make it up there, so `decay` is the time to -60 dB at 1 kHz
      // (it measured 10-15% short)
      // and the modulated lines' interpolation loses ~0.083 dB a trip at 1 kHz at 48 kHz (measured: the hall and the
      // plate came out short by the same loss per trip), falling with the square of the rate
      const m1 = (1 - b) / Math.sqrt(1 - 2 * b * c1 + b * b), g = Math.min(0.9995, g0 / m1 * trip);
      this.gains[i] = g; this.damp[i] = b; this.dampG[i] = g * (1 - b);
    }
    const es = (0.4 + 2 * Math.min(0.3, size)) * 1e-3 * this.fs;
    for (let k = 0; k < 5; k++) { this.erTapL[k] = Math.round(ER_L[k] * es); this.erTapR[k] = Math.round(ER_R[k] * es); }
  }

  private allpass(x: number, i: number): number {
    const buf = this.ap[i];
    let idx = this.apIdx[i];
    const d = buf[idx];
    const v = x - AP_G * d;
    buf[idx] = v;
    if (++idx >= buf.length) idx = 0;
    this.apIdx[i] = idx;
    return d + AP_G * v;
  }

  /** In place. `size` 0..1, `decay` seconds, `tone` 0..1, `shimmer` 0..1, `mix` 0..1, `er` the early reflections 0..1. */
  process(L: Float32Array, R: Float32Array, n: number, size: number, decay: number, tone: number, shimmer: number, mix: number, er = 0): void {
    if (mix <= 0) return;
    this.setSize(size, decay, tone);
    const damp = this.damp, dampG = this.dampG, erBuf = this.er, erLen = erBuf.length, tapL = this.erTapL, tapR = this.erTapR;
    let erIdx = this.erIdx, inLp = this.inLp;
    const fs = this.fs;
    const lines = this.lines, idx = this.idx, lengths = this.lengths;
    const lp = this.lp, hp = this.hp, tmp = this.tmp, modPhase = this.modPhase;
    const lpA = 1 - Math.exp(-2 * Math.PI * (1200 + tone * 9000) / fs);
    const hpA = 1 - Math.exp(-2 * Math.PI * 70 / fs);
    const shimLpA = 1 - Math.exp(-2 * Math.PI * 3500 / fs);
    const twoOverN = 2 / N;
    const wet = mix * 0.6, dry = 1 - mix * 0.35;
    const pre = this.pre, preLen = pre.length;
    let preIdx = this.preIdx;
    const shimGain = shimmer * 0.45;
    let shimLp = this.shimLp;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      // pre-delay + diffusion on the mono sum
      const inMono = (xl + xr) * 0.5;
      const preOut = pre[preIdx]; pre[preIdx] = inMono; if (++preIdx >= preLen) preIdx = 0;
      inLp += (preOut - inLp) * lpA;
      let x = this.allpass(this.allpass(this.allpass(this.allpass(inLp, 0), 1), 2), 3);
      // the early reflections, off the dry signal
      erBuf[erIdx] = inMono;
      let eL = 0, eR = 0;
      if (er > 0) {
        for (let k = 0; k < 5; k++) {
          let a = erIdx - tapL[k]; if (a < 0) a += erLen;
          let b = erIdx - tapR[k]; if (b < 0) b += erLen;
          eL += ER_G[k] * erBuf[a]; eR += ER_G[k] * erBuf[b];
        }
      }
      if (++erIdx >= erLen) erIdx = 0;
      // read the modulated taps
      let sum = 0, outL = 0, outR = 0;
      for (let j = 0; j < N; j++) {
        let ph = modPhase[j] + MOD_RATE[j] / fs; if (ph >= 1) ph -= 1; modPhase[j] = ph;
        const d = lengths[j] + Math.sin(6.283185307 * ph) * MOD_DEPTH;
        const v = readDelay(lines[j], idx[j], d);
        tmp[j] = v; sum += v;
        if (j & 1) outR += (j & 2) ? v : -v; else outL += (j & 2) ? v : -v;
      }
      // shimmer: octave-up of the tail, softened, fed back in
      if (shimGain > 0) {
        const sh = this.shimmer.tick((outL + outR) * 0.25);
        shimLp += (sh - shimLp) * shimLpA;
        x += tanhf(shimLp * shimGain);
      }
      // Householder feedback with damping
      const s = sum * twoOverN;
      for (let j = 0; j < N; j++) {
        lp[j] = lp[j] * damp[j] + (tmp[j] - s) * dampG[j];
        hp[j] += (lp[j] - hp[j]) * hpA;
        const v = lp[j] - hp[j] + ((j & 1) ? -x : x);
        const line = lines[j];
        line[idx[j]] = v;
        if (++idx[j] >= line.length) idx[j] = 0;
      }
      L[i] = xl * dry + (outL + er * eL) * wet;
      R[i] = xr * dry + (outR + er * eR) * wet;
    }
    this.preIdx = preIdx; this.shimLp = shimLp; this.erIdx = erIdx; this.inLp = inLp;
  }
}
