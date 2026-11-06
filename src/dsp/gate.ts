// Noise gate: a peak follower with hysteresis (opens at the threshold,
// closes 6 dB under it), a short hold so a decaying note isn't chopped
// mid-cycle, and a gain that opens in half a millisecond and closes over
// `release`.

import { dbToGain } from './util.ts';

export class Gate {
  private env = 0;
  private gain = 0;
  private open = false;
  private hold = 0;
  private readonly fs: number;
  /** For the UI: the follower's level and the gate's gain, last sample. */
  level = 0;
  reduction = 0;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.env = 0; this.gain = 0; this.open = false; this.hold = 0; }

  process(x: Float32Array, n: number, thrDb: number, release: number): void {
    const fs = this.fs;
    const thrOpen = dbToGain(thrDb), thrClose = thrOpen * 0.5;
    const envRel = Math.exp(-1 / (0.03 * fs));
    const gAtk = 1 - Math.exp(-1 / (0.0005 * fs));
    const gRel = 1 - Math.exp(-1 / (release * fs));
    const holdN = Math.round(0.02 * fs);
    let env = this.env, gain = this.gain, open = this.open, hold = this.hold;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      env = a > env ? a : env * envRel;
      if (env > thrOpen) { open = true; hold = holdN; }
      else if (env < thrClose) { if (hold > 0) hold--; else open = false; }
      gain += ((open ? 1 : 0) - gain) * (open ? gAtk : gRel);
      x[i] *= gain;
    }
    this.env = env; this.gain = gain; this.open = open; this.hold = hold;
    this.level = env; this.reduction = 1 - gain;
  }
}
