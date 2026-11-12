// The amp: the preamp stage by stage as the real circuits are built, the
// tone stack where the amp has it, and the power stage with its speaker
// load, feedback and sag, all at 8x.
//
// Each preamp stage is a 12AX7 common-cathode stage on its load line (the
// tables in tube.ts): lopsided, so a clean stage makes mostly second
// harmonic, with a firm knee where the grid conducts and a soft one at
// cutoff. Around it sits what the schematic has:
// - the coupling cap into its grid with the real values (0.022 uF into ~1M:
//   a 7 Hz corner, "<0.1 dB loss at 82 Hz", ampbooks). When the grid
//   conducts, the grid current charges it and pulls the bias down; the leak
//   lets it back with C x R (~22 ms), the "blocking" that makes a cranked amp
//   compress and bloom after the pick (Aiken);
// - the divider in front of the grid: the gain or volume pot (with its
//   bright cap across the top: strong at low settings, gone at full) and the
//   treble-bleed dividers (470k with 470 pF in a JCM800, 470k with 2000 pF in
//   a Soldano) that drop the bass while the highs pass;
// - the Miller pole: the grid's input capacitance, Cgk + Cga (A + 1),
//   against what drives it (the stopper and the pot's own resistance, so it
//   moves with the knob, Blencowe);
// - the cathode: an unbypassed stage rides on its current (the table); a
//   bypassed one has its real bypass cap as a state, so a partly bypassed
//   stage (2.7k with 0.68 uF: 87 Hz) shelves the bass by its local feedback
//   and remembers the bias it was pushed to (Pakarinen & Yeh: the bypass cap
//   "retains memory of the tube bias");
// - a plate cap where the amp has one (the Soldano's colder stage: 1000 pF on
//   100k, from 1.6 kHz), so the treble is cut between clipping stages;
// - the DC-coupled cathode follower that drives the stack in the British and
//   high-gain amps, with its own grid-current clipping.
// The tightness of a high-gain amp is therefore a set of shelves (about
// -16 dB at 82 Hz into a Soldano's fourth stage, flattening below), not a
// stack of high-passes, and the bass comes back after the clipping through
// the stack and the speaker.
//
// The power stage is a table (tube.ts): phase inverter, push-pull (or
// single-ended) output tubes and the negative feedback around them. In front
// of it, inside the loop, the speaker load: the tubes' plate resistance,
// reflected through the transformer, against the selected cabinet's
// impedance (cab.ts SPEAKERS: the voice coil plus the resonance in its box),
// with the feedback lowering the output impedance by (1 + loop gain). So a
// no-feedback amp gets the +8-10 dB at the speaker's resonance and the
// rising top that the dossier computes for a V30, a Marshall-type a few dB,
// and the power tubes clip on that response (more bass current, more sag).
// Presence takes feedback away above ~3 kHz. The supply sags with the
// current drawn. The output transformer's primary inductance is the 55 Hz
// high-pass, and its core saturates (Pakarinen & Yeh, CMJ 33(2), 2009).

import { Oversampler, osFactor, OS, AMP_RATE, OnePoleLP, Biquad, FirstOrder, Cubic, dbToGain } from './util.ts';
import { StageTable, STAGE_KINDS, TUBE_LO, TUBE_INV, FollowerTable, CF_LO, CF_INV, PowerTable, PA_R, PA_INV, tableAt, tableInt, ADAA_EPS, type PowerParts } from './tube.ts';
import {
  ToneStack, STACK_BASSMAN, STACK_JCM800, STACK_PLEXI, STACK_SOLDANO, STACK_BLACKFACE, STACK_MESA, STACK_TOPBOOST, STACK_HIWATT, STACK_ORANGE,
  type StackParts,
} from './tonestack.ts';
import { SPEAKERS } from './cab.ts';

export const AMP_CLEAN = 0, AMP_CRUNCH = 1, AMP_LEAD = 2, AMP_CHIME = 3;
/** The second amp unit's channels follow the first's in the voicing table. */
export const AMP_TWEED = 4, AMP_HIWATT = 5, AMP_BOUTIQUE = 6;
/** The third amp unit's channels. */
export const AMP_BRIT = 7, AMP_RECTIFIED = 8, AMP_MODERN = 9;
/** The fourth. */
export const AMP_BLACKFACE = 10, AMP_CHAMP = 11, AMP_ORANGE = 12, AMP_BROWN = 13;
export const MAX_STAGES = 4;

const MAX_BLOCK = 512;
/** The output transformer: its primary against the tubes' plate resistance is a 55 Hz high-pass (rad/s), and the flux (volt-seconds, output units) at which the core's magnetising current has doubled. */
const XFMR_A = 2 * Math.PI * 55, XFMR_SAT = 1 / 0.0035;
/** Output resistance of a 12AX7 plate on 100k (Rp || ra), what a plate-driven stack sees; a cathode follower's. */
const RS_PLATE = 38e3, RS_CF = 600;
/** Input capacitance of a 12AX7 grid: Cgk + Cga (A + 1) (ECC83: 1.6 pF each) plus wiring. */
const C_GK = 1.6e-12, C_GA = 1.6e-12, C_WIRE = 10e-12;

