// The speaker cabinet and the mic in front of it, as a fixed chain of seven
// biquads per cabinet: the cone's low resonance (closed backs thump, open
// backs leak bass), the cone break-up peaks, the dip where the front and
// back waves cancel, and the steep top end of a guitar speaker. The mic
// slides from the dust cap (bright, forward) to the cone's edge (darker, the
// presence peak eaten). No impulse responses: these are drawn from published
// speaker curves, and a loader for measured IRs can sit beside it later.

import { Biquad } from './util.ts';

const N = 7;

// type, f, q, dB per section. 'h' high-pass, 'l' low-pass, 'p' peak.
type Sec = [string, number, number, number];
const CABS: Sec[][] = [
  // 1x12 open back: lighter low end, airy, a little honk
  [['h', 85, 0.75, 0], ['p', 140, 1.4, 2], ['p', 650, 1.2, -2.5], ['p', 1500, 1.4, 2.5], ['p', 2800, 2.2, 4], ['l', 5600, 0.9, 0], ['l', 7200, 0.6, 0]],
  // 2x12 closed: rounder, even
  [['h', 72, 1.0, 0], ['p', 115, 1.5, 3.5], ['p', 500, 1.0, -3], ['p', 1900, 1.2, 2.5], ['p', 3400, 2.4, 4.5], ['l', 5000, 0.85, 0], ['l', 6600, 0.6, 0]],
  // 4x12 closed: the thump at 100 Hz, scooped low mids, a hard presence peak
  [['h', 62, 1.25, 0], ['p', 100, 2.0, 6], ['p', 420, 1.0, -4], ['p', 1700, 1.4, 2], ['p', 3000, 2.6, 5.5], ['l', 4500, 0.9, 0], ['l', 6000, 0.6, 0]],
  // 2x12 alnico blue: open-ish back, a loose low end and the bright upper-mid bark
  [['h', 78, 0.9, 0], ['p', 125, 1.3, 2.5], ['p', 600, 1.1, -2], ['p', 1600, 1.4, 1.5], ['p', 3800, 2.0, 5], ['l', 6200, 0.85, 0], ['l', 7800, 0.6, 0]],
  // 4x12 greenback: a fat 110 Hz, the low mids carved, a creamy 1.8 kHz and a top that falls off early
  [['h', 70, 1.0, 0], ['p', 110, 1.6, 4], ['p', 450, 1.0, -3], ['p', 1800, 1.3, 3], ['p', 3000, 2.0, 3.5], ['l', 4800, 0.85, 0], ['l', 6200, 0.6, 0]],
  // 1x12 tweed: a small box, honk at 700 Hz, no real bottom end
  [['h', 95, 0.8, 0], ['p', 160, 1.4, 2.5], ['p', 700, 1.0, 2], ['p', 1400, 1.3, -1.5], ['p', 2600, 1.8, 3], ['l', 4800, 0.8, 0], ['l', 6800, 0.6, 0]],
  // 4x12 v30: tight bottom, the low mids scooped, a hard bite at 3.4 kHz
  [['h', 75, 1.1, 0], ['p', 105, 1.8, 4], ['p', 380, 1.0, -4.5], ['p', 1500, 1.3, 1.5], ['p', 3400, 2.2, 6], ['l', 5200, 0.9, 0], ['l', 6800, 0.6, 0]],
  // 4x10 blackface: open-ish back, a glassy top, a deep-ish bottom
  [['h', 80, 0.9, 0], ['p', 130, 1.3, 2.5], ['p', 500, 1.0, -2.5], ['p', 1200, 1.2, 1.5], ['p', 3200, 1.8, 4], ['l', 6500, 0.8, 0], ['l', 8200, 0.6, 0]],
  // 1x8: a small cone, punchy at 190 Hz and nothing below it
  [['h', 130, 0.9, 0], ['p', 190, 1.4, 3], ['p', 900, 1.0, 2], ['p', 1800, 1.4, -1], ['p', 3000, 1.8, 3], ['l', 4300, 0.8, 0], ['l', 6000, 0.6, 0]],
];
export const NCABS = CABS.length;

export class Cab {
  readonly secs: Biquad[] = [];
  private curType = -1; private curMic = -1;
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    for (let i = 0; i < N; i++) this.secs.push(new Biquad());
  }

  reset(): void { for (const s of this.secs) s.reset(); }

  /** Coefficients for a cabinet and a mic position (0 = dust cap, 1 = cone edge). */
  set(type: number, mic: number): void {
    if (type === this.curType && mic === this.curMic) return;
    this.curType = type; this.curMic = mic;
    const fs = this.fs, cab = CABS[Math.max(0, Math.min(CABS.length - 1, type))];
    const dark = Math.pow(0.6, mic);      // the top end moves down an octave and a bit, towards the edge
    for (let i = 0; i < N; i++) {
      const [t, f, q, db] = cab[i];
      const s = this.secs[i];
      if (t === 'h') s.highpass(fs, f, q);
      else if (t === 'l') s.lowpass(fs, f * (0.75 + 0.5 * dark), q);
      else if (f > 2000) s.peak(fs, f * (0.85 + 0.15 * dark), q, db * (1.3 - mic));   // the presence peak fades off-axis
      else s.peak(fs, f, q, db);
    }
  }

  process(x: Float32Array, n: number, type: number, mic: number): void {
    this.set(type, mic);
    const s = this.secs;
    for (let i = 0; i < n; i++) {
      let v = x[i];
      for (let k = 0; k < N; k++) v = s[k].tick(v);
      x[i] = v;
    }
  }

  /** |H| at `f` Hz, for the cabinet's picture. */
  mag(f: number): number {
    let m = 1;
    for (const s of this.secs) m *= s.mag(this.fs, f);
    return m;
  }
}

/**
 * The cabinet's low cut and high cut, after the speaker: a second-order
 * high-pass and a fourth-order low-pass, the way a cab sim's two filters
 * are. `lo` at or under 21 Hz and `hi` at or over 11.9 kHz mean off.
 */
export class CabCut {
  private hp = new Biquad(); private lp1 = new Biquad(); private lp2 = new Biquad();
  private curLo = -1; private curHi = -1; private active = false;
  private readonly fs: number;

  constructor(sampleRate: number) { this.fs = sampleRate; }

  reset(): void { this.hp.reset(); this.lp1.reset(); this.lp2.reset(); }

  process(x: Float32Array, n: number, lo: number, hi: number): void {
    const useLo = lo > 21, useHi = hi < 11900;
    if (!useLo && !useHi) { this.active = false; return; }
    if (!this.active) { this.reset(); this.active = true; this.curLo = -1; this.curHi = -1; }
    if (lo !== this.curLo) { this.curLo = lo; if (useLo) this.hp.highpass(this.fs, lo, 0.707); else this.hp.bypass(); }
    if (hi !== this.curHi) {
      this.curHi = hi;
      if (useHi) { this.lp1.lowpass(this.fs, hi, 0.5412); this.lp2.lowpass(this.fs, hi, 1.3066); } else { this.lp1.bypass(); this.lp2.bypass(); }
    }
    for (let i = 0; i < n; i++) x[i] = this.lp2.tick(this.lp1.tick(this.hp.tick(x[i])));
  }
}
