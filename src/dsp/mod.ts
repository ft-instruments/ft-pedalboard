// The modulation pedals.
//
//  Chorus   a bucket-brigade chorus: one modulated delay per side, the two
//           sides' LFOs a quarter cycle apart so a mono guitar comes out wide.
//           As in a CE-2 style pedal the LFO is a (rounded) triangle, the line
//           has a low-pass on each side of it (anti-alias and
//           reconstruction: 12 dB/oct on the wet signal) and saturates
//           softly (after Raffel & Smith, "Practical modeling of
//           bucket-brigade device circuits", DAFx 2010; no clock noise or
//           compander hiss is added: a digital line has none to hide). Mix
//           at the top is vibrato.
//  Phaser   four, six or eight first-order allpass stages swept together on
//           an exponential (as a JFET or OTA phaser sweeps), with feedback
//           around them for the resonant peaks; the right side's sweep can
//           lag the left's by up to half a cycle.
//  Flanger  a short bucket-brigade delay (0.6 to 5 ms) swept by a rounded
//           triangle, as the MXR and Electric Mistress sweep, with feedback;
//           the BBD's 9 kHz reconstruction filter is on both the repeats and
//           the output: the sweeping comb of a jet plane. The right side's
//           sweep trails by a quarter cycle.
//  Vibe     the Uni-Vibe: four phase stages, each a photocell with its own
//           capacitor (15 nF, 220 nF, 470 pF, 4.7 nF: the original's
//           famously uneven values, so each stage works on a different
//           band), all under one bulb. The LFO drives the bulb; the filament
//           heats and cools slowly, and the cells darken fast and recover
//           slowly (CdS), so the sweep is lopsided and throbs rather than
//           swooshes. After Darabundit, Wedelich & Bischoff, "Digital grey
//           box model of the Uni-Vibe effects pedal" (DAFx 2019). `chorus` mixes the swept
//           signal with the dry one; `vibrato` is the swept signal alone.
//  Rotary   a rotating-speaker cabinet: the signal splits at 800 Hz into a
//           horn (highs) and a drum (lows), each spun at its own speed that
//           ramps up and down with inertia. Each one is picked up by two
//           microphones a quarter turn apart: the doppler shift of the
//           moving source and its level as it turns to face the mic.
//  Tremolo  three of the amp kinds (`type`): bias (the power tubes' gain
//           rides an LFO that runs from a sine to nearly square: Vox, early
//           Fender), optical (a neon bulb and a photocell: the bulb only
//           lights over the top of the LFO and the cell recovers slowly, so
//           the dips are short and lopsided: the blackface Fender), harmonic
//           (the brownface Fender: lows and highs split at 650 Hz and swung in
//           opposite directions, a phasey throb more than a volume chop).

import { readDelayCubic, OnePoleLP, tanhf } from './util.ts';

const TWO_PI = 2 * Math.PI;

/** A bucket-brigade chorus or flanger's LFO: a triangle (same phase as a sine) with its tips rounded. */
export function lfoTri(ph: number): number {
  let p = ph + 0.25; if (p >= 1) p -= 1;
  const x = 1 - 4 * Math.abs(p - 0.5);
  return 1.5 * x - 0.5 * x * x * x;
}

