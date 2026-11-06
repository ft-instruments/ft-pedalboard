// The guitar's own tone and volume knobs, for the rack: a passive tone
// control is a low-pass whose corner falls as the knob comes back (500 Hz
// at 0, ~7 kHz at 10) with a little resonance, as the pickup's inductance
// and the tone capacitor make; the volume is an audio taper, and the highs
// are bled back in a little as it comes down so a rolled-back volume
// cleans up instead of going dull. Put it first in the rack.

import { Biquad, OnePoleHP } from './util.ts';

export class GuitarTone {
  private lp = new Biquad();
  private bleed: OnePoleHP;
  private lastTone = -1;
  private readonly fs: number;

  constructor(sampleRate: number) { this.fs = sampleRate; this.bleed = new OnePoleHP(sampleRate, 2500); }

  reset(): void { this.lp.reset(); this.bleed.reset(); }

  process(x: Float32Array, n: number, tone: number, volume: number): void {
    if (tone !== this.lastTone) { this.lp.lowpass(this.fs, 500 * Math.pow(14, tone), 0.5 + 0.5 * tone); this.lastTone = tone; }
    const g = volume * volume, bleed = (1 - g) * 0.3;
    for (let i = 0; i < n; i++) {
      const v = this.lp.tick(x[i]);
      x[i] = v * g + this.bleed.tick(v) * bleed;
    }
  }
}
