// Five-band equaliser: shelves at 100 Hz and 6 kHz, three bell bands
// between, ±12 dB each, and an output level. Coefficients are only
// recomputed when a knob moves.

import { Biquad, dbToGain } from './util.ts';

export const EQ_BANDS = 5;
export const EQ_FREQ = [100, 400, 1000, 2500, 6000];
const Q = 0.9;

export class Eq {
  readonly bands: Biquad[] = [];
  private gains = new Float64Array(EQ_BANDS);
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    for (let b = 0; b < EQ_BANDS; b++) { this.bands.push(new Biquad()); this.gains[b] = NaN; }
  }

  reset(): void { for (const b of this.bands) b.reset(); }

  /** Band gains in dB, low to high. */
  set(g0: number, g1: number, g2: number, g3: number, g4: number): void {
    this.band(0, g0); this.band(1, g1); this.band(2, g2); this.band(3, g3); this.band(4, g4);
  }

  private band(b: number, db: number): void {
    if (db === this.gains[b]) return;
    this.gains[b] = db;
    const f = this.bands[b];
    if (b === 0) f.lowShelf(this.fs, EQ_FREQ[b], db);
    else if (b === EQ_BANDS - 1) f.highShelf(this.fs, EQ_FREQ[b], db);
    else f.peak(this.fs, EQ_FREQ[b], Q, db);
  }

  process(x: Float32Array, n: number, levelDb: number): void {
    const out = dbToGain(levelDb);
    const b0 = this.bands[0], b1 = this.bands[1], b2 = this.bands[2], b3 = this.bands[3], b4 = this.bands[4];
    for (let i = 0; i < n; i++) x[i] = b4.tick(b3.tick(b2.tick(b1.tick(b0.tick(x[i]))))) * out;
  }

  /** |H| at `f` Hz, for the picture. */
  mag(f: number): number {
    let m = 1;
    for (const b of this.bands) m *= b.mag(this.fs, f);
    return m;
  }
}
