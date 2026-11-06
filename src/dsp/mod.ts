// The modulation pedals.
//
//  Chorus   a bucket-brigade chorus: one modulated delay per side, the two
//           sides' LFOs a quarter cycle apart so a mono guitar comes out wide,
//           the wet path darkened like a BBD chip's clock filter. Mix at the
//           top is vibrato.
//  Phaser   four, six or eight first-order allpass stages swept together on
//           an exponential (as a JFET or OTA phaser sweeps), with feedback
//           around them for the resonant peaks; the right side's sweep can
//           lag the left's by up to half a cycle.
//  Flanger  a short bucket-brigade delay (0.6 to 5 ms) swept by a sine, with
//           feedback through a darkening filter: the sweeping comb of a jet
//           plane. The right side's sweep trails by a quarter cycle.
//  Vibe     four first-order allpass stages at staggered frequencies (a
//           ratio of 1 : 2.3 : 4.7 : 9.6) swept by a lopsided LFO, the way
//           a lamp and four photocells move them. `chorus` mixes the swept
//           signal with the dry one; `vibrato` is the swept signal alone.
//  Rotary   a rotating-speaker cabinet: the signal splits at 800 Hz into a
//           horn (highs) and a drum (lows), each spun at its own speed that
//           ramps up and down with inertia. Each one is picked up by two
//           microphones a quarter turn apart: the doppler shift of the
//           moving source and its level as it turns to face the mic.
//  Tremolo  the amp kind: volume rides an LFO that runs from a sine to
//           nearly square.

import { readDelay, OnePoleLP } from './util.ts';

const TWO_PI = 2 * Math.PI;

export class Chorus {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private idx = 0;
  private lpL = 0; private lpR = 0;
  private readonly fs: number;
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const len = Math.ceil(0.03 * sampleRate);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
  }

  reset(): void { this.bufL.fill(0); this.bufR.fill(0); this.lpL = this.lpR = 0; }

  process(L: Float32Array, R: Float32Array, n: number, rate: number, depth: number, tone: number, mix: number): void {
    const fs = this.fs, bufL = this.bufL, bufR = this.bufR, len = bufL.length;
    const base = 0.0075 * fs, swing = depth * 0.0048 * fs;
    const inc = rate / fs;
    const lpA = 1 - Math.exp(-TWO_PI * (2500 + tone * 9500) / fs);
    const dry = 1 - mix;
    let idx = this.idx, ph = this.phase, lpL = this.lpL, lpR = this.lpR;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const xl = L[i], xr = R[i];
      const wl = readDelay(bufL, idx, base + swing * Math.sin(TWO_PI * ph));
      const wr = readDelay(bufR, idx, base + swing * Math.sin(TWO_PI * (ph + 0.25)));
      bufL[idx] = xl; bufR[idx] = xr;
      if (++idx >= len) idx = 0;
      lpL += (wl - lpL) * lpA; lpR += (wr - lpR) * lpA;
      L[i] = xl * dry + lpL * mix;
      R[i] = xr * dry + lpR * mix;
    }
    this.idx = idx; this.phase = ph; this.lpL = lpL; this.lpR = lpR;
  }
}

export class Flanger {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private idx = 0;
  private fbL = 0; private fbR = 0;
  private readonly fs: number;
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const len = Math.ceil(0.012 * sampleRate);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
  }

  reset(): void { this.bufL.fill(0); this.bufR.fill(0); this.fbL = this.fbR = 0; }

  process(L: Float32Array, R: Float32Array, n: number, rate: number, depth: number, manual: number, regen: number, mix: number): void {
    const fs = this.fs, bufL = this.bufL, bufR = this.bufR, len = bufL.length;
    const base = (0.0006 + manual * 0.0044) * fs, swing = depth * 0.85 * base;
    const inc = rate / fs;
    const lpA = 1 - Math.exp(-TWO_PI * 6500 / fs);
    const dry = 1 - mix;
    let idx = this.idx, ph = this.phase, fbL = this.fbL, fbR = this.fbR;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const xl = L[i], xr = R[i];
      const wl = readDelay(bufL, idx, base + swing * Math.sin(TWO_PI * ph));
      const wr = readDelay(bufR, idx, base + swing * Math.sin(TWO_PI * (ph + 0.25)));
      bufL[idx] = xl + fbL * regen; bufR[idx] = xr + fbR * regen;
      if (++idx >= len) idx = 0;
      fbL += (wl - fbL) * lpA; fbR += (wr - fbR) * lpA;
      L[i] = xl * dry + wl * mix;
      R[i] = xr * dry + wr * mix;
    }
    this.idx = idx; this.phase = ph; this.fbL = fbL; this.fbR = fbR;
  }
}