/** The preamp stage kinds (STAGE_KINDS in tube.ts). */
const K_HOT = 0, K_UNBY = 1, K_BRIT = 2, K_COLD = 3, K_SLOCOLD = 4, K_SLO1 = 5, K_SLO2 = 6, K_SLO4 = 7, K_MARSHALL = 8, K_AC30 = 9, K_12AY7 = 10;
/** What the presence knob is on a voicing: nothing (the amp has none), feedback taken away above ~3 kHz, or the AC30's Cut. */
export const PRES_NONE = 0, PRES_NFB = 1, PRES_CUT = 2;
/** The AC30's Cut: a 250k log pot and 4.7 nF across the phase inverter's outputs (Pitman, via the ampgarage / tdpri threads), against the inverter's ~70k differential output resistance [inference: 2 x (82k || rp)]; the pot as a rheostat whose resistance falls fast at the end of the cut's travel [inference: the wiring was not found]. */
const CUT_R = 250e3, CUT_C = 4.7e-9, CUT_RS = 70e3;
/** The master: an audio-taper pot, -40 dB at 0 (it never quite reaches silence here, so its level can be made up). */
export const masterPot = (m: number): number => 0.01 * Math.pow(100, m);
/** Plate volts at the end of the preamp to the output level (before the trim): the amp's output below clipping follows the preamp, whatever the master. */
const OUT_REF = 0.004;

interface Stage {
  kind: number;
  /** Cathode bypass cap (F); 0 on an unbypassed kind. */
  ck: number;
  /** Coupling cap into this grid (F); 0 = none (the input jack, or the tone stack's own caps couple it). */
  cc: number;
  /** In front of the grid: r1 (with c1 across it) in series, into r2 to ground. r2 is the gain or volume pot when `pot`, with `cb` across its top section. */
  r1: number; c1: number; r2: number; pot: boolean; cb: number;
  /** Grid stopper (ohms). */
  stop: number;
  /** Plate cap corner (Hz), 0 none. */
  cp: number;
}
const st = (kind: number, ck: number, o: Partial<Stage> = {}): Stage =>
  ({ kind, ck, cc: 22e-9, r1: 0, c1: 0, r2: 1e6, pot: false, cb: 0, stop: 10e3, cp: 0, ...o });
/** The first stage: straight from the input jack (1M to ground, the two 68k stoppers in parallel). */
const first = (kind: number, ck: number): Stage => st(kind, ck, { cc: 0, r2: 0, stop: 34e3 });

interface Voicing {
  stages: Stage[];
  /** The gain pot's wiper across the knob (audio taper: potLo at 0, 1 at full). */
  potLo: number;
  /** How many stages come before the tone stack (Fender: 1; most: all). */
  stackAt: number;
  /** A cathode follower drives the stack (else the plate does). */
  cf: boolean;
  stack: StackParts;
  trim: number;                     // dB, output so the channels sit at similar levels
  follow: number;                   // 0..1: how much of the gain knob's level change the output takes back (around noon)
  /** The output tubes' grid bias (volts): the grid swing that takes them to full power. */
  bias: number;
  /** The phase inverter's gain from its input to one output grid (long-tail pair ~29 per side, cathodyne ~0.9, none 1). */
  gpi: number;
  /** The amp has a master volume (else the master knob sits at full by default, as the real amp is). */
  mv: boolean;
  /** PRES_NONE, PRES_NFB or PRES_CUT. */
  pres: number;
  power: PowerParts;
}

