// The wah (a Cry Baby): a resonant band-pass swept by the pedal, set by
// hand (`pos`) and/or pushed up by the pick (`auto`: an envelope follower,
// fast up and slow down). The coefficients are refreshed every 32 samples.
// No dry signal: a Cry Baby's output is the band-pass alone.
//
// The sweep and the loudness follow J. O. Smith's fit of a Cry Baby
// (Faust's `crybaby`): the resonance runs from 450 Hz at the heel to ~2.2
// kHz at the toe, its Q falls from 8 to 2, and the gain rises 12 dB toward
// the toe. Smith's filter is a resonator with a zero at DC, g (1 - z^-1) /
// (1 + a1 z^-1 + a2 z^-2), fitted at 44.1 kHz; here it is its analog
// prototype, K s / (s^2 + (w/Q) s + w^2) with K = g * 44100, through the
// bilinear transform with the resonance prewarped, so it is the same at any
// host rate. Its peak is K Q / w (+22 dB at the heel, +8 at the toe) and the
// power it passes, K^2 Q / w, is within 1 dB from heel to toe: the narrow
// heel is as loud as the wide toe. `reson` scales the Q (noon is the pedal).
//
// The transistor stage saturates smoothly as its output nears ~2 V peak
// (+6 dBV; Holters & Zolzer, DAFx-11, measured 13 dB of gain reduction at
// 0 dBV in): a soft clip with antiderivative antialiasing. The input is the
// unbuffered 68k (R1): first in the rack it loads the pickup, damping the
// coil's resonance that the DI (recorded into ~1M) has in it.

import { Biquad, dbToGain } from './util.ts';
import { bilinear2 } from './gtone.ts';
import { PICKUP_C, PICKUP_EDDY, DI_LOAD } from './pickup.ts';

const STEP = 32;
/** Smith's fit was made at this rate: K = g * FIT_FS. */
const FIT_FS = 44100;
/** The stage's output ceiling, volts peak. */
const SAT = 2;
/** The pickup and cable (pickup.ts), its eddy loss, the interface, and the wah's input. */
const C_PICKUP = PICKUP_C, R_EDDY = PICKUP_EDDY, R_DI = DI_LOAD, R_WAH = 68e3;

/** A smooth limit at +-SAT, and its antiderivative. */
function sat(x: number): number { return x / Math.sqrt(1 + x * x / (SAT * SAT)); }
function satInt(x: number): number { return SAT * Math.sqrt(SAT * SAT + x * x); }

export class Wah {
  private bp = new Biquad();
  private load = new Biquad();
  private env = 0;
  private last = 0;
  private srcR = -1; private srcL = -1;
  private readonly fs: number;
  /** Where the sweep is now, 0..1, for the picture. */
  pos = 0.5;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.bp.reset(); this.load.reset(); this.env = 0; this.last = 0; }

  /** The pickup (srcR, srcL) moved from the interface's 1M onto the wah's 68k: the ratio of the two loaded responses. */
  private setLoad(srcR: number, srcL: number): void {
    this.srcR = srcR; this.srcL = srcL;
    if (srcL <= 0) { this.load.bypass(); return; }
    const di = 1 / (1 / R_DI + 1 / R_EDDY), wah = 1 / (1 / R_WAH + 1 / R_EDDY), LC = srcL * C_PICKUP, RC = srcR * C_PICKUP;
    bilinear2(this.fs, LC, srcL / di + RC, 1 + srcR / di, LC, srcL / wah + RC, 1 + srcR / wah, this.load);
  }

  process(x: Float32Array, n: number, pos: number, auto: number, reson: number, levelDb: number, srcR = 0, srcL = 0): void {
    const fs = this.fs;
    if (srcR !== this.srcR || srcL !== this.srcL) this.setLoad(srcR, srcL);
    const atk = 1 - Math.exp(-1 / (0.004 * fs)), rel = 1 - Math.exp(-1 / (0.12 * fs));
    const qs = Math.pow(2, (reson - 0.6) * 2), out = dbToGain(levelDb);
    let env = this.env, cur = this.pos, last = this.last;
    for (let i0 = 0; i0 < n; i0 += STEP) {
      const m = Math.min(STEP, n - i0);
      cur = Math.min(1, Math.max(0, pos + auto * Math.min(1, env * 5)));
      const q = qs * Math.pow(2, 3 - 2 * cur);
      const f = 450 * Math.pow(2, 2.3 * cur), w = 2 * fs * Math.tan(Math.PI * Math.min(f, 0.45 * fs) / fs);
      const K = 0.1 * Math.pow(4, cur) * FIT_FS;
      bilinear2(fs, 0, K, 0, 1, w / q, w * w, this.bp);
      for (let i = i0; i < i0 + m; i++) {
        const v = this.load.tick(x[i]);
        const a = Math.abs(v);
        env += (a - env) * (a > env ? atk : rel);
        const b = this.bp.tick(v), d = b - last;
        const y = d > 1e-6 || d < -1e-6 ? (satInt(b) - satInt(last)) / d : sat(0.5 * (b + last));
        last = b;
        x[i] = y * out;
      }
    }
    this.env = env; this.pos = cur; this.last = last;
  }
}