export class Chorus {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private idx = 0;
  private lpL = 0; private lpR = 0; private inL = 0; private inR = 0;
  private readonly fs: number;
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const len = Math.ceil(0.03 * sampleRate);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
  }

  reset(): void { this.bufL.fill(0); this.bufR.fill(0); this.lpL = this.lpR = this.inL = this.inR = 0; }

  process(L: Float32Array, R: Float32Array, n: number, rate: number, depth: number, tone: number, mix: number): void {
    const fs = this.fs, bufL = this.bufL, bufR = this.bufR, len = bufL.length;
    const base = 0.0075 * fs, swing = depth * 0.0048 * fs;
    const inc = rate / fs;
    // the BBD's anti-alias filter in front of the line and its reconstruction filter after it (together
    // -3 dB at the same corner as a single pole)
    const lpA = 1 - Math.exp(-TWO_PI * Math.min(0.4 * fs, 3900 + tone * 14800) / fs);
    const dry = 1 - mix;
    let idx = this.idx, ph = this.phase, lpL = this.lpL, lpR = this.lpR, inL = this.inL, inR = this.inR;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const xl = L[i], xr = R[i];
      const wl = readDelayCubic(bufL, idx, base + swing * lfoTri(ph));
      const wr = readDelayCubic(bufR, idx, base + swing * lfoTri(ph >= 0.75 ? ph - 0.75 : ph + 0.25));
      inL += (xl - inL) * lpA; inR += (xr - inR) * lpA;
      // the bucket brigade runs out of headroom softly
      bufL[idx] = 1.5 * tanhf(inL * (1 / 1.5)); bufR[idx] = 1.5 * tanhf(inR * (1 / 1.5));
      if (++idx >= len) idx = 0;
      lpL += (wl - lpL) * lpA; lpR += (wr - lpR) * lpA;
      L[i] = xl * dry + lpL * mix;
      R[i] = xr * dry + lpR * mix;
    }
    this.idx = idx; this.phase = ph; this.lpL = lpL; this.lpR = lpR; this.inL = inL; this.inR = inR;
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
    const lpA = 1 - Math.exp(-TWO_PI * 9000 / fs);
    const dry = 1 - mix;
    let idx = this.idx, ph = this.phase, fbL = this.fbL, fbR = this.fbR;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const xl = L[i], xr = R[i];
      const wl = readDelayCubic(bufL, idx, base + swing * lfoTri(ph));
      const wr = readDelayCubic(bufR, idx, base + swing * lfoTri(ph >= 0.75 ? ph - 0.75 : ph + 0.25));
      bufL[idx] = xl + fbL * regen; bufR[idx] = xr + fbR * regen;
      if (++idx >= len) idx = 0;
      // the BBD's reconstruction filter, on the repeats and on what comes out
      fbL += (wl - fbL) * lpA; fbR += (wr - fbR) * lpA;
      L[i] = xl * dry + fbL * mix;
      R[i] = xr * dry + fbR * mix;
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

/** The Uni-Vibe's four phase stages: each a photocell and its own capacitor, in series with 4.7k. */
const VIBE_C = [15e-9, 220e-9, 470e-12, 4.7e-9];
/** The four photocells don't match: each one's resistance, relative. */
const VIBE_MATCH = [1, 1.15, 0.9, 1.05];
const VIBE_RS = 4.7e3, VIBE_RMIN = 5e3, VIBE_RMAX = 400e3;

export class Vibe {
  private ap = new Float64Array(4);
  private lamp = 0;      // the bulb's filament heat (its light), 0..1
  private cell = 0;      // the photocells' response to it
  private readonly fs: number;
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.ap.fill(0); this.lamp = 0; this.cell = 0; }

  /** In place on `x`. `mode` 0 = chorus, 1 = vibrato. */
  process(x: Float32Array, n: number, rate: number, depth: number, mode: number): void {
    const fs = this.fs, w = Math.PI / fs, inc = rate / fs, ap = this.ap;
    const vib = mode >= 0.5;
    // the filament heats and cools over ~25 ms; the cells answer the light in ~5 ms and let go over ~60 ms
    const kLamp = 1 - Math.exp(-1 / (0.025 * fs)), kOn = 1 - Math.exp(-1 / (0.005 * fs)), kOff = 1 - Math.exp(-1 / (0.06 * fs));
    const fMax = 0.45 * fs;
    let ph = this.phase, lamp = this.lamp, cell = this.cell;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      // the LFO drives the bulb from a dim idle; its light goes with the power (the square of the drive)
      const d = 0.2 + 0.8 * depth * (0.5 + 0.5 * Math.sin(TWO_PI * ph));
      lamp += (d * d - lamp) * kLamp;
      cell += (lamp - cell) * (lamp > cell ? kOn : kOff);
      const r = Math.min(VIBE_RMAX, VIBE_RMIN * Math.pow(cell + 1e-4, -0.8));
      const v0 = x[i];
      let v = v0;
      for (let k = 0; k < 4; k++) {
        const f = Math.min(fMax, 1 / (2 * Math.PI * (r * VIBE_MATCH[k] + VIBE_RS) * VIBE_C[k]));
        const t = Math.tan(w * f), a = (t - 1) / (t + 1);
        const y = a * v + ap[k]; ap[k] = v - a * y; v = y;
      }
      x[i] = vib ? v : (v0 + v) * 0.7;
    }
    this.phase = ph; this.lamp = lamp; this.cell = cell;
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
    const base = 0.0008 * fs + 4, swH = depth * 0.00045 * fs, swD = depth * 0.0004 * fs;
    const dry = 1 - mix;
    let idx = this.idx, hr = this.hornRate, dr = this.drumRate, hp = this.hornPh, dp = this.drumPh;
    for (let i = 0; i < n; i++) {
      hr += (hTarget - hr) * hk; dr += (dTarget - dr) * dk;
      hp += hr / fs; if (hp >= 1) hp -= 1;
      dp += dr / fs; if (dp >= 1) dp -= 1;
      const xl = L[i], xr = R[i], m = (xl + xr) * 0.5;
      const lo = this.lp2.tick(this.lp1.tick(m)), hi = m - lo;
      hbuf[idx] = hi; dbuf[idx] = lo;
      const th = TWO_PI * hp, td = -TWO_PI * dp;
      // mic L faces the horn at angle 0, mic R a quarter turn later; the delay falls as the source approaches
      const hl = readDelayCubic(hbuf, idx, base - swH * Math.sin(th)) * (1 - depth * 0.55 * (0.5 - 0.5 * Math.cos(th)));
      const hrr = readDelayCubic(hbuf, idx, base - swH * Math.sin(th - Math.PI / 2)) * (1 - depth * 0.55 * (0.5 - 0.5 * Math.cos(th - Math.PI / 2)));
      const dl = readDelayCubic(dbuf, idx, base - swD * Math.sin(td)) * (1 - depth * 0.3 * (0.5 - 0.5 * Math.cos(td)));
      const drr = readDelayCubic(dbuf, idx, base - swD * Math.sin(td - Math.PI / 2)) * (1 - depth * 0.3 * (0.5 - 0.5 * Math.cos(td - Math.PI / 2)));
      if (++idx >= len) idx = 0;
      L[i] = xl * dry + (hl + dl) * mix;
      R[i] = xr * dry + (hrr + drr) * mix;
    }
    this.idx = idx; this.hornRate = hr; this.drumRate = dr; this.hornPh = hp; this.drumPh = dp;
    this.phase = hp;
  }
}

