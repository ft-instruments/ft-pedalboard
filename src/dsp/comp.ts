// The compressor pedal ("squeeze"): a feed-forward peak follower with
// separate attack and release, one knob (sustain) that lowers the threshold
// and raises the ratio together, automatic make-up so a DI-level note comes
// out about as loud as it went in, and a blend with the dry signal for
// parallel compression that keeps the pick attack.

import { dbToGain } from './util.ts';

/** Peak level of a DI guitar the make-up gain aims at, dB (a passive pickup peaks around -14 dBV). */
const DI_PEAK_DB = -14;
const MAX_MAKEUP_DB = 18;

export class Comp {
  private env = 0;
  private readonly fs: number;
  /** For the UI: gain reduction over the last block, dB (positive). */
  reduction = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.env = 0; this.reduction = 0; }

  process(x: Float32Array, n: number, sustain: number, attack: number, release: number, levelDb: number, blend: number): void {
    const fs = this.fs;
    const thrDb = -12 - 30 * sustain;
    const ratio = 2 + 8 * sustain;
    const slope = 1 / ratio - 1;
    const thr = dbToGain(thrDb);
    const makeupDb = Math.min(MAX_MAKEUP_DB, Math.max(0, -thrDb + DI_PEAK_DB) * (1 - 1 / ratio));
    const wet = dbToGain(makeupDb + levelDb) * blend;
    const dry = (1 - blend) * dbToGain(levelDb);
    const atk = 1 - Math.exp(-1 / (attack * fs));
    const rel = 1 - Math.exp(-1 / (release * fs));
    let env = this.env, minG = 1;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const a = Math.abs(v);
      env += (a - env) * (a > env ? atk : rel);
      const g = env > thr ? Math.exp(slope * Math.log(env / thr)) : 1;
      if (g < minG) minG = g;
      x[i] = v * (g * wet + dry);
    }
    this.env = env;
    this.reduction = -20 * Math.log10(minG);
  }
}
