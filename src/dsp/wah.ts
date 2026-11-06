// The wah: a resonant band-pass whose centre moves from 350 Hz (heel down)
// to 2.3 kHz (toe down), set by hand (`pos`) and/or pushed up by the pick
// (`auto`: an envelope follower, fast up and slow down). The coefficients
// are refreshed every 32 samples. A little dry signal stays in so the
// guitar keeps its body, as on the real pedal.

import { Biquad, dbToGain } from './util.ts';

const STEP = 32;

export class Wah {
  private bp = new Biquad();
  private env = 0;
  private readonly fs: number;
  /** Where the sweep is now, 0..1, for the picture. */
  pos = 0.5;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.bp.reset(); this.env = 0; }

  process(x: Float32Array, n: number, pos: number, auto: number, reson: number, levelDb: number): void {
    const fs = this.fs;
    const atk = 1 - Math.exp(-1 / (0.004 * fs)), rel = 1 - Math.exp(-1 / (0.12 * fs));
    const q = 2 + 6 * reson, out = dbToGain(levelDb);
    let env = this.env, cur = this.pos;
    for (let i0 = 0; i0 < n; i0 += STEP) {
      const m = Math.min(STEP, n - i0);
      cur = Math.min(1, Math.max(0, pos + auto * Math.min(1, env * 5)));
      this.bp.bandpass(fs, 350 * Math.pow(2300 / 350, cur), q);
      for (let i = i0; i < i0 + m; i++) {
        const v = x[i];
        const a = Math.abs(v);
        env += (a - env) * (a > env ? atk : rel);
        x[i] = (this.bp.tick(v) * 1.4 + v * 0.3) * out;
      }
    }
    this.env = env; this.pos = cur;
  }
}
