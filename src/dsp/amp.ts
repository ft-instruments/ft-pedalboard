// The amp: cascaded triode stages, the tone stack, and a push-pull power
// stage with sag, all at 8x.
//
// A triode stage here is: bias + signal into a lopsided curve (the grid
// conducts and flattens the positive side early; the negative side runs on
// to cutoff), inverted, through the next stage's coupling cap (high-pass) and
// the Miller capacitance (low-pass). When the grid conducts it charges the
// coupling cap and pulls the bias down for a few tens of milliseconds: that
// is the "blocking" that makes a cranked amp compress and bloom under the
// pick, and it is what a static waveshaper misses.
//
// The power stage's supply droops with the current drawn (sag): the ceiling
// comes down while you dig in and recovers as the note decays.

import { Oversampler, OS, OnePoleLP, OnePoleHP, Biquad, tanhf, dbToGain } from './util.ts';
import { ToneStack, STACK_FENDER, STACK_MARSHALL, STACK_TOPBOOST, STACK_TWEED, STACK_HIWATT, STACK_BOUTIQUE, type StackParts } from './tonestack.ts';

export const AMP_CLEAN = 0, AMP_CRUNCH = 1, AMP_LEAD = 2, AMP_CHIME = 3;
/** The second amp unit's channels follow the first's in the voicing table. */
export const AMP_TWEED = 4, AMP_HIWATT = 5, AMP_BOUTIQUE = 6;
/** The third amp unit's channels. */
export const AMP_BRIT = 7, AMP_RECTIFIED = 8, AMP_MODERN = 9;
/** The fourth. */
export const AMP_BLACKFACE = 10, AMP_CHAMP = 11, AMP_ORANGE = 12, AMP_BROWN = 13;
export const MAX_STAGES = 4;

const MAX_BLOCK = 512;

interface Voicing {
  stages: number;
  gainLo: number; gainHi: number;   // first-stage gain range across the knob
  inter: number;                    // gain between stages
  couple: number;                   // coupling high-pass, Hz
  miller: number;                   // per-stage low-pass, Hz
  stack: StackParts;
  stackMakeup: number;              // dB, the stack's insertion loss given back
  inHp: number;                     // input high-pass, Hz
  trim: number;                     // dB, output so the channels sit at similar levels
  classA: number;                   // power stage bias offset: 0 push-pull (odd harmonics), > 0 single-ended class A (even)
}

const VOICINGS: Voicing[] = [
  // clean: two stages and lots of headroom, the Bassman stack's scoop
  { stages: 2, gainLo: 1.2, gainHi: 22, inter: 1.6, couple: 25, miller: 14000, stack: STACK_FENDER, stackMakeup: 9, inHp: 40, trim: 5, classA: 0 },
  // crunch: three stages, the plexi stack, slightly tighter low end
  { stages: 3, gainLo: 2.5, gainHi: 70, inter: 2.4, couple: 60, miller: 10000, stack: STACK_MARSHALL, stackMakeup: 7, inHp: 70, trim: 0, classA: 0 },
  // lead: four stages with a cold, tight first stage and darker Miller poles
  { stages: 4, gainLo: 2, gainHi: 260, inter: 3.2, couple: 140, miller: 7500, stack: STACK_MARSHALL, stackMakeup: 7, inHp: 110, trim: -0.5, classA: 0 },
  // chime: two stages into the top-boost stack and a class A power stage that breaks up early and lopsided
  { stages: 2, gainLo: 2, gainHi: 60, inter: 2.2, couple: 45, miller: 13000, stack: STACK_TOPBOOST, stackMakeup: 7, inHp: 60, trim: 2, classA: 0.3 },
  // tweed: two stages, a single-ended class A power stage that compresses and goes lopsided early, a warm mid-forward voice
  { stages: 2, gainLo: 1.5, gainHi: 50, inter: 2.0, couple: 35, miller: 9500, stack: STACK_TWEED, stackMakeup: 7, inHp: 60, trim: 4, classA: 0.45 },
  // hi-watt: two stages and a nearly flat stack: tight, bright, a long way to breakup, so a pedal in front drives it
  { stages: 2, gainLo: 1, gainHi: 28, inter: 1.8, couple: 45, miller: 12000, stack: STACK_HIWATT, stackMakeup: 3, inHp: 60, trim: 5, classA: 0 },
  // boutique: three stages and a little class A: vocal mids, smooth compression, breaks up gradually
  { stages: 3, gainLo: 1, gainHi: 120, inter: 2.3, couple: 50, miller: 9000, stack: STACK_BOUTIQUE, stackMakeup: 5, inHp: 70, trim: 0.5, classA: 0.15 },
  // brit 800: three stages, the plexi stack with more gain on tap, a tight low end
  { stages: 3, gainLo: 1.5, gainHi: 140, inter: 2.6, couple: 90, miller: 8500, stack: STACK_MARSHALL, stackMakeup: 7, inHp: 90, trim: 0.5, classA: 0 },
  // rectified: four stages, the scooped stack, darker poles and a floppy supply (sag does the work)
  { stages: 4, gainLo: 0.8, gainHi: 320, inter: 3.4, couple: 160, miller: 6500, stack: STACK_FENDER, stackMakeup: 9, inHp: 120, trim: -1.5, classA: 0 },
  // modern: four stages with a very tight low end and bite in the upper mids
  { stages: 4, gainLo: 0.8, gainHi: 240, inter: 3.0, couple: 200, miller: 9000, stack: STACK_FENDER, stackMakeup: 9, inHp: 150, trim: -1, classA: 0 },
  // blackface: two stages and a huge amount of headroom, the scooped stack, a bright cap that fades as the gain comes up
  { stages: 2, gainLo: 0.8, gainHi: 12, inter: 1.5, couple: 22, miller: 15000, stack: STACK_FENDER, stackMakeup: 9, inHp: 40, trim: 9, classA: 0 },
  // champ: five watts, single-ended class A, a small dark speaker: it breaks up on the first note and compresses hard
  { stages: 2, gainLo: 1.5, gainHi: 40, inter: 1.5, couple: 30, miller: 7000, stack: STACK_TWEED, stackMakeup: 7, inHp: 80, trim: 6, classA: 0.5 },
  // orange: three stages, no scoop at all, thick low mids and a fuzzy, saturated top
  { stages: 3, gainLo: 0.8, gainHi: 130, inter: 2.5, couple: 45, miller: 7500, stack: STACK_HIWATT, stackMakeup: 4, inHp: 60, trim: 1, classA: 0.1 },
  // brown: a plexi on a variac: the supply is low, so it breaks up softly, compresses and sags. Turn the sag up.
  { stages: 3, gainLo: 1.5, gainHi: 90, inter: 2.4, couple: 70, miller: 10000, stack: STACK_MARSHALL, stackMakeup: 7, inHp: 70, trim: 0, classA: 0.2 },
];
/** Low shelf (dB) on the power stage's resonance, per voicing. */
const RESONANCE = [1.5, 3, 3, 1.5, 2, 3.5, 2.5, 3, 4.5, 2.5, 1.5, 1.5, 3, 3];