export const PHASER_MAX_STAGES = 8;
const PH_FMIN = 180;

export class Phaser {
  private apL = new Float64Array(PHASER_MAX_STAGES);
  private apR = new Float64Array(PHASER_MAX_STAGES);
  private fbL = 0; private fbR = 0;
  private readonly fs: number;
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.apL.fill(0); this.apR.fill(0); this.fbL = this.fbR = 0; }

  /** `stages` 0, 1, 2 = 4, 6, 8 stages. */
  process(L: Float32Array, R: Float32Array, n: number, rate: number, depth: number, fb: number, stages: number, spread: number, mix: number): void {
    const fs = this.fs, apL = this.apL, apR = this.apR;
    const st = 4 + 2 * stages;
    const logSpan = Math.log(2) * depth * 4.5;     // up to 4.5 octaves above PH_FMIN
    const inc = rate / fs, lag = spread * 0.5;
    const w = Math.PI / fs, dry = 1 - mix;
    let ph = this.phase, fbL = this.fbL, fbR = this.fbR;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const ul = 0.5 - 0.5 * Math.cos(TWO_PI * ph), ur = 0.5 - 0.5 * Math.cos(TWO_PI * (ph + lag));
      const tl = Math.tan(w * PH_FMIN * Math.exp(logSpan * ul)), tr = Math.tan(w * PH_FMIN * Math.exp(logSpan * ur));
      const al = (tl - 1) / (tl + 1), ar = (tr - 1) / (tr + 1);
      const xl = L[i], xr = R[i];
      // H(z) = (a + z^-1) / (1 + a z^-1) per stage
      let vl = xl + fbL * fb, vr = xr + fbR * fb;
      for (let s = 0; s < st; s++) {
        const yl = al * vl + apL[s]; apL[s] = vl - al * yl; vl = yl;
        const yr = ar * vr + apR[s]; apR[s] = vr - ar * yr; vr = yr;
      }
      fbL = vl; fbR = vr;
      L[i] = xl * dry + vl * mix;
      R[i] = xr * dry + vr * mix;
    }
    this.phase = ph; this.fbL = fbL; this.fbR = fbR;
  }
}

const VIBE_RATIOS = [1, 2.3, 4.7, 9.6];

export class Vibe {
  private ap = new Float64Array(4);
  private readonly fs: number;
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.ap.fill(0); }

  /** In place on `x`. `mode` 0 = chorus, 1 = vibrato. */
  process(x: Float32Array, n: number, rate: number, depth: number, mode: number): void {
    const w = Math.PI / this.fs, inc = rate / this.fs, ap = this.ap;
    const vib = mode >= 0.5;
    let ph = this.phase;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const s = 0.5 + 0.5 * Math.sin(TWO_PI * ph);
      const f0 = 140 * Math.pow(2, 3.2 * depth * Math.pow(s, 1.4));
      const v0 = x[i];
      let v = v0;
      for (let k = 0; k < 4; k++) {
        const t = Math.tan(w * f0 * VIBE_RATIOS[k]), a = (t - 1) / (t + 1);
        const y = a * v + ap[k]; ap[k] = v - a * y; v = y;
      }
      x[i] = vib ? v : (v0 + v) * 0.7;
    }
    this.phase = ph;
  }
}

