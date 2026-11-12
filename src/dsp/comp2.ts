// The studio compressor: where "squeeze" is one knob and a photocell's habits,
// this has the usual controls and a plain, transparent behaviour. An RMS
// detector (a 12 ms power average, so a chord is read as a whole and a pick
// transient is not), the gain computer of Giannoulis, Massberg & Reiss
// (JAES 60(6), 2012) in decibels with an adjustable soft knee, and one-pole
// attack and release on the gain reduction. Threshold is in dB re 1 V (a DI
// guitar peaks around -20..-10), make-up is manual, and the mix blends the
// dry signal in for parallel compression.

import { dbToGain } from './util.ts';

const RMS_S = 0.012;

export class StudioComp {
  private power = 0;
  private gr = 0;
  private readonly fs: number;
  /** For the UI: the largest gain reduction over the last block, dB (positive). */
  reduction = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.power = 0; this.gr = 0; this.reduction = 0; }

  process(x: Float32Array, n: number, thr: number, ratio: number, attack: number, release: number, knee: number, makeupDb: number, mix: number): void {
    const fs = this.fs;
    const aP = Math.exp(-1 / (RMS_S * fs)), aA = Math.exp(-1 / (attack * fs)), aR = Math.exp(-1 / (release * fs));
    const slope = 1 - 1 / ratio, makeup = dbToGain(makeupDb);
    let power = this.power, gr = this.gr, maxGr = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      power = aP * power + (1 - aP) * v * v;
      const over = 10 * Math.log10(power + 1e-18) - thr;
      let want: number;
      if (2 * over < -knee) want = 0;
      else if (2 * over <= knee) want = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      else want = slope * over;
      gr = want > gr ? aA * gr + (1 - aA) * want : aR * gr + (1 - aR) * want;
      if (gr > maxGr) maxGr = gr;
      x[i] = v * (1 - mix) + v * dbToGain(-gr) * makeup * mix;
    }
    this.power = power; this.gr = gr;
    this.reduction = maxGr;
  }
}