/** The tremolo's circuits (the `type` knob): an optical cell, the power tubes' bias, or the brownface's two bands. */
export const TREM_OPTICAL = 0, TREM_BIAS = 1, TREM_HARMONIC = 2;
const TREM_SPLIT = 650;

export class Tremolo {
  private readonly fs: number;
  private cell = 0;                       // the photocell's conductance, 0..1
  private loL = 0; private loR = 0;       // the harmonic tremolo's low band
  /** LFO phase 0..1, for the picture. */
  phase = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.cell = 0; this.loL = 0; this.loR = 0; }

  /** In place, on L (and R when `stereo`): one LFO for both sides. */
  process(L: Float32Array, R: Float32Array, n: number, stereo: boolean, rate: number, depth: number, shape: number, type: number): void {
    const fs = this.fs, inc = rate / fs;
    const k = 1 + shape * 14, norm = 1 / Math.tanh(k);
    const t = Math.round(type);
    let ph = this.phase;
    if (t === TREM_OPTICAL) {
      // the LFO lights a neon bulb once it passes its striking voltage; the cell under it darkens the
      // signal fast as the light comes on and gives it back slowly: short, lopsided dips
      const atk = 1 - Math.exp(-1 / (0.003 * fs)), rel = 1 - Math.exp(-1 / (0.035 * fs));
      let c = this.cell;
      for (let i = 0; i < n; i++) {
        ph += inc; if (ph >= 1) ph -= 1;
        const w = Math.tanh(k * Math.sin(TWO_PI * ph)) * norm;
        const light = w > 0.3 ? (w - 0.3) / 0.7 : 0;
        c += (light - c) * (light > c ? atk : rel);
        const g = 1 - depth * c;
        L[i] *= g;
        if (stereo) R[i] *= g;
      }
      this.cell = c;
    } else if (t === TREM_HARMONIC) {
      // the signal split at 650 Hz, the two bands swung in opposite directions and summed: a phasey throb
      const a = 1 - Math.exp(-TWO_PI * TREM_SPLIT / fs);
      let lo = this.loL, lr = this.loR;
      for (let i = 0; i < n; i++) {
        ph += inc; if (ph >= 1) ph -= 1;
        const u = 0.5 + 0.5 * Math.tanh(k * Math.sin(TWO_PI * ph)) * norm;
        const gl = 1 - depth * (1 - u), gh = 1 - depth * u;
        lo += (L[i] - lo) * a;
        L[i] = lo * gl + (L[i] - lo) * gh;
        if (stereo) { lr += (R[i] - lr) * a; R[i] = lr * gl + (R[i] - lr) * gh; }
      }
      this.loL = lo; this.loR = lr;
    } else {
      // bias: the power tubes' gain rides the LFO, from a sine to nearly square
      for (let i = 0; i < n; i++) {
        ph += inc; if (ph >= 1) ph -= 1;
        const u = 0.5 + 0.5 * Math.tanh(k * Math.sin(TWO_PI * ph)) * norm;
        const g = 1 - depth * (1 - u);
        L[i] *= g;
        if (stereo) R[i] *= g;
      }
    }
    this.phase = ph;
  }
}