// power stages: `zp` is the output tubes' plate resistance seen from the 8 ohm tap (pentodes: tens of ohms)
/** EL34s, fixed bias, feedback with presence (plexi, JCM). */
const PP_EL34: PowerParts = { se: false, cut: 0.5, nfb: 1.6, imb: 0.03, pi: 1.8, knee: 3, zp: 25 };
/** 6L6s, lots of feedback, a big supply (blackface, Bassman). */
const PP_6L6: PowerParts = { se: false, cut: 0.6, nfb: 2.5, imb: 0.02, pi: 2.2, knee: 3, zp: 25 };
/** Hiwatt: EL34s, heavy feedback, a stiff supply and a firm ceiling. */
const PP_HW: PowerParts = { se: false, cut: 0.55, nfb: 3.5, imb: 0.015, pi: 2.4, knee: 4, zp: 25 };
/** EL84s, cathode biased and hot, no feedback (the AC30). */
const PP_EL84: PowerParts = { se: false, cut: 0.85, nfb: 0, imb: 0.06, pi: 1.5, knee: 2, zp: 25 };
/** 6V6s, cathode biased, no feedback (5E3 tweed). */
const PP_6V6: PowerParts = { se: false, cut: 0.75, nfb: 0, imb: 0.08, pi: 1.4, knee: 2, zp: 25 };
/** One 6V6, class A (5F1 champ). */
const SE_6V6: PowerParts = { se: true, cut: 1, nfb: 0.4, imb: 0, pi: 1.6, knee: 2, zp: 40 };
/** Class A EL84s with a little feedback (the boutique combo). */
const PP_BOUT: PowerParts = { se: false, cut: 0.85, nfb: 0.5, imb: 0.05, pi: 1.6, knee: 2.5, zp: 25 };
/** 6L6s/EL34s in a modern high-gain head: feedback, a firm ceiling. */
const PP_MODERN: PowerParts = { se: false, cut: 0.5, nfb: 2, imb: 0.02, pi: 2, knee: 3, zp: 25 };
/** Orange: EL34s, little feedback. */
const PP_ORANGE: PowerParts = { se: false, cut: 0.6, nfb: 0.8, imb: 0.04, pi: 1.6, knee: 2.5, zp: 25 };
/** A plexi on a variac: the plates run low, so it bends early and softly. */
const PP_BROWN: PowerParts = { se: false, cut: 0.6, nfb: 1.2, imb: 0.04, pi: 1.5, knee: 2, zp: 25 };

/**
 * The tweed and the champ have a single tone knob (or none), not the Bassman stack that stands in for one; the
 * stand-in's 16.4 dB loss at noon (on a plate, 1 kHz) is not in the real amps, so their inverter gain takes it back.
 */
const STANDIN = 6.6;

// The Marshall bright channel's way into V2a: 0.022 uF, the 470k mixer with its 470 pF "treble peaker" (Robinette), the 1M volume.
const marshallV2 = (o: Partial<Stage> = {}): Stage => st(K_MARSHALL, 0.68e-6, { r1: 470e3, c1: 470e-12, r2: 1e6, pot: true, ...o });