/** The triode's curve: grid conduction flattens the top at 1, cutoff the bottom at 1.6. */
export function triode(v: number): number { return v >= 0 ? tanhf(v) : 1.6 * tanhf(v * 0.625); }

export class Amp {
  private os: Oversampler;
  private up = new Float32Array(MAX_BLOCK * OS);
  private readonly fs: number;
  private readonly fsOs: number;
  private inHp: Biquad = new Biquad();
  private pre: Biquad = new Biquad();          // per-channel voicing ahead of the first stage
  private couple: OnePoleHP[] = [];
  private miller: OnePoleLP[] = [];
  private bias = new Float64Array(MAX_STAGES);
  readonly stack = new ToneStack();
  private xfmrLp: OnePoleLP;
  private xfmrHp: OnePoleHP;
  private presence: Biquad = new Biquad();
  private resonance: Biquad = new Biquad();
  private sagEnv = 0;
  private lastType = -1;
  private lastPres = -1;
  private lastGain = -1;
  /** For the UI: peak drive into each stage (1 = the knee), and into the power stage. */
  stageHeat = new Float32Array(MAX_STAGES + 1);
  /** For the UI: how far the supply sagged, 0..1. */
  sagDepth = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate; this.fsOs = sampleRate * OS;
    this.os = new Oversampler(sampleRate);
    for (let s = 0; s < MAX_STAGES; s++) {
      this.couple.push(new OnePoleHP(this.fsOs, 30));
      this.miller.push(new OnePoleLP(this.fsOs, 12000));
    }
    this.xfmrLp = new OnePoleLP(this.fsOs, 9000);
    this.xfmrHp = new OnePoleHP(this.fsOs, 55);
  }

  reset(): void {
    this.os.reset(); this.inHp.reset(); this.pre.reset(); this.stack.reset();
    for (let s = 0; s < MAX_STAGES; s++) { this.couple[s].reset(); this.miller[s].z = 0; this.bias[s] = 0; }
    this.xfmrLp.z = 0; this.xfmrHp.reset(); this.presence.reset(); this.resonance.reset(); this.sagEnv = 0;
  }

  private voice(type: number, gain: number): void {
    const v = VOICINGS[type];
    const fs = this.fs, fsOs = this.fsOs;
    if (type !== this.lastType) {
      this.reset();
      this.inHp.highpass(fs, v.inHp, 0.707);
      for (let s = 0; s < MAX_STAGES; s++) { this.couple[s].set(fsOs, v.couple); this.miller[s].set(fsOs, v.miller); }
      this.resonance.lowShelf(fs, 110, RESONANCE[type]);
    }
    if (type !== this.lastType || gain !== this.lastGain) {
      // the clean channel's bright cap fades out as the gain comes up; the
      // lead channel pushes the mids into the first stage
      if (type === AMP_CLEAN) this.pre.highShelf(fs, 2200, 6 * (1 - gain));
      else if (type === AMP_CRUNCH) this.pre.highShelf(fs, 2000, 3);
      else if (type === AMP_LEAD) this.pre.peak(fs, 750, 0.7, 5);
      else if (type === AMP_CHIME) this.pre.peak(fs, 2600, 0.8, 4);
      else if (type === AMP_TWEED) this.pre.peak(fs, 1700, 0.8, 3);
      else if (type === AMP_HIWATT) this.pre.highShelf(fs, 2500, 3);
      else if (type === AMP_BOUTIQUE) this.pre.peak(fs, 1000, 0.7, 5);
      else if (type === AMP_BRIT) this.pre.peak(fs, 1500, 0.8, 4);
      else if (type === AMP_RECTIFIED) this.pre.highShelf(fs, 3000, 2);
      else if (type === AMP_MODERN) this.pre.peak(fs, 2200, 0.7, 4);
      else if (type === AMP_BLACKFACE) this.pre.highShelf(fs, 2500, 1 + 4 * (1 - gain));
      else if (type === AMP_CHAMP) this.pre.peak(fs, 1500, 0.8, 3);
      else if (type === AMP_ORANGE) this.pre.peak(fs, 500, 0.7, 4);
      else this.pre.peak(fs, 1000, 0.7, 3);
    }
    this.lastType = type; this.lastGain = gain;
  }

  /**
   * In place, base rate. Knobs 0..1. `heat` multiplies the first stage's
   * gain (the rig's heat macro).
   */
  process(x: Float32Array, n: number, type: number, gain: number, bass: number, mid: number, treble: number,
    presence: number, master: number, sag: number, heat: number): void {
    this.voice(type, gain);
    const v = VOICINGS[type];
    if (presence !== this.lastPres) { this.presence.highShelf(this.fs, 3200, presence * 9 - 1); this.lastPres = presence; }
    this.stack.set(this.fsOs, v.stack, treble, mid, bass);
    for (let i = 0; i < n; i++) x[i] = this.pre.tick(this.inHp.tick(x[i]));

    const up = this.up, m = n * OS;
    this.os.upsample(x, up, n);
    const G = v.gainLo * Math.pow(v.gainHi / v.gainLo, gain) * heat;
    const stages = v.stages, inter = v.inter;
    const makeup = dbToGain(v.stackMakeup);
    const ab = v.classA, abOff = ab > 0 ? tanhf(ab) : 0;
    const P = 0.25 * Math.pow(24, master);             // drive into the power stage
    const charge = 1 - Math.exp(-1 / (0.001 * this.fsOs));
    const relax = 1 - Math.exp(-1 / (0.03 * this.fsOs));
    const sagAtk = 1 - Math.exp(-1 / (0.012 * this.fsOs));
    const sagRel = 1 - Math.exp(-1 / (0.15 * this.fsOs));
    const heatArr = this.stageHeat;
    heatArr.fill(0);
    const bias = this.bias, couple = this.couple, miller = this.miller;
    const stack = this.stack, xfmrLp = this.xfmrLp, xfmrHp = this.xfmrHp;
    let env = this.sagEnv, sagMin = 1;
    for (let i = 0; i < m; i++) {
      let s = up[i] * G;
      for (let k = 0; k < stages; k++) {
        const vg = s + bias[k];
        const a = Math.abs(vg); if (a > heatArr[k]) heatArr[k] = a;
        // grid current charges the coupling cap; it bleeds back off slowly
        const target = vg > 0.7 ? Math.max(-1.2, -0.35 * (vg - 0.7)) : 0;
        bias[k] += (target - bias[k]) * (target < bias[k] ? charge : relax);
        s = -triode(vg);
        s = miller[k].tick(couple[k].tick(s));
        if (k < stages - 1) s *= inter;
      }
      // tone stack, then the power stage on a sagging supply
      let u = stack.tick(s) * makeup * P;
      const supply = 1 - 0.45 * sag * env;
      if (supply < sagMin) sagMin = supply;
      const a = Math.abs(u) / supply; if (a > heatArr[MAX_STAGES]) heatArr[MAX_STAGES] = a;
      u = supply * (tanhf(u / supply + ab) - abOff);
      const au = Math.abs(u);
      env += (au - env) * (au > env ? sagAtk : sagRel);
      up[i] = xfmrHp.tick(xfmrLp.tick(u));
    }
    this.sagEnv = env;
    this.sagDepth = 1 - sagMin;
    this.os.downsample(up, x, n);
    // below clipping the master is a volume knob; keep the level roughly
    // where it was so it reads as "how hard the power tubes work"
    const out = dbToGain(v.trim) * 0.16 / Math.min(1, P * 0.6);
    const pres = this.presence, res = this.resonance;
    for (let i = 0; i < n; i++) x[i] = res.tick(pres.tick(x[i])) * out;
  }
}