export class Rotary {
  private horn: Float32Array;
  private drum: Float32Array;
  private idx = 0;
  private lp1: OnePoleLP; private lp2: OnePoleLP;
  private hornRate = 0.67; private drumRate = 0.5;
  private hornPh = 0; private drumPh = 0.3;
  private readonly fs: number;
  /** The horn's angle, 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const len = Math.ceil(0.003 * sampleRate) + 16;
    this.horn = new Float32Array(len);
    this.drum = new Float32Array(len);
    this.lp1 = new OnePoleLP(sampleRate, 800); this.lp2 = new OnePoleLP(sampleRate, 800);
  }

  reset(): void {
    this.horn.fill(0); this.drum.fill(0); this.lp1.z = 0; this.lp2.z = 0;
    this.hornRate = 0.67; this.drumRate = 0.5;
  }

  /** `speed` 0..1: chorale (slow) to tremolo (fast). Mono in (L and R summed), stereo out. */
  process(L: Float32Array, R: Float32Array, n: number, speed: number, depth: number, mix: number): void {
    const fs = this.fs, hbuf = this.horn, dbuf = this.drum, len = hbuf.length;
    const hTarget = 0.67 + 6.0 * speed, dTarget = 0.5 + 5.2 * speed;
    const hk = 1 - Math.exp(-1 / (1.0 * fs)), dk = 1 - Math.exp(-1 / (3.0 * fs));
    const base = 0.0008 * fs + 4, swH = depth * 0.0008 * fs, swD = depth * 0.0004 * fs;
    const dry = 1 - mix;
    let idx = this.idx, hr = this.hornRate, dr = this.drumRate, hp = this.hornPh, dp = this.drumPh;
    for (let i = 0; i < n; i++) {
      hr += (hTarget - hr) * hk; dr += (dTarget - dr) * dk;
      hp += hr / fs; if (hp >= 1) hp -= 1;
      dp += dr / fs; if (dp >= 1) dp -= 1;
      const xl = L[i], xr = R[i], m = (xl + xr) * 0.5;
      const lo = this.lp2.tick(this.lp1.tick(m)), hi = m - lo;
      hbuf[idx] = hi; dbuf[idx] = lo;
      const th = TWO_PI * hp, td = TWO_PI * dp;
      // mic L faces the horn at angle 0, mic R a quarter turn later; the delay falls as the source approaches
      const hl = readDelay(hbuf, idx, base - swH * Math.sin(th)) * (1 - depth * 0.55 * (0.5 - 0.5 * Math.cos(th)));
      const hrr = readDelay(hbuf, idx, base - swH * Math.sin(th - Math.PI / 2)) * (1 - depth * 0.55 * (0.5 - 0.5 * Math.cos(th - Math.PI / 2)));
      const dl = readDelay(dbuf, idx, base - swD * Math.sin(td)) * (1 - depth * 0.3 * (0.5 - 0.5 * Math.cos(td)));
      const drr = readDelay(dbuf, idx, base - swD * Math.sin(td - Math.PI / 2)) * (1 - depth * 0.3 * (0.5 - 0.5 * Math.cos(td - Math.PI / 2)));
      if (++idx >= len) idx = 0;
      L[i] = xl * dry + (hl + dl) * mix;
      R[i] = xr * dry + (hrr + drr) * mix;
    }
    this.idx = idx; this.hornRate = hr; this.drumRate = dr; this.hornPh = hp; this.drumPh = dp;
    this.phase = hp;
  }
}

export class Tremolo {
  private readonly fs: number;
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { /* free-running */ }

  /** In place, on L (and R when `stereo`): one LFO for both sides. */
  process(L: Float32Array, R: Float32Array, n: number, stereo: boolean, rate: number, depth: number, shape: number): void {
    const inc = rate / this.fs;
    const k = 1 + shape * 14, norm = 1 / Math.tanh(k);
    let ph = this.phase;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const u = 0.5 + 0.5 * Math.tanh(k * Math.sin(TWO_PI * ph)) * norm;
      const g = 1 - depth * (1 - u);
      L[i] *= g;
      if (stereo) R[i] *= g;
    }
    this.phase = ph;
  }
}