export const VOICINGS: Voicing[] = [
  // clean: the Fender layout (AB763 Twin): V1, the stack on its plate (250 pF treble cap: Yeh Fig 2.4, Robinette; 120 pF is the
  // bright cap's value), the volume (its bright switch off), V2; 6L6s on -52 V, a 12AT7 long-tail pair, feedback, no presence
  { stages: [first(K_HOT, 25e-6), st(K_HOT, 25e-6, { cc: 0, pot: true })], potLo: 0.04, stackAt: 1, cf: false, stack: STACK_BLACKFACE, trim: 9.7, follow: 0.3, bias: 52, gpi: 27, mv: false, pres: PRES_NONE, power: PP_6L6 },
  // crunch: the 1987 plexi's bright channel: V1 on 2.7k / 0.68 uF ("almost 7 dB of bass cut"), the volume, V2a on 820 / 0.68 uF, the cathode follower, the stack
  { stages: [first(K_BRIT, 0.68e-6), marshallV2()], potLo: 0.02, stackAt: 2, cf: true, stack: STACK_PLEXI, trim: 8.8, follow: 0, bias: 38, gpi: 29, mv: false, pres: PRES_NFB, power: PP_EL34 },
  // lead: the same with two more stages behind the volume, the first of them cold (10k unbypassed), each through 470k / 470k
  { stages: [first(K_BRIT, 0.68e-6), marshallV2(), st(K_COLD, 0, { r1: 470e3, r2: 470e3 }), st(K_MARSHALL, 0.68e-6, { r1: 470e3, r2: 470e3 })],
    potLo: 0.005, stackAt: 4, cf: true, stack: STACK_PLEXI, trim: 8.7, follow: 0, bias: 38, gpi: 29, mv: true, pres: PRES_NFB, power: PP_EL34 },
  // chime: the AC30 top boost: V1 on 220k / 1.5k / 25 uF, the bright channel's small coupling cap (250 pF into the 1M volume: down ~18 dB at
  // 82 Hz, ~2 at the mids, ampbooks) with the 100 pF bright cap, the unbypassed second stage, the cathode follower into the top boost; EL84s, no feedback
  { stages: [first(K_AC30, 25e-6), st(K_UNBY, 0, { cc: 250e-12, pot: true, cb: 100e-12 })], potLo: 0.03, stackAt: 2, cf: true, stack: STACK_TOPBOOST, trim: 27.9, follow: 0.3, bias: 10, gpi: 29, mv: false, pres: PRES_CUT, power: PP_EL84 },
  // tweed: the 5E3: a 12AY7 first stage (ampbooks), the volume, the second stage, the stack (a Bassman's, standing in for the 5E3's
  // single tone knob) on the plate; a cathodyne into 6V6s on -20.5 V, no feedback, no presence
  { stages: [first(K_12AY7, 25e-6), st(K_HOT, 25e-6, { pot: true })], potLo: 0.03, stackAt: 2, cf: false, stack: STACK_BASSMAN, trim: 13.7, follow: 0.3, bias: 20.5, gpi: 0.9 * STANDIN, mv: false, pres: PRES_NONE, power: PP_6V6 },
  // hi-watt: a hot first stage, the volume, two unbypassed stages, the stack on the plate, heavy feedback: tight, bright, a long way to breakup
  { stages: [first(K_HOT, 25e-6), st(K_UNBY, 0, { pot: true }), st(K_UNBY, 0, { r1: 470e3, r2: 100e3 })], potLo: 0.01, stackAt: 3, cf: false, stack: STACK_HIWATT, trim: 11.5, follow: 0, bias: 40, gpi: 29, mv: false, pres: PRES_NFB, power: PP_HW },
  // boutique: three stages and a cathode follower into a Mark-style stack, class A EL84s: vocal mids, breaks up gradually
  { stages: [first(K_HOT, 25e-6), st(K_HOT, 25e-6, { pot: true }), st(K_UNBY, 0, { r1: 470e3, r2: 100e3 })], potLo: 0.01, stackAt: 3, cf: true, stack: STACK_MESA, trim: 19, follow: 0, bias: 10, gpi: 29, mv: true, pres: PRES_NFB, power: PP_BOUT },
  // brit 800: the JCM800 2203: V1b on 2.7k / 0.68 uF, 470k with 470 pF into the gain pot ("dumps 48%"), V1a the cold clipper (10k unbypassed),
  // the second 470k divider, V2a on 820 / 0.68 uF, the cathode follower, the stack
  { stages: [first(K_BRIT, 0.68e-6), st(K_COLD, 0, { r1: 470e3, c1: 470e-12, r2: 500e3, pot: true }), st(K_MARSHALL, 0.68e-6, { r1: 470e3, r2: 470e3 })],
    potLo: 0.015, stackAt: 3, cf: true, stack: STACK_JCM800, trim: 7.6, follow: 0, bias: 38, gpi: 29, mv: true, pres: PRES_NFB, power: PP_EL34 },
  // rectified: the Soldano layout (below) with a 10k cold stage and a smaller plate cap, into a deeper-scooped stack, and a saggy supply
  { stages: [first(K_SLO1, 0.68e-6), st(K_SLO2, 0.68e-6, { cc: 20e-9, r1: 470e3, c1: 2000e-12, r2: 500e3, pot: true }),
    st(K_COLD, 0, { cc: 20e-9, r1: 470e3, r2: 1e6, cp: 3400, stop: 220e3 }), st(K_SLO4, 0.68e-6, { cc: 20e-9, r2: 330e3, stop: 470e3 })],
    potLo: 0.0015, stackAt: 4, cf: true, stack: STACK_BASSMAN, trim: -13, follow: 0, bias: 50, gpi: 29, mv: true, pres: PRES_NFB, power: PP_MODERN },
  // modern: the Soldano SLO overdrive channel (ampbooks): stage 1 on 220k / 1.8k, 2000 pF across 470k into the gain pot (a shelf at 169 Hz),
  // stage 2 on 100k / 1.8k, the 470k / 1M divider, stage 3 cold (39k unbypassed) with 1000 pF across its plate (from 1.6 kHz) behind 220k,
  // stage 4 (220k / 1.8k behind 470k, "the first stage to overdrive"), the cathode follower into the Soldano stack
  { stages: [first(K_SLO1, 0.68e-6), st(K_SLO2, 0.68e-6, { cc: 20e-9, r1: 470e3, c1: 2000e-12, r2: 500e3, pot: true }),
    st(K_SLOCOLD, 0, { cc: 20e-9, r1: 470e3, r2: 1e6, cp: 1600, stop: 220e3 }), st(K_SLO4, 0.68e-6, { cc: 20e-9, r2: 330e3, stop: 470e3 })],
    potLo: 0.005, stackAt: 4, cf: true, stack: STACK_SOLDANO, trim: 6.8, follow: 0, bias: 45, gpi: 29, mv: true, pres: PRES_NFB, power: PP_MODERN },
  // blackface: the Fender layout (AB763 Deluxe): V1, the stack, the volume, V2 (Robinette: V1B and V2B share an 820 ohm cathode
  // resistor bypassed by 25 uF, 57x); 6V6s on about -35 V, a 12AT7 long-tail pair, feedback, no presence control
  { stages: [first(K_HOT, 25e-6), st(K_HOT, 25e-6, { cc: 0, pot: true })], potLo: 0.04, stackAt: 1, cf: false, stack: STACK_BLACKFACE, trim: 12.2, follow: 0.3, bias: 35, gpi: 27, mv: false, pres: PRES_NONE, power: PP_6L6 },
  // champ: the 5F1: two stages and the volume into one 6V6 in class A (the stack standing in for the knobs it doesn't have)
  { stages: [first(K_HOT, 25e-6), st(K_HOT, 25e-6, { pot: true })], potLo: 0.03, stackAt: 2, cf: false, stack: STACK_BASSMAN, trim: 16.4, follow: 0.3, bias: 20, gpi: STANDIN, mv: false, pres: PRES_NONE, power: SE_6V6 },
  // orange: three stages, the stack on the plate, no scoop, thick low mids
  { stages: [first(K_HOT, 25e-6), st(K_HOT, 25e-6, { pot: true }), st(K_UNBY, 0, { r1: 470e3, r2: 220e3 })], potLo: 0.015, stackAt: 3, cf: false, stack: STACK_ORANGE, trim: -7.4, follow: 0, bias: 38, gpi: 29, mv: true, pres: PRES_NFB, power: PP_ORANGE },
  // brown: the plexi on a variac
  { stages: [first(K_BRIT, 0.68e-6), marshallV2()], potLo: 0.02, stackAt: 2, cf: true, stack: STACK_PLEXI, trim: 14.6, follow: 0, bias: 30, gpi: 29, mv: false, pres: PRES_NFB, power: PP_BROWN },
];
export const NVOICINGS = VOICINGS.length;
/** How many preamp stages a voicing has (for its picture). */
export const ampStages = (v: number): number => VOICINGS[v].stages.length;
/** A voicing's stack and what drives it (for its picture). */
export const ampStack = (v: number): { parts: StackParts; rs: number } => ({ parts: VOICINGS[v].stack, rs: VOICINGS[v].cf ? RS_CF : RS_PLATE });

