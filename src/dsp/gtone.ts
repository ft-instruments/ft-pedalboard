// The guitar's own tone and volume knobs, for the rack, as the circuit in a
// Strat: the pickup (6.5k, 2.6 H, 120 pF) into the cable's 600 pF, the 250k
// volume pot and the 250k audio-taper tone pot in series with 22 nF. The
// pickup, the capacitance and the load (and the coil's own eddy-current
// loss) make the resonant peak every single coil has (~4 kHz here); turning the tone down first loads that peak away
// (the pot's resistance damps it: a smooth, darker top from 10 down to ~3),
// and only near 0 does the capacitor take over, pulling the resonance down
// to ~650 Hz with a little peak of its own: the "honk" of a rolled-off neck
// pickup.
//
// The input is a DI: the pickup already through the guitar's own pots (at
// 10), the cable and an interface, so its peak is in it already. The unit
// applies only what the knobs change: the pickup node's response is
// (1 + s rt Ct) / D(s), D a cubic in s (coil, cable, tone cap), so the unit is
// D_ref(s) / D(s) times (1 + s rt Ct) / (1 + s rt_ref Ct), with ref = both
// knobs at 10: there it is exactly transparent. (It used to divide out a bare
// 1M and a short cable and then load the pickup with the pots and a long
// cable again: at 10/10 that was +1.2 dB at 5 kHz and -11 dB at 12 kHz.)
//
// The volume is the pot's divider (an audio taper) with a 1 nF treble bleed
// across its top half, then the cable against the pot's resistance: rolled
// back, the level drops more in the mids than the highs, so it cleans up
// without going dull. The engine also hands its resistance to a fuzz or a
// treble booster right after it, which load it (see drive.ts).

import { Biquad, Cubic, FirstOrder } from './util.ts';
import { PICKUP_R, PICKUP_L, PICKUP_CP, CABLE_C, DI_LOAD } from './pickup.ts';

const RP = PICKUP_R, LP = PICKUP_L, CP = PICKUP_CP, CC = CABLE_C, RV = 250e3, RT = 250e3, CT = 22e-9, RAMP = DI_LOAD;
/** The coil's eddy-current loss, as a resistance across it: what keeps a real pickup's peak to a Q of 2 or so. */
const R_EDDY = 150e3;
/** The treble bleed across the volume pot's top half. */
const CB = 1e-9;

/** The tone pot's resistance (audio taper; 300 ohm left at 0). */
function toneR(tone: number): number { return 300 + RT * (Math.pow(10, 2 * tone) - 1) / 99; }
/**
 * D(s) of the pickup node, (1 + s rt Ct)(1 + Z (s C + 1/rl)) + Z s Ct with Z = Rp + s L,
 * into d[0..3] (ascending powers of s).
 */
function denom(rt: number, rl: number, d: Float64Array): void {
  const C = CP + CC, t = rt * CT;
  d[0] = 1 + RP / rl;
  d[1] = RP * C + LP / rl + t * (1 + RP / rl) + RP * CT;
  d[2] = LP * C + t * (RP * C + LP / rl) + LP * CT;
  d[3] = t * LP * C;
}
/** The load on the pickup besides the tone branch: the volume pot, the amp through the pot's top, the eddy loss. */
function loadR(volume: number): number { const a = volume * volume, r1 = Math.max(1, (1 - a) * RV); return 1 / (1 / RV + 1 / (r1 + RAMP) + 1 / R_EDDY); }

export class GuitarTone {
  /** D_ref / D: the coil's resonance moving with the knobs. */
  private res = new Cubic();
  /** The tone branch's zero, (1 + s rt Ct) / (1 + s rt_ref Ct). */
  private zero = new FirstOrder();
  /** The volume pot with its bleed, then the cable. */
  private vol = new Biquad();
  private dRef = new Float64Array(4); private d = new Float64Array(4);
  private lastTone = -1; private lastVol = -1;
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    denom(toneR(1), loadR(1), this.dRef);
  }

  reset(): void { this.res.reset(); this.zero.reset(); this.vol.reset(); }

  private set(tone: number, volume: number): void {
    const rt = toneR(tone), ref = this.dRef, d = this.d;
    denom(rt, loadR(volume), d);
    this.res.set(this.fs, ref[0], ref[1], ref[2], ref[3], d[0], d[1], d[2], d[3]);
    this.zero.set(this.fs, 1, rt * CT, 1, toneR(1) * CT);
    // the volume: a (1 + s R1 Cb) / (1 + s (R1 || R2) Cb), then the cable against R1 || R2
    const a = volume * volume, r1 = Math.max(1, (1 - a) * RV), r2 = Math.max(1, a * RV);
    const rth = r1 * r2 / (r1 + r2), t1 = r1 * CB, t2 = rth * CB, tc = rth * CC;
    // (1 + s t1) / ((1 + s t2)(1 + s tc)) times a
    this.vol = bilinear2(this.fs, 0, t1 * a, a, t2 * tc, t2 + tc, 1, this.vol);
  }

  process(x: Float32Array, n: number, tone: number, volume: number): void {
    if (tone !== this.lastTone || volume !== this.lastVol) { this.set(tone, volume); this.lastTone = tone; this.lastVol = volume; }
    const res = this.res, zero = this.zero, vol = this.vol;
    for (let i = 0; i < n; i++) x[i] = vol.tick(zero.tick(res.tick(x[i])));
  }
}

/** (b2 s^2 + b1 s + b0) / (a2 s^2 + a1 s + a0) through the bilinear transform, into `q` (keeping its state). */
export function bilinear2(fs: number, b2: number, b1: number, b0: number, a2: number, a1: number, a0: number, q: Biquad = new Biquad()): Biquad {
  const c = 2 * fs, c2 = c * c;
  const A0 = a2 * c2 + a1 * c + a0;
  q.b0 = (b2 * c2 + b1 * c + b0) / A0; q.b1 = (2 * b0 - 2 * b2 * c2) / A0; q.b2 = (b2 * c2 - b1 * c + b0) / A0;
  q.a1 = (2 * a0 - 2 * a2 * c2) / A0; q.a2 = (a2 * c2 - a1 * c + a0) / A0;
  return q;
}
