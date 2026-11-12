// The compressor pedal ("squeeze"): one knob (sustain) that lowers the
// threshold and raises the ratio together, automatic make-up so a DI-level
// note comes out about as loud as it went in, and a blend with the dry
// signal for parallel compression that keeps the pick attack.
//
// Feed-forward, worked in decibels after Giannoulis, Massberg & Reiss,
// "Digital dynamic range compressor design: a tutorial and analysis" (JAES
// 60(6), 2012): the gain computer has a 10 dB soft knee (the squeeze comes
// in gradually, as an OTA or a photocell does, instead of at a corner), and
// the gain reduction it asks for goes through their smooth decoupled peak
// detector: a release-held peak, then the attack smoothing. Attack is the
// time the pick gets before the gain comes down, so a slow attack lets it
// through and a fast one squashes it. The release is program dependent like
// an optical cell's: after a long, heavy squeeze it lets go up to three
// times slower (the LA-2A's two-stage recovery), so held chords don't pump
// while short stabs still recover quickly.

import { dbToGain } from './util.ts';

/** Peak level of a DI guitar the make-up gain aims at, dB (a passive pickup peaks around -14 dBV). */
const DI_PEAK_DB = -14;
const MAX_MAKEUP_DB = 18;
/** The detector reads instantaneous peaks; the threshold is set for the average level of a guitar, this far under them. */
const PEAK_DB = 6;
/** Width of the soft knee, dB. */
const KNEE_DB = 10;
/** How fast the cell's memory of heavy compression builds and fades, seconds; and how many dB count as heavy. */
const MEMORY_S = 1.5, HEAVY_DB = 10;
/** The detector holds its peak this long before releasing (two periods of 80 Hz: a fast release doesn't follow the waveform of a low note). */
const HOLD_S = 0.025;

export class Comp {
  private peak = 0;      // the release-held gain reduction, dB
  private gr = 0;        // after the attack smoothing, dB
  private memory = 0;    // 0..1: how long and hard it has been squeezing
  private hold = 0;      // samples left before the held peak may release
  private readonly fs: number;
  /** For the UI: gain reduction over the last block, dB (positive). */
  reduction = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.peak = 0; this.gr = 0; this.memory = 0; this.hold = 0; this.reduction = 0; }

  process(x: Float32Array, n: number, sustain: number, attack: number, release: number, levelDb: number, blend: number): void {
    const fs = this.fs;
    const thrDb = -12 - 30 * sustain;
    const ratio = 2 + 8 * sustain;
    const slope = 1 - 1 / ratio;
    const makeupDb = Math.min(MAX_MAKEUP_DB, Math.max(0, -thrDb + DI_PEAK_DB) * (1 - 1 / ratio));
    const wet = dbToGain(makeupDb + levelDb) * blend;
    const dry = (1 - blend) * dbToGain(levelDb);
    const aA = Math.exp(-1 / (attack * fs));
    const relK = -1 / (release * fs);
    const memK = 1 - Math.exp(-1 / (MEMORY_S * fs));
    const half = KNEE_DB / 2, k2 = slope / (2 * KNEE_DB);
    const holdN = Math.round(HOLD_S * fs);
    let peak = this.peak, gr = this.gr, mem = this.memory, hold = this.hold, maxGr = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      // the gain computer: how many dB this sample is over the knee
      const over = 20 * Math.log10(Math.abs(v) + 1e-9) - thrDb - PEAK_DB;
      const want = over <= -half ? 0 : over >= half ? slope * over : k2 * (over + half) * (over + half);
      // a held peak (a new peak within half a dB of it renews the hold), then the release (slower the more it has been working), then the attack
      if (want > peak - 0.5) hold = holdN;
      if (want > peak) peak = want;
      else if (hold > 0) hold--;
      else { const aR = Math.exp(relK / (1 + 2 * mem)); peak = aR * peak + (1 - aR) * want; }
      gr = aA * gr + (1 - aA) * peak;
      mem += ((gr > HEAVY_DB ? 1 : gr / HEAVY_DB) - mem) * memK;
      if (gr > maxGr) maxGr = gr;
      x[i] = v * (dbToGain(-gr) * wet + dry);
    }
    this.peak = peak; this.gr = gr; this.memory = mem; this.hold = hold;
    this.reduction = maxGr;
  }
}