/** Built once and shared by every amp: the preamp stage tables, the cathode follower, each voicing's power stage. */
let STAGES: StageTable[] | null = null;
let FOLLOWER: FollowerTable | null = null;
let POWERS: PowerTable[] | null = null;
function tables(): void {
  if (STAGES) return;
  STAGES = STAGE_KINDS.map((k) => new StageTable(k));
  FOLLOWER = new FollowerTable();
  POWERS = VOICINGS.map((v) => new PowerTable(v.power));
}
/**
 * Volts at the phase inverter's input (after the master) to the power
 * table's units, where 1 is full power: the inverter's gain onto the output
 * grids against their bias, and the table's own drive to full power (which
 * includes the loop gain of the feedback).
 */
export const ampPowerScale = (v: number): number => { tables(); const p = VOICINGS[v]; return p.gpi / (p.bias * POWERS![v].scale); };

export class Amp {
  private os: Oversampler;
  /** The oversampling factor (AMP_RATE, never under 8). */
  readonly factor: number;
  private up: Float32Array;
  private readonly fs: number;
  private readonly fsOs: number;
  /** Per stage: the network in front of the grid (the bleed shelf, then the pot with its bright cap), the Miller pole, the plate cap. */
  private bleed: FirstOrder[] = []; private potF: FirstOrder[] = [];
  private miller: OnePoleLP[] = [];
  private plate: OnePoleLP[] = [];
  /** Per stage: the coupling cap's voltage (the bias shift) and the cathode's departure from idle. */
  private cap = new Float64Array(MAX_STAGES);
  private kd = new Float64Array(MAX_STAGES);
  /** First-order ADAA state: each stage's last grid drive and the antiderivatives there; the follower's and the power stage's. */
  private ax = new Float64Array(MAX_STAGES); private aFv = new Float64Array(MAX_STAGES); private aFg = new Float64Array(MAX_STAGES);
  private cfX = 0; private cfF = 0; private paX = 0; private paF = 0;
  /** Per stage: dt / C of the coupling cap, 1 / R of its leak, the share of grid current it carries; dt / Ck and 1 / Rk; 1 / Rp. */
  private ccK = new Float64Array(MAX_STAGES); private ccG = new Float64Array(MAX_STAGES); private ccF = new Float64Array(MAX_STAGES);
  private ckK = new Float64Array(MAX_STAGES); private rkG = new Float64Array(MAX_STAGES); private rpG = new Float64Array(MAX_STAGES);
  readonly stack = new ToneStack();
  private xfmrLp: OnePoleLP;
  /** The output transformer's core flux (the integral of the primary voltage). */
  private flux = 0;
  /** The speaker load on the power stage, inside the loop. */
  private load = new Cubic();
  private presLoop: Biquad = new Biquad();
  private sagEnv = 0;
  private lastType = -1;
  private lastPres = -1;
  /** The power-stage drive and the output gain of the last block (they glide from there). */
  private lastP = -1; private lastOut = -1;
  private lastGain = -1;
  private lastCab = -2;
  /** For the tests: the node of preamp stage `tap` (its grid, before the tube), or with `tap` = the number of stages the preamp's output, instead of the amp's output. -1 = off. */
  tap = -1;
  /** For the UI: peak drive into each stage (1 = the knee), and into the power stage. */
  stageHeat = new Float32Array(MAX_STAGES + 1);
  /** For the UI: how far the supply sagged, 0..1. */
  sagDepth = 0;

  constructor(sampleRate: number) {
    tables();
    this.factor = osFactor(sampleRate, AMP_RATE, OS);
    this.fs = sampleRate; this.fsOs = sampleRate * this.factor;
    this.up = new Float32Array(MAX_BLOCK * this.factor);
    this.os = new Oversampler(sampleRate, this.factor);
    for (let s = 0; s <= MAX_STAGES; s++) {
      this.miller.push(new OnePoleLP(this.fsOs, 12000));   // one more: the phase inverter's grid
      this.bleed.push(new FirstOrder()); this.potF.push(new FirstOrder()); this.plate.push(new OnePoleLP(this.fsOs, 20000));
    }
    this.xfmrLp = new OnePoleLP(this.fsOs, 9000);
  }

  reset(): void {
    this.os.reset(); this.stack.reset();
    for (let s = 0; s <= MAX_STAGES; s++) { this.miller[s].z = 0; this.plate[s].z = 0; this.bleed[s].reset(); this.potF[s].reset(); }
    this.cap.fill(0); this.kd.fill(0);
    this.ax.fill(0); this.aFv.fill(0); this.aFg.fill(0); this.cfX = this.cfF = this.paX = this.paF = 0;
    this.xfmrLp.z = 0; this.flux = 0; this.load.reset(); this.presLoop.reset(); this.sagEnv = 0; this.lastP = this.lastOut = -1;
  }

  private voice(type: number, gain: number, cab: number): void {
    const v = VOICINGS[type];
    const fsOs = this.fsOs, dt = 1 / fsOs;
    if (type !== this.lastType) {
      this.reset();
      v.stages.forEach((s, k) => {
        const kind = STAGE_KINDS[s.kind];
        this.ccK[k] = s.cc > 0 ? dt / s.cc : 0;
        this.ccG[k] = 1 / (s.r1 + s.r2 > 0 ? s.r1 + s.r2 : 1e6);
        this.ckK[k] = s.ck > 0 ? dt / s.ck : 0;
        this.rkG[k] = 1 / kind.rk; this.rpG[k] = 1 / kind.rp;
        // the bleed: r2 / (r2 + r1 || c1)
        if (s.r1 > 0 && s.r2 > 0) {
          if (s.c1 > 0) this.bleed[k].set(fsOs, s.r2, s.r1 * s.r2 * s.c1, s.r1 + s.r2, s.r1 * s.r2 * s.c1);
          else this.bleed[k].gain(s.r2 / (s.r1 + s.r2));
        } else this.bleed[k].gain(1);
        this.plate[k].set(fsOs, s.cp > 0 ? s.cp : 0.45 * fsOs);
      });
      this.miller[MAX_STAGES].set(fsOs, 15000);
      this.lastPres = -1; this.lastGain = -1; this.lastCab = -2;
    }
    if (gain !== this.lastGain) {
      // the pot's wiper (audio taper), its bright cap, and the Miller pole of the grid behind it, which moves with the pot's resistance
      const a = v.potLo * Math.pow(1 / v.potLo, gain);
      const tabs = STAGES!;
      v.stages.forEach((s, k) => {
        let rth = 0;
        if (s.pot) {
          const rt = (1 - a) * s.r2, rb = a * s.r2;
          if (s.cb > 0) this.potF[k].set(fsOs, a, a * rt * s.cb, 1, (rt * rb / s.r2) * s.cb);
          else this.potF[k].gain(a);
          this.ccF[k] = rb / (s.r1 + s.r2);
          rth = (rb * (rt + s.r1 + RS_PLATE)) / (rb + rt + s.r1 + RS_PLATE);
        } else {
          this.potF[k].gain(1);
          this.ccF[k] = s.r2 > 0 ? s.r2 / (s.r1 + s.r2) : 1;
          rth = s.r2 > 0 ? (s.r1 > 0 ? (s.r2 * (s.r1 + RS_PLATE)) / (s.r1 + s.r2 + RS_PLATE) : RS_PLATE) : 0;
        }
        const A = Math.abs(tabs[s.kind].gain);
        const cin = C_GK + C_GA * (A + 1) + C_WIRE;
        this.miller[k].set(fsOs, Math.min(0.45 * fsOs, 1 / (2 * Math.PI * (s.stop + rth) * cin)));
      });
      this.lastGain = gain;
    }
    if (cab !== this.lastCab) {
      // the speaker load, normalised at 1 kHz: Z / ((1 + T) Z + Zp), Z the voice coil plus the motional branch
      const T = v.power.nfb, zp = v.power.zp;
      if (cab < 0) this.load.bypass();
      else {
        const sp = SPEAKERS[cab], lces = sp.res / (2 * Math.PI * sp.fs * sp.q), cmes = sp.q / (2 * Math.PI * sp.fs * sp.res);
        const re = sp.re, le = sp.le, res = sp.res;
        // Z = N / D with D = Res + s Lces + s^2 Lces Cmes Res
        const n0 = re * res, n1 = re * lces + le * res + lces * res, n2 = re * lces * cmes * res + le * lces, n3 = le * lces * cmes * res;
        const d0 = res, d1 = lces, d2 = lces * cmes * res;
        const a0 = (1 + T) * n0 + zp * d0, a1 = (1 + T) * n1 + zp * d1, a2 = (1 + T) * n2 + zp * d2, a3 = (1 + T) * n3;
        // |H(j 2 pi 1k)|
        const w = 2 * Math.PI * 1000, w2 = w * w, w3 = w2 * w;
        const hr = n0 - n2 * w2, hi = n1 * w - n3 * w3, gr = a0 - a2 * w2, gi = a1 * w - a3 * w3;
        const k = Math.sqrt((gr * gr + gi * gi) / (hr * hr + hi * hi));
        this.load.set(fsOs, n0 * k, n1 * k, n2 * k, n3 * k, a0, a1, a2, a3);
      }
      this.lastCab = cab;
    }
    this.lastType = type;
  }

  /**
   * In place, base rate. Knobs 0..1. `heat` multiplies the signal into the
   * first stage (the rig's heat macro). `cab`: the cabinet (index into
   * SPEAKERS) whose impedance loads the power stage, -1 for none (a
   * resistive load).
   */
  process(x: Float32Array, n: number, type: number, gain: number, bass: number, mid: number, treble: number,
    presence: number, master: number, sag: number, heat: number, cab = -1): void {
    this.voice(type, gain, cab);
    const v = VOICINGS[type];
    if (presence !== this.lastPres) {
      // presence takes feedback away above ~3 kHz: at most (1 + T). The AC30 has a Cut instead, a treble cut at the
      // inverter's outputs (presence 1 = the cut pot at 250k, no cut; 0 = full cut); the 5E3, the champ and the
      // blackface Fenders have neither, and the knob does nothing on them
      const T = v.power.nfb;
      if (v.pres === PRES_NFB && T > 0) this.presLoop.highShelf(this.fsOs, 3200, 20 * Math.log10((1 + T) / (1 + T * (1 - presence))));
      else if (v.pres === PRES_CUT) {
        const R = Math.max(1, CUT_R * (1 - (Math.pow(32, 1 - presence) - 1) / 31));
        this.presLoop.firstOrder(this.fsOs, 1, R * CUT_C, 1, (R + CUT_RS) * CUT_C);
      } else this.presLoop.bypass();
      this.lastPres = presence;
    }
    this.stack.set(this.fsOs, v.stack, treble, mid, bass, v.cf ? RS_CF : RS_PLATE);

    const up = this.up, m = n * this.factor;
    this.os.upsample(x, up, n);
    const stages = v.stages, nst = stages.length, stackAt = v.stackAt, cfOn = v.cf;
    const tabs = STAGES!, cfY = FOLLOWER!.y, cfF = FOLLOWER!.F, power = POWERS![type].y, powF = POWERS![type].F;
    const ax = this.ax, aFv = this.aFv, aFg = this.aFg;
    let cfX = this.cfX, cfI = this.cfF, paX = this.paX, paI = this.paF;
    // the preamp's plate swing (~100 V) into the power stage's units
    // the master (or the full signal on an amp without one) into the inverter, onto the output grids: 1 is full power.
    // It glides across the block, so automation of the master doesn't step.
    const P1 = masterPot(master) * ampPowerScale(type), P0 = this.lastP < 0 ? P1 : this.lastP, dP = (P1 - P0) / m;
    this.lastP = P1;
    const sagAtk = 1 - Math.exp(-1 / (0.012 * this.fsOs));
    const sagRel = 1 - Math.exp(-1 / (0.15 * this.fsOs));
    const heatArr = this.stageHeat;
    heatArr.fill(0);
    const cap = this.cap, kd = this.kd, ccK = this.ccK, ccG = this.ccG, ccF = this.ccF, ckK = this.ckK, rkG = this.rkG, rpG = this.rpG;
    const miller = this.miller, bleed = this.bleed, potF = this.potF, plate = this.plate;
    const stack = this.stack, xfmrLp = this.xfmrLp, presLoop = this.presLoop, load = this.load;
    const xt = 1 / this.fsOs, tap = this.tap;
    let env = this.sagEnv, sagMin = 1, flux = this.flux;
    for (let i = 0; i < m; i++) {
      let s = up[i] * heat;
      for (let k = 0; k < nst; k++) {
        const sk = stages[k], t = tabs[sk.kind];
        // the coupling cap, the divider and pot, the Miller pole: the grid node
        const vN = ccK[k] > 0 ? s - cap[k] : s;
        const vn = miller[k].tick(potF[k].tick(bleed[k].tick(vN)));
        if (k === tap) { if (ccK[k] > 0) cap[k] += ccK[k] * vN * ccG[k]; s = vn; break; }
        // the cathode's own state moves the operating point (a bypassed stage's cap)
        const vx = ckK[k] > 0 ? vn - kd[k] * (1 + 1 / t.mu) : vn;
        const a = Math.abs(vx) / t.knee; if (a > heatArr[k]) heatArr[k] = a;
        // the plate and the grid current as the mean of the stage's curve since the last sample (first-order ADAA,
        // Parker, Zavalishin & Le Bivic, DAFx-16): the knees where the grid conducts and the stage cuts off fold back far less
        const gs = 1 / t.rs, Fv = tableInt(t.vp, t.Fvp, TUBE_LO, TUBE_INV, vx, 0), Fg = tableInt(t.ig, t.Fig, TUBE_LO, TUBE_INV, vx, gs);
        const dx = vx - ax[k];
        let vp: number, ig: number;
        if (dx > ADAA_EPS || dx < -ADAA_EPS) { vp = (Fv - aFv[k]) / dx; ig = (Fg - aFg[k]) / dx; }
        else { const mid = 0.5 * (vx + ax[k]); vp = tableAt(t.vp, TUBE_LO, TUBE_INV, mid, 0); ig = tableAt(t.ig, TUBE_LO, TUBE_INV, mid, gs); }
        ax[k] = vx; aFv[k] = Fv; aFg[k] = Fg;
        // the cathode cap: Ck dVk/dt = dIk - Vk / Rk, with dIk the plate current's and the grid's change
        if (ckK[k] > 0) kd[k] += ckK[k] * (ig - vp * rpG[k] - kd[k] * rkG[k]);
        // the coupling cap: the leak bleeds it, grid current charges it (blocking)
        if (ccK[k] > 0) cap[k] += ccK[k] * (vN * ccG[k] + ccF[k] * ig);
        s = plate[k].tick(vp);
        if (k + 1 === stackAt) {
          if (cfOn) {
            const Fc = tableInt(cfY, cfF, CF_LO, CF_INV, s, 0), d = s - cfX;
            const o = d > ADAA_EPS || d < -ADAA_EPS ? (Fc - cfI) / d : tableAt(cfY, CF_LO, CF_INV, 0.5 * (s + cfX), 0);
            cfX = s; cfI = Fc; s = o;
          }
          s = stack.tick(s);
        }
      }
      if (tap >= 0) { up[i] = s; continue; }
      // the phase inverter's Miller pole, the speaker load and presence inside the loop, then the power stage on a sagging supply
      let u = presLoop.tick(load.tick(miller[MAX_STAGES].tick(s) * (P0 + dP * i)));
      const supply = 1 - 0.45 * sag * env;
      if (supply < sagMin) sagMin = supply;
      const ua = u / supply;
      const a = Math.abs(ua); if (a > heatArr[MAX_STAGES]) heatArr[MAX_STAGES] = a;
      const Fp = tableInt(power, powF, -PA_R, PA_INV, ua, 0), dp = ua - paX;
      u = supply * (dp > ADAA_EPS || dp < -ADAA_EPS ? (Fp - paI) / dp : tableAt(power, -PA_R, PA_INV, 0.5 * (ua + paX), 0));
      paX = ua; paI = Fp;
      const au = Math.abs(u);
      env += (au - env) * (au > env ? sagAtk : sagRel);
      // the transformer: what reaches the speaker is the drive less what the primary's (saturating) inductance takes
      const fs2 = flux * XFMR_SAT;
      const y = xfmrLp.tick(u) - XFMR_A * flux * (1 + fs2 * fs2);
      flux += y * xt;
      up[i] = y;
    }
    this.sagEnv = env; this.flux = flux;
    this.cfX = cfX; this.cfF = cfI; this.paX = paX; this.paF = paI;
    this.sagDepth = 1 - sagMin;
    this.os.downsample(up, x, n);
    if (tap >= 0) return;
    // the output follows the preamp, not the master: the master sets how hard the power tubes work and the level
    // after them is made up (a load box behind a cranked amp), so loudness and drive are separate
    const o1 = dbToGain(v.trim) * OUT_REF / P1 * Math.pow(1 / v.potLo, -v.follow * (gain - 0.5)), o0 = this.lastOut < 0 ? o1 : this.lastOut;
    this.lastOut = o1;
    for (let i = 0; i < n; i++) x[i] *= o0 + (o1 - o0) * (i / n);
  }
}
