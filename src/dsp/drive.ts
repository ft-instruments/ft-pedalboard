// The drive pedals: eight circuits behind one footswitch. Signals are in
// volts (a single coil peaks around 0.2-0.5 V, a humbucker 0.4-1 V); the
// nonlinear parts run at 8x. Each circuit is modelled from its schematic,
// with the caps that limit the bandwidth *inside* the gain stages (before
// the clipping), so the clippers only see what the real ones see.
//
// The level knob is the pedal's output pot: +12 dB is the pot full up
// (the circuit's own output, in volts), 0 dB is 12 dB under it.
//
//  glow  TS808 (Yeh, Abel & Smith, DAFx-07): input high-passes (15.9/15.6
//        Hz), the clipping stage as Yeh's ODE (the 4.7k/47 nF leg, 51k +
//        the drive pot across 51 pF and two diodes a factor 2 apart in Is so the
//        clipping is a little lopsided, as the measured pedals are), solved
//        by backward Euler exactly each sample, Vo = Vi + V; then the tone
//        stage solved as its circuit (1k/220 nF into the 20k pot, 220 ohm
//        and 220 nF, 1k feedback, the 10k bias load).
//  rasp  ProCo RAT: the LM308 as a real op-amp (1 MHz gain-bandwidth, 0.3
//        V/us slew as a smooth saturating integrator, soft rails) inside
//        its feedback network (the 100k pot across 100 pF, the 47 ohm/2.2
//        uF and 560 ohm/4.7 uF legs), solved implicitly; then 1N914s to
//        ground through 1k and the filter (1.5k + 100k pot into 3.3 nF).
//  fuzz  Fuzz Face: two germanium transistors (Ebers-Moll, with their
//        junction capacitances and leakage) on a four-node Newton solve.
//  muff  Big Muff Pi (J.L., "Re-engineering the Big Muff", 2014): an
//        input stage, the sustain pot, two clipping stages (470k across
//        470 pF from collector to base, diodes behind 1 uF: solved exactly
//        by backward Euler, the cap's charge included), 16 Hz coupling, the
//        Ram's Head tone stack solved as its network, the output stage.
//  boost Rangemaster-type treble booster: one germanium stage with its
//        source and input cap.
//  transparent
//        Klon Centaur, after J. Chowdhury, "A comparison of virtual analog
//        modelling techniques" (2020) and his BSD-3 KlonCentaur code: the
//        pre-amp with feed-forward 1, the amplifier stage (13 to 28 dB),
//        the 1N34A clipper as a network, feed-forward 2 through the second
//        gang of the gain pot, all summed as currents by the summing amp
//        (392k across 820 pF) on the charge pump's rails; then the treble
//        control as its circuit.
//  metal two op-amp stages with their feedback caps before each clip (the
//        first into its rails, the second with diodes in its feedback),
//        a mid push between them, diodes to ground across 10 nF, a mid
//        scoop after.
//  octave
//        a fuzz with a full-wave rectifier in it: the rectified half of the
//        wave is an octave up, mixed under the fuzz.

import { Oversampler, osFactor, DRIVE_RATE, DRIVE_RATE_HARD, OnePoleLP, OnePoleHP, Biquad, FirstOrder, tanhf, dbToGain } from './util.ts';
import { LinearNet } from './net.ts';
import { bilinear2 } from './gtone.ts';
import { PICKUP_R, PICKUP_L, PICKUP_C, PICKUP_EDDY, DI_LOAD } from './pickup.ts';
export { PICKUP_R, PICKUP_L };

export const DRIVE_GLOW = 0, DRIVE_RASP = 1, DRIVE_FUZZ = 2, DRIVE_MUFF = 3, DRIVE_BOOST = 4, DRIVE_TRANSPARENT = 5, DRIVE_METAL = 6, DRIVE_OCTAVE = 7;

const MAX_BLOCK = 512;

/** 1N914/1N4148 (SPICE: Is 2.52 nA, n 1.752). */
const DIODE_IS = 2.52e-9, DIODE_NVT = 1.752 * 0.02585;

/**
 * An antiparallel pair of diodes across a resistance R, driven so that
 * without the diodes the voltage would be u: the exact Shockley solution of
 * v + 2 Is R sinh(v / nVt) = u. A backward-Euler step of a cap with diodes
 * across it has this form too (R is then the cap's companion in parallel
 * with the circuit's resistance). Newton from an upper bound on a convex
 * curve comes down without overshooting; five steps are exact to 1e-9 V.
 */
export function diodePair(u: number, r: number): number { return diodePairOf(u, r, DIODE_IS, DIODE_NVT); }
/** The same for any diode (saturation current `is`, n Vt `nvt`). */
export function diodePairOf(u: number, r: number, is: number, nvt: number): number {
  const a = Math.abs(u), b = 2 * is * r;
  let w = Math.min(a / nvt, Math.asinh(a / b));
  for (let k = 0; k < 5; k++) { const e = Math.exp(w), ie = 1 / e; w -= (nvt * w + b * 0.5 * (e - ie) - a) / (nvt + b * 0.5 * (e + ie)); }
  return u < 0 ? -nvt * w : nvt * w;
}
/** Two diodes that differ (Is1 conducting for v > 0, Is2 for v < 0): v + R (Is1 (e^(v/nVt) - 1) - Is2 (e^(-v/nVt) - 1)) = u. */
export function diodeAsym(u: number, r: number, is1: number, is2: number, nvt: number): number {
  let v = diodePairOf(u, r, u >= 0 ? is1 : is2, nvt);
  for (let k = 0; k < 4; k++) {
    const ep = Math.exp(v / nvt), en = 1 / ep;
    v -= (v + r * (is1 * (ep - 1) - is2 * (en - 1)) - u) / (1 + r * (is1 * ep + is2 * en) / nvt);
  }
  return v;
}
/** 1N34A germanium (Is 0.2 uA, n 1.3): the Klon's clippers. */
const GE_IS = 2e-7, GE_NVT = 1.3 * 0.02585;

/**
 * diodePair for one resistance as a table over |u| < DT_MAX (odd symmetry);
 * past it the diodes carry nearly all of the current, so one fixed-point
 * step from the table's end is exact to well under a microvolt.
 */
const DT_N = 2048, DT_MAX = 8, DT_INV = (DT_N - 1) / DT_MAX;
export class DiodeTable {
  readonly y = new Float64Array(DT_N);
  /** The antiderivative of the interpolated curve from 0, for antiderivative antialiasing. */
  readonly F = new Float64Array(DT_N);
  b = 1; r = -1;
  readonly is: number; readonly nvt: number;
  constructor(r: number, is = DIODE_IS, nvt = DIODE_NVT) { this.is = is; this.nvt = nvt; this.build(r); }
  build(r: number): void {
    if (r === this.r) return;
    this.r = r; this.b = 2 * this.is * r;
    for (let j = 0; j < DT_N; j++) this.y[j] = diodePairOf(j / DT_INV, r, this.is, this.nvt);
    this.F[0] = 0;
    for (let j = 1; j < DT_N; j++) this.F[j] = this.F[j - 1] + 0.5 * (this.y[j - 1] + this.y[j]) / DT_INV;
  }
  at(u: number): number {
    const a = Math.abs(u), p = a * DT_INV;
    let v: number;
    if (p >= DT_N - 1) v = this.nvt * Math.asinh((a - this.y[DT_N - 1]) / this.b);
    else { const j = p | 0, f = p - j; v = this.y[j] + f * (this.y[j + 1] - this.y[j]); }
    return u < 0 ? -v : v;
  }
  /** The antiderivative at u (even: the curve is odd). Past the table, the midpoint rule from its end. */
  integral(u: number): number {
    const a = Math.abs(u), p = a * DT_INV;
    if (p >= DT_N - 1) return this.F[DT_N - 1] + (a - DT_MAX) * this.at(0.5 * (a + DT_MAX));
    const j = p | 0, f = p - j, d = this.y[j + 1] - this.y[j];
    return this.F[j] + (this.y[j] * f + 0.5 * d * f * f) / DT_INV;
  }
  /**
   * First-order antiderivative antialiasing (Parker, Zavalishin & Le Bivic,
   * DAFx-16): the mean of the curve between the last input and this one.
   * Half a sample of delay; the harmonics a hard knee makes fall a power faster.
   */
  adaa(u: number, u1: number): number {
    const d = u - u1;
    if (d > 1e-5 || d < -1e-5) return (this.integral(u) - this.integral(u1)) / d;
    return this.at(0.5 * (u + u1));
  }
}
/** Tables whose resistance only depends on the sample rate, shared by every drive. */
const SHARED: DiodeTable[] = [];
function sharedTable(r: number, is = DIODE_IS, nvt = DIODE_NVT): DiodeTable {
  for (const t of SHARED) if (t.r === r && t.is === is && t.nvt === nvt) return t;
  const t = new DiodeTable(r, is, nvt); SHARED.push(t); return t;
}

/** diodeAsym as a table over -DT_MAX..DT_MAX, for a resistance that moves with a knob. */
const AT_N = 2 * DT_N - 1, AT_INV = (AT_N - 1) / (2 * DT_MAX);
export class AsymTable {
  readonly y = new Float64Array(AT_N);
  r = -1;
  private readonly is1: number; private readonly is2: number; private readonly nvt: number;
  constructor(is1: number, is2: number, nvt: number) { this.is1 = is1; this.is2 = is2; this.nvt = nvt; }
  build(r: number): void {
    if (r === this.r) return;
    this.r = r;
    for (let j = 0; j < AT_N; j++) this.y[j] = diodeAsym(j / AT_INV - DT_MAX, r, this.is1, this.is2, this.nvt);
  }
  at(u: number): number {
    const p = (u + DT_MAX) * AT_INV;
    if (p >= AT_N - 1) return this.nvt * Math.asinh((u - this.y[AT_N - 1]) / (2 * this.is1 * this.r));
    if (p <= 0) return -this.nvt * Math.asinh((this.y[0] - u) / (2 * this.is2 * this.r));
    const j = p | 0, f = p - j;
    return this.y[j] + f * (this.y[j + 1] - this.y[j]);
  }
}
/** A resistance held to 0.25% steps, so a table that follows a knob is rebuilt only when it has moved. */
function quantR(r: number): number { return Math.exp(Math.round(Math.log(r) * 400) / 400); }

/** Germanium pair, lopsided: the negative side gives up earlier, with the same slope through zero (no kink). */
function germanium(v: number): number { return v >= 0 ? tanhf(v) : 0.62 * tanhf(v / 0.62); }
/** An op-amp's output against its rails: linear, then a firm (4th-order) knee at +-`rail`. */
function rails(v: number, rail: number): number { const t = v / rail, t2 = t * t; return v / Math.sqrt(Math.sqrt(1 + t2 * t2)); }
/** Smooth max(x, 0) with a knee `k` volts wide. */
function knee(x: number, k: number): number { const t = x / k; return t > 30 ? x : t < -30 ? 0 : k * Math.log(1 + Math.exp(t)); }
/** An audio-taper pot's fraction at rotation g (10% at noon). */
function audioTaper(g: number): number { return (Math.pow(81, g) - 1) / 80; }

// ---- TS808 ------------------------------------------------------------------
const TS_R1 = 4.7e3, TS_CZ = 47e-9, TS_CC = 51e-12;
/** The drive pot's leg: 51k plus the 500k audio-taper pot (10% at noon: 101k there, 27-29 dB like a real TS at noon). */
function glowR(g: number): number { return 51e3 + 500e3 * audioTaper(g); }
/** The tone stage's bilinear transform is prewarped here (at 8 kHz it was 1-1.2 dB low against the analog circuit). */
const TS_WARP = 3000;
/** The two clipping diodes differ by this factor in Is (the measured pedals' even harmonics). */
const TS_ASYM = 2;

/** The TS tone stage (Yeh's eq. 24, solved here from its circuit), tone 0 dark to 1 bright, into `q`. */
export function tsTone(q: Biquad, fs: number, t: number): void {
  const Rs = 1e3, Cs = 0.22e-6, Ri = 10e3, Rf = 1e3, Rz = 220, Cz = 0.22e-6, Rp = 20e3;
  const Rl = Math.max(1, t * Rp), Rr = Math.max(1, (1 - t) * Rp), P = Rl * Rr / (Rl + Rr);
  const tau = Cz * (Rz + P), aL = Cz * Rr / (Rl + Rr), aR = Rf * Cz * Rl / (Rl + Rr), G0 = 1 / Rs + 1 / Ri;
  // (1/Rs)(1 + s (tau + Rf a / Rr)) / (G0 + s (G0 tau + Cs + a / Rl) + s^2 Cs tau), a = Cz (Rl || Rr)
  const w0 = 2 * Math.PI * TS_WARP, fw = w0 / (2 * Math.tan(w0 / (2 * fs)));
  bilinear2(fw, 0, (tau + aR) / Rs, 1 / Rs, Cs * tau, G0 * tau + Cs + aL, G0, q);
}

// ---- RAT ---------------------------------------------------------------------
const RAT_GBW = 2 * Math.PI * 1e6, RAT_SR = 0.3e6, RAT_RAIL = 3.6, RAT_CF = 100e-12;
const RAT_RA = 47, RAT_CA = 2.2e-6, RAT_RB = 560, RAT_CB = 4.7e-6;
/** The distortion pot (100k audio) plus its end resistance. */
function raspPot(g: number): number { return 100 + 100e3 * g * g * Math.sqrt(g); }
function d308(x: number): number { if (x > 3 || x < -3) return 0; const x2 = x * x, d = 27 + 9 * x2, m = 9 - x2; return 9 * m * m / (d * d); }

// ---- Big Muff ------------------------------------------------------------------
const MUFF_RF = 470e3, MUFF_CF = 470e-12, MUFF_RG1 = 39e3, MUFF_RG = 10e3, MUFF_CC = 1e-6, MUFF_CD = 1e-6;
/** A stage's output resistance into the next (collector load under its own feedback) [inference]. */
const MUFF_ROUT = 5e3;
/**
 * The transistor's open-loop gain against its collector load: at low
 * frequencies the next stage's 10k virtual-earth input loads the collector
 * and the loop gain is low; above Rf Cf's corner (720 Hz) Z2 is small and it
 * is high. Fitted to the fixer audit's transistor-level reference (a stage
 * -7.3 dB from ideal at 50 Hz, -0.5 dB at 10 kHz).
 */
const MUFF_A_LF = 40, MUFF_A_HF = 730, MUFF_WC = 1 / (MUFF_RF * MUFF_CF);
/** Stage 1's collector (4.03 V on 9 V) can swing ~4.9 V up and ~3.9 V down: the lopsided clip that gives the even harmonics. */
const MUFF_UP = 4.9, MUFF_DOWN = 3.9;
/** The output stage (10k collector, 2.2k emitter): inverting, the fourth inversion, so the pedal's output is upright. */
const MUFF_GOUT = -4.5;

// ---- Fuzz Face ---------------------------------------------------------------
//
// Two germanium transistors (shown as NPN on a +9 V rail: the PNP original
// is the same circuit upside down). Q1 has its emitter grounded and a 33k
// collector load; its collector drives Q2's base directly. Q2 has an 8.67k
// collector load (470 + 8.2k) and the 1k fuzz pot in its emitter: the
// wiper's 20 uF cap bypasses the part under the wiper, so the fuzz knob
// takes Q2's degeneration away. 100k from Q2's emitter back to Q1's base
// sets the bias and, at low fuzz, feeds back the signal. Both transistors
// are Ebers-Moll (Is 1 uA, beta 70 and 110, reverse beta 4) with the
// junction capacitances Holmes, Holters & van Walstijn measured on
// germanium parts (DAFx-17: ~410 pF base-emitter, 20 pF collector-base) as
// real capacitors, and 0.3 uA of collector-base leakage each: Q1 at 0.25 mA and Q2 at
// 0.44 mA, the usual germanium bias targets.
//
// The input is a 2.2 uF cap from the source: the guitar's pickup (6.5k and
// 2.6 H) when the fuzz is first in the rack, the pickup through the guitar
// volume pot when the guitar-tone unit is right in front of it, a buffered
// 1k otherwise. Q1's base is only a few k, so the source impedance sets the
// gain: rolled back, the base is fed a current instead of a voltage and the
// fuzz cleans up, as the real one does (and stops doing behind a buffer).
//
// Solved per sample at 8x by damped Newton on the four nodes (Q1 base, Q1
// collector, Q2 emitter, Q2 collector) from the last sample's answer; the
// caps and the pickup's coil are backward-Euler companions. The output is
// Q2's collector through 10 nF into the 500k volume pot (32 Hz), no low-pass.

const FF_VCC = 9, FF_RC1 = 33e3, FF_RC2 = 8.67e3, FF_RF = 100e3, FF_RE = 1e3, FF_CE = 20e-6, FF_C1 = 2.2e-6;
const FF_IS = 1e-6, FF_VT = 0.0259, FF_B1 = 70, FF_B2 = 110, FF_BR = 4;
const FF_CEB = 410e-12, FF_CCB = 20e-12, FF_ICBO = 0.3e-6;
/** Newton steps per sample (from the last sample's answer; the steps are small at the oversampled rate), and the most it may take when it has not converged. */
const FF_STEPS = 6, FF_MAX_STEPS = 40;
const FF_ISF1 = FF_IS / FF_B1, FF_ISF2 = FF_IS / FF_B2, FF_ISR = FF_IS / FF_BR;
/** A buffered pedal's output. */
export const BUFFER_R = 1e3;
/** exp with its argument held under 40 (a junction voltage that would overflow just means "fully on"). */
function jexp(v: number): number { return Math.exp(v > 40 ? 40 : v); }
/** The junction voltage above which SPICE limits a Newton step (Vt ln(Vt / (sqrt 2 Is))). */
const FF_VCRIT = FF_VT * Math.log(FF_VT / (Math.SQRT2 * FF_IS));
/**
 * SPICE's pnjlim: a junction voltage that Newton wants to raise by more than
 * 2 Vt past the critical voltage moves only by the log of the step (the
 * exponential's current would otherwise overflow, which is how the solve used
 * to go to NaN behind a buffer when Q1 came out of saturation).
 */
function pnjlim(vnew: number, vold: number): number {
  if (vnew > FF_VCRIT && Math.abs(vnew - vold) > 2 * FF_VT) {
    if (vold > 0) { const arg = 1 + (vnew - vold) / FF_VT; return arg > 0 ? vold + FF_VT * Math.log(arg) : FF_VCRIT; }
    return FF_VT * Math.log(vnew / FF_VT);
  }
  return vnew;
}

class FuzzFace {
  vb = 0.15; vc = 0.5; ve = 0.35; vk = 4.5;   // the node voltages of the last sample
  vC1 = 0; iL = 0; vw = 0;                    // input cap, pickup coil, fuzz-pot wiper cap
  kdc = 4.5;
  /** Solves that went non-finite and fell back to the last sample (for the tests). */
  faults = 0;
  private readonly T: number;
  private fresh = true;
  private J = new Float64Array(16); private F = new Float64Array(4); private d = new Float64Array(4);

  constructor(fsOs: number) { this.T = 1 / fsOs; this.reset(); }

  /** The idle point (caps open, no signal): the same at every fuzz setting, as the pot's two halves add to 1k. */
  reset(): void {
    this.vb = 0.15; this.vc = 0.5; this.ve = 0.35; this.vk = 4.5;
    this.solve(0, 0, 1 / FF_RE, 0, 0, 80);
    this.kdc = this.vk;
    this.vC1 = -this.vb; this.iL = 0;
    this.vw = 0; this.fresh = true;        // the wiper cap's idle voltage depends on the knob: set on the first sample
  }

  /**
   * Newton on the four node voltages, at most `steps` times. `vin` is the
   * source side of the base node's linear branch and `gin` its conductance;
   * `geq`, `jeq` the emitter network's companion; `cs` 1 with the junction
   * caps in, 0 for the idle point.
   */
  solve(vin: number, gin: number, geq: number, jeq: number, cs: number, steps: number): void {
    const b0 = this.vb, c0 = this.vc, e0 = this.ve, k0 = this.vk;
    let b = b0, c = c0, e = e0, k = k0;
    const gf = 1 / FF_RF, iv = 1 / FF_VT, gb = cs * FF_CEB / this.T, gm = cs * FF_CCB / this.T;
    const J = this.J, F = this.F, d = this.d;
    for (let it = 0; it < steps; it++) {
      const ef1 = jexp(b * iv), er1 = jexp((b - c) * iv), ef2 = jexp((c - e) * iv), er2 = jexp((c - k) * iv);
      const ic1 = FF_IS * (ef1 - er1) - FF_ISR * (er1 - 1), ib1 = FF_ISF1 * (ef1 - 1) + FF_ISR * (er1 - 1);
      const ic2 = FF_IS * (ef2 - er2) - FF_ISR * (er2 - 1), ib2 = FF_ISF2 * (ef2 - 1) + FF_ISR * (er2 - 1);
      const qb1 = gb * (b - b0), qm1 = gm * ((b - c) - (b0 - c0)), qe2 = gb * ((c - e) - (c0 - e0)), qm2 = gm * ((c - k) - (c0 - k0));
      F[0] = gin * (vin - b) + gf * (e - b) - ib1 + FF_ICBO - qb1 - qm1;
      F[1] = (FF_VCC - c) / FF_RC1 - ic1 - ib2 + qm1 - qe2 - qm2;
      F[2] = ic2 + ib2 - gf * (e - b) - (geq * e - jeq) + qe2;
      F[3] = (FF_VCC - k) / FF_RC2 - ic2 - FF_ICBO + qm2;
      const df1 = ef1 * iv, dr1 = er1 * iv, df2 = ef2 * iv, dr2 = er2 * iv;
      const ic1b = FF_IS * df1 - (FF_IS + FF_ISR) * dr1, ic1c = (FF_IS + FF_ISR) * dr1;
      const ib1b = FF_ISF1 * df1 + FF_ISR * dr1, ib1c = -FF_ISR * dr1;
      const ic2c = FF_IS * df2 - (FF_IS + FF_ISR) * dr2, ic2e = -FF_IS * df2, ic2k = (FF_IS + FF_ISR) * dr2;
      const ib2c = FF_ISF2 * df2 + FF_ISR * dr2, ib2e = -FF_ISF2 * df2, ib2k = -FF_ISR * dr2;
      J[0] = -gin - gf - ib1b - gb - gm; J[1] = -ib1c + gm; J[2] = gf; J[3] = 0;
      J[4] = -ic1b + gm; J[5] = -1 / FF_RC1 - ic1c - ib2c - 2 * gm - gb; J[6] = -ib2e + gb; J[7] = -ib2k + gm;
      J[8] = gf; J[9] = ic2c + ib2c + gb; J[10] = ic2e + ib2e - gf - geq - gb; J[11] = ic2k + ib2k;
      J[12] = 0; J[13] = -ic2c + gm; J[14] = -ic2e; J[15] = -1 / FF_RC2 - ic2k - gm;
      solve4(J, F, d);
      // limit the step at the four junctions (the node voltages follow from them: b = Vbe1,
      // c = b - Vbc1, e = c - Vbe2, k = c - Vbc2), as a circuit simulator does
      const nb = b + d[0], nc = c + d[1], ne = e + d[2], nk = k + d[3];
      const j1 = pnjlim(nb, b), j2 = pnjlim(nb - nc, b - c), j3 = pnjlim(nc - ne, c - e), j4 = pnjlim(nc - nk, c - k);
      const lb = j1, lc = lb - j2, le = lc - j3, lk = lc - j4;
      const moved = Math.abs(lb - b) + Math.abs(lc - c) + Math.abs(le - e) + Math.abs(lk - k);
      const limited = j1 !== nb || j2 !== nb - nc || j3 !== nc - ne || j4 !== nc - nk;
      b = lb; c = lc; e = le; k = lk;
      // the step itself under 10 uV: Newton's error after it is far smaller still
      if (moved < 1e-5 && !limited) break;
      // not converged in the usual steps (a transistor switching hard): keep going, up to FF_MAX_STEPS
      if (it + 1 === steps && steps < FF_MAX_STEPS) steps = FF_MAX_STEPS;
    }
    // a solve that failed outright keeps the last sample's answer
    if (Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(e) && Number.isFinite(k)) { this.vb = b; this.vc = c; this.ve = e; this.vk = k; }
    else { this.vb = b0; this.vc = c0; this.ve = e0; this.vk = k0; this.faults++; }
  }

  /** One sample: source EMF `vs` (volts), source resistance and inductance, the fuzz pot's two halves. Returns Q2's collector swing. */
  tick(vs: number, rs: number, ls: number, ra: number, rb: number): number {
    const T = this.T, lt = ls / T, tc = T / FF_C1;
    const gin = 1 / (rs + lt + tc);
    const vin = vs - this.vC1 + lt * this.iL;
    if (this.fresh) { this.vw = this.ve * rb / (ra + rb); this.fresh = false; }
    const ga = 1 / ra, gb = 1 / rb, cg = FF_CE / T, D = ga + gb + cg;
    const geq = ga * (1 - ga / D), jeq = ga * cg * this.vw / D;
    this.solve(vin, gin, geq, jeq, 1, FF_STEPS);
    const i = gin * (vin - this.vb);
    this.iL = i; this.vC1 += tc * i;
    this.vw = (ga * this.ve + cg * this.vw) / D;
    return this.vk - this.kdc;
  }
}

/** J d = -F for a 4x4 (row major), Gaussian elimination with partial pivoting; J is destroyed. */
function solve4(J: Float64Array, F: Float64Array, d: Float64Array): void {
  for (let i = 0; i < 4; i++) d[i] = -F[i];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(J[r * 4 + c]) > Math.abs(J[p * 4 + c])) p = r;
    if (p !== c) { for (let k = 0; k < 4; k++) { const t = J[c * 4 + k]; J[c * 4 + k] = J[p * 4 + k]; J[p * 4 + k] = t; } const t = d[c]; d[c] = d[p]; d[p] = t; }
    const inv = 1 / J[c * 4 + c];
    for (let r = c + 1; r < 4; r++) {
      const f = J[r * 4 + c] * inv;
      if (f === 0) continue;
      for (let k = c; k < 4; k++) J[r * 4 + k] -= f * J[c * 4 + k];
      d[r] -= f * d[c];
    }
  }
  for (let r = 3; r >= 0; r--) {
    let s = d[r];
    for (let k = r + 1; k < 4; k++) s -= J[r * 4 + k] * d[k];
    d[r] = s / J[r * 4 + r];
  }
}

// ---- the treble booster's transistor ---------------------------------------
//
// One germanium common-emitter stage (Rangemaster: 470k/68k bias, 10k
// collector, 3.9k emitter bypassed by 47 uF, ~0.26 mA). `boost` takes the
// emitter's bypass from part of the 3.9k to all but 150 ohms, so the gain
// runs from ~2.5 to ~40. The emitter current is the exponential of the base
// voltage less what the unbypassed resistor takes back (the Lambert-W
// equation; Newton in log current from the last sample), so it bends one
// way only: soft as the current runs out, hard where the collector meets
// the emitter. Its input is the source branch (pickup, or a buffer) into
// the input cap (`focus`: 1 uF, full range, to the original 5 nF) and the
// stage's input resistance: with a guitar straight in, the coil and the
// 5 nF resonate near 1.4 kHz, the treble booster's famous upper-mid push.
const RM_IE = 0.26e-3, RM_RC = 10e3, RM_VT = 0.0259, RM_SAT = 5.3, RM_BIAS = 59e3, RM_BETA = 100;

// ---- Klon Centaur --------------------------------------------------------------
const KL_R20 = 392e3, KL_C13 = 820e-12, KL_R11 = 15e3, KL_R12 = 422e3, KL_C7 = 82e-9, KL_C8 = 390e-12;
/** The 18 V / -9 V charge pump around the 4.5 V reference: the summing amp's swing. */
const KL_RAIL_P = 11.7, KL_RAIL_N = 13.1;

/** The static curve (filters and caps left out) at volts in, for the pedal's picture. */
export function driveCurve(type: number, gain: number, x: number): number {
  if (type === DRIVE_GLOW) { const R = glowR(gain); return x + diodePair(R / TS_R1 * x, R); }
  if (type === DRIVE_RASP) { const R = raspPot(gain); return diodePair(rails((1 + R / 560 + R / 47) * x, RAT_RAIL), 1e3); }
  if (type === DRIVE_FUZZ) return tanhf(1.5 * germanium((6 + 260 * gain * gain) * x));
  if (type === DRIVE_MUFF) {
    const a = 0.005 + audioTaper(gain), K1 = MUFF_RF / (MUFF_RG1 + PICKUP_R), K = MUFF_RF / (MUFF_RG + MUFF_ROUT);
    return diodePair(K * diodePair(K * a * rails(K1 * x, 4), MUFF_RF), MUFF_RF);
  }
  if (type === DRIVE_BOOST) {
    const ra = 150 + (1 - gain) * (1 - gain) * 3750, a = ra * RM_IE / RM_VT, z = x / RM_VT;
    let u = 0;
    for (let k = 0; k < 30; k++) { const e = Math.exp(u); u -= (u - z + a * (e - 1)) / (1 + a * e); }
    const v = RM_RC * RM_IE * (Math.exp(u) - 1);
    return RM_SAT - knee(RM_SAT - v, 0.15);
  }
  if (type === DRIVE_TRANSPARENT) {
    const A = 1 + KL_R12 / (KL_R11 + 2e3 + (1 - gain) * 100e3);
    return KL_R20 * (x * (1 - gain) / 60e3 + diodePairOf(rails(A * x, KL_RAIL_P), 1e3, GE_IS, GE_NVT) / 47e3);
  }
  if (type === DRIVE_METAL) return diodePair(rails((5 + 100 * gain * gain) * x, 3.8) * 46, 2.2e3);
  const s = 2 * germanium(0.5 * (1.5 + 6 * gain) * x);
  return germanium((2 + 10 * gain) * (knee(Math.abs(s) - 0.15, 0.03) + 0.12 * s));
}

/** The circuits that run at DRIVE_RATE_HARD (32x at 44.1/48 kHz): the hard clippers and the fuzz; the rest at DRIVE_RATE. */
const HARD = [0, 1, 1, 0, 0, 0, 1, 1];
/** Each circuit's own input coupling (Hz), at the base rate. */
const IN_HP = [15.9, 7.2, 3, 3, 3, 1.6, 20, 20];

export class Drive {
  private os: Oversampler;
  /** The oversampling factors: 16 and 32 at 44.1 and 48 kHz (DRIVE_RATE, DRIVE_RATE_HARD). */
  readonly factor: number; readonly factorHard: number;
  private osHard: Oversampler;
  private up: Float32Array;
  private aux: Float32Array;
  private ff1 = new Float32Array(MAX_BLOCK); private aux2: Float32Array; private os2: Oversampler;
  private readonly fs: number;
  private readonly fsOs: number;
  // glow: the 720 Hz leg, the feedback voltage, the tone stage, the second input high-pass
  private gHp: OnePoleHP; private gV = 0; private gTone = new Biquad(); private gTable: AsymTable; private inHp2: OnePoleHP;
  private gToneKnob = -1;
  // rasp: the op-amp's output, its inverting input, the two gain legs' caps; the output coupling and filter
  private rVo = 0; private rVn = 0; private rVa = 0; private rVb = 0; private rW = 0; private rHp: OnePoleHP; private rLp: OnePoleLP;
  // fuzz
  private ff: FuzzFace; private fDc: OnePoleHP; private fLp: OnePoleLP;
  // muff: input branch (coil current, cap), the stages' feedback and diode-cap voltages, the couplings; the tone stack
  private mI = 0; private mC = 0; private mV1 = 0;
  private mC2 = 0; private mV2 = 0; private mD2 = 0; private mC3 = 0; private mV3 = 0; private mD3 = 0;
  private mK1 = new FirstOrder(); private mK2 = new FirstOrder(); private mK3 = new FirstOrder();
  private mTable: DiodeTable; private mStack: LinearNet; private mPotA: number; private mPotB: number; private mToneKnob = -1;
  // boost: the input branch (coil current, cap voltage) and the stage's log current
  private bI = 0; private bVc = 0; private bU = 0;
  // transparent
  private kPre: LinearNet; private kRg: number; private kFf2: LinearNet; private kTop: number; private kBot: number;
  private kAmp = new Biquad(); private kClip: LinearNet; private kTable: DiodeTable; private kSum = new FirstOrder(); private kTone = new FirstOrder();
  private kGain = -1; private kToneKnob = -1;
  // octave
  private oHp: OnePoleHP; private oDc: OnePoleHP; private oLp: OnePoleLP;
  // metal: the two stages' gain legs and feedback caps, the mid push, the diodes-to-ground node, the scoop
  private xHp1: OnePoleHP; private xLp1: OnePoleLP; private xMid = new Biquad(); private xHp2: OnePoleHP; private xV2 = 0; private xV3 = 0;
  private xTable2: DiodeTable; private xTable3: DiodeTable; private xScoop = new Biquad();
  // after the circuit, at the base rate
  private tone: OnePoleLP; private tone2: OnePoleLP;
  private inHp: OnePoleHP;
  /** The DI's coil-and-cable resonance taken back out for the circuits that load the pickup (they model it themselves). */
  private diBq = new Biquad();
  /** The booster's 10 nF output cap into the next unit's ~1M (16 Hz). */
  private bOut: OnePoleHP;
  private lastType = -1;
  /** For the UI: how far past its knee the circuit was pushed (peak of the input to the clipper, in knee units). */
  push = 0;
  /** Peak input, volts, for the picture's live dot. */
  peakIn = 0;

  constructor(sampleRate: number) {
    const F = osFactor(sampleRate, DRIVE_RATE), FH = osFactor(sampleRate, DRIVE_RATE_HARD), fs = sampleRate, fo = sampleRate * F, T = 1 / fo;
    const fh = sampleRate * FH, TH = 1 / fh;
    this.fs = fs; this.fsOs = fo; this.factor = F; this.factorHard = FH;
    this.up = new Float32Array(MAX_BLOCK * FH); this.aux = new Float32Array(MAX_BLOCK * FH); this.aux2 = new Float32Array(MAX_BLOCK * FH);
    this.os = new Oversampler(fs, F); this.os2 = new Oversampler(fs, F); this.osHard = new Oversampler(fs, FH);
    this.gHp = new OnePoleHP(fo, 1 / (2 * Math.PI * TS_R1 * TS_CZ)); this.inHp2 = new OnePoleHP(fs, 15.6);
    this.gTable = new AsymTable(DIODE_IS, DIODE_IS * TS_ASYM, DIODE_NVT);
    this.rHp = new OnePoleHP(fh, 1 / (2 * Math.PI * 1e3 * 4.7e-6)); this.rLp = new OnePoleLP(fh, 20000);
    this.ff = new FuzzFace(fh); this.fDc = new OnePoleHP(fs, 1 / (2 * Math.PI * 500e3 * 10e-9)); this.fLp = new OnePoleLP(fs, 20000);
    // a muff clipping stage's backward-Euler step: v + (B/A) Id(v) = u (see process)
    const A = 1 / MUFF_RF + MUFF_CF / T, B = 1 + A * T / MUFF_CD;
    this.mTable = sharedTable(B / A);
    // the Ram's Head tone stack: source (the stage's output resistance), 39k into 10 nF, 4 nF into 22k, the 100k pot between them, the output stage's 100k
    const st = new LinearNet(4, fs);   // 2 S, 3 L, 4 H, 5 W
    st.r(1, 2, MUFF_ROUT); st.r(2, 3, 39e3); st.c(3, 0, 10e-9); st.c(2, 4, 4e-9); st.r(4, 0, 22e3);
    this.mPotA = st.r(3, 5, 50e3); this.mPotB = st.r(5, 4, 50e3); st.r(5, 0, 100e3);
    this.mStack = st;
    // the Klon's pre-amp (C3 into node 2; C5 || R6 then the gain pot's first gang to ground; R7 into C16 || 15k: feed-forward 1)
    const pre = new LinearNet(3, fs);  // 2 N, 3 m1, 4 m2
    pre.c(1, 2, 0.1e-6); pre.r(2, 3, 10e3); pre.c(2, 3, 68e-9); this.kRg = pre.r(3, 0, 50e3);
    pre.r(2, 4, 1.5e3); pre.r(4, 0, 15e3); pre.c(4, 0, 1e-6);
    this.kPre = pre;
    // feed-forward 2: R5 || C4, R8 and C6 + R9 to ground, the gain pot's second gang (top, bottom), then C11 + R15 + R16 and (C12 + R18) || R17 to the summing node
    const f2 = new LinearNet(6, fs);   // 2 n1, 3 n2, 4 C6/R9, 5 C11/R15, 6 R15/R16, 7 C12/R18
    f2.r(1, 2, 5.1e3); f2.c(1, 2, 68e-9); f2.r(2, 0, 1.5e3); f2.c(2, 4, 390e-9); f2.r(4, 0, 1e3);
    this.kTop = f2.r(2, 3, 50e3); this.kBot = f2.r(3, 0, 50e3);
    f2.c(3, 5, 2.2e-9); f2.r(5, 6, 22e3); f2.r(6, 0, 47e3); f2.c(3, 7, 27e-9); f2.r(7, 0, 12e3); f2.r(3, 0, 27e3);
    this.kFf2 = f2;
    // the clipper at 8x: C9, R13 into the diodes, C10 and 47k into the summing node
    const cl = new LinearNet(3, fo);   // 2 a, 3 d, 4 e
    cl.c(1, 2, 1e-6); cl.r(2, 3, 1e3); cl.c(3, 4, 1e-6); cl.r(4, 0, 47e3);
    this.kClip = cl; this.kTable = sharedTable(cl.rth(3), GE_IS, GE_NVT);
    this.kSum.set(fs, KL_R20, 0, 1, KL_R20 * KL_C13);
    this.oHp = new OnePoleHP(fh, 140); this.oDc = new OnePoleHP(fh, 60); this.oLp = new OnePoleLP(fh, 6000);
    // metal: stage 1 (4.7k + 150 nF leg, 4.7k + 100k pot across 330 pF), a +8 dB push at 1 kHz, stage 2 (2.2k + 1 uF, 100k across 470 pF, diodes), 2.2k into diodes || 10 nF
    this.xHp1 = new OnePoleHP(fh, 1 / (2 * Math.PI * 4.7e3 * 150e-9)); this.xLp1 = new OnePoleLP(fh, 5000);
    this.xMid.peak(fh, 1000, 0.7, 8);
    this.xHp2 = new OnePoleHP(fh, 1 / (2 * Math.PI * 2.2e3 * 1e-6));
    this.xTable2 = sharedTable(1 / (470e-12 / TH + 1 / 100e3));
    this.xTable3 = sharedTable(1 / (1 / 2.2e3 + 10e-9 / TH));
    this.xScoop.peak(fs, 750, 0.8, -7);
    this.tone = new OnePoleLP(fs, 3000); this.tone2 = new OnePoleLP(fs, 9000);
    this.inHp = new OnePoleHP(fs, 25);
    this.bOut = new OnePoleHP(fs, 1 / (2 * Math.PI * 1e6 * 10e-9));
    // the 1M-loaded pickup's response D(s) over a maximally flat one with the same corner: the peak comes out, the
    // level and the roll-off stay (the circuits then put the coil's own source impedance back in)
    const rd = 1 / (1 / DI_LOAD + 1 / PICKUP_EDDY), LC = PICKUP_L * PICKUP_C, a0 = 1 + PICKUP_R / rd;
    bilinear2(fs, LC, PICKUP_L / rd + PICKUP_R * PICKUP_C, a0, LC, Math.SQRT2 * Math.sqrt(LC * a0), a0, this.diBq);
  }

  reset(): void {
    this.os.reset(); this.os2.reset(); this.osHard.reset(); this.ff.reset(); this.fDc.reset(); this.fLp.z = 0; this.bI = 0; this.bVc = 0; this.bU = 0;
    this.gHp.reset(); this.gV = 0; this.gTone.reset(); this.inHp2.reset();
    this.rVo = 0; this.rVn = 0; this.rVa = 0; this.rVb = 0; this.rW = 0; this.rHp.reset(); this.rLp.z = 0;
    this.mI = 0; this.mC = 0; this.mV1 = 0; this.mC2 = 0; this.mV2 = 0; this.mD2 = 0; this.mC3 = 0; this.mV3 = 0; this.mD3 = 0; this.mStack.reset(); this.mK1.reset(); this.mK2.reset(); this.mK3.reset();
    this.kPre.reset(); this.kFf2.reset(); this.kAmp.reset(); this.kClip.reset(); this.kSum.reset(); this.kTone.reset();
    this.oHp.reset(); this.oDc.reset(); this.oLp.z = 0;
    this.xHp1.reset(); this.xLp1.z = 0; this.xMid.reset(); this.xHp2.reset(); this.xV2 = 0; this.xV3 = 0; this.xScoop.reset();
    this.tone.z = 0; this.tone2.z = 0; this.inHp.reset(); this.diBq.reset(); this.bOut.reset();
  }

  /**
   * In place, base rate. `srcR` and `srcL` are what drives the input (ohms,
   * henries): the fuzz, the muff and the booster load it; the other circuits
   * have a buffered, high-impedance input and ignore it.
   */
  process(x: Float32Array, n: number, type: number, gain: number, toneKnob: number, levelDb: number, srcR = BUFFER_R, srcL = 0): void {
    if (type !== this.lastType) { this.reset(); this.lastType = type; }
    const os = HARD[type] ? this.osHard : this.os, fs = this.fs, fo = fs * os.factor, T = 1 / fo;
    let peakIn = 0;
    this.inHp.set(fs, IN_HP[type]);
    const loads = srcL > 0 && (type === DRIVE_FUZZ || type === DRIVE_MUFF || type === DRIVE_BOOST);
    for (let i = 0; i < n; i++) {
      let v = this.inHp.tick(x[i]);
      if (type === DRIVE_GLOW) v = this.inHp2.tick(v);
      if (loads) v = this.diBq.tick(v);
      x[i] = v;
      const a = Math.abs(v); if (a > peakIn) peakIn = a;
    }
    this.peakIn = peakIn;
    const up = this.up, m = n * os.factor;
    const out = dbToGain(levelDb - 12);
    let push = 0;
    if (type === DRIVE_TRANSPARENT) {
      // base rate: the pre-amp (and feed-forward 1), the amplifier stage on its 9 V rails, feed-forward 2
      if (gain !== this.kGain) {
        this.kGain = gain;
        this.kPre.setR(this.kRg, Math.max(1, gain * 100e3));
        this.kFf2.setR(this.kTop, Math.max(1, gain * 100e3)); this.kFf2.setR(this.kBot, Math.max(1, (1 - gain) * 100e3));
        const r10 = (1 - gain) * 100e3 + 2e3, a2 = KL_C7 * KL_C8 * r10 * KL_R11 * KL_R12, a1 = KL_C7 * r10 * KL_R11 + KL_C8 * KL_R12 * (r10 + KL_R11), a0 = r10 + KL_R11;
        bilinear2(fs, a2, KL_C7 * KL_R11 * KL_R12 + a1, KL_R12 + a0, a2, a1, a0, this.kAmp);
      }
      const pre = this.kPre, f2 = this.kFf2, ff1 = this.ff1;
      for (let i = 0; i < n; i++) {
        const v = x[i];
        pre.tick(v);
        x[i] = this.kAmp.tick(pre.v[2]);
        f2.tick(v);
        // feed-forward 1 and 2, summed: they go through the same up- and downsampling as the clipped path, so the three stay in phase
        ff1[i] = pre.v[4] / 15e3 + f2.v[6] / 47e3;
        const a = Math.abs(x[i]); if (a > push) push = a;
      }
      this.os2.upsample(ff1, this.aux2, n);
      push /= 0.3;
    }
    os.upsample(x, up, n);
    if (type === DRIVE_GLOW) {
      // Yeh's clipping-stage ODE, Cc dV/dt = I - V / R2 - Id(V), backward Euler: V + r Id(V) = r (I + Cc/T V[n-1])
      const R2 = glowR(gain), cT = TS_CC / T, r = quantR(1 / (cT + 1 / R2)), tab = this.gTable;
      tab.build(r);
      let V = this.gV;
      for (let i = 0; i < m; i++) {
        const v = up[i];
        const u = r * (this.gHp.tick(v) / TS_R1 + cT * V);
        const a = Math.abs(u); if (a > push) push = a;
        V = tab.at(u);
        up[i] = v + V;
      }
      this.gV = V;
      push /= 0.6;
    } else if (type === DRIVE_RASP) {
      // the op-amp: dVo/dt = SR tanh(GBW (V+ - V-) / SR), slowing into its rails; V- from the feedback network (backward Euler companions)
      const Rd = raspPot(gain), cf = RAT_CF / T, gf = 1 / Rd + cf;
      const ca = RAT_CA / T, cb = RAT_CB / T, ka = ca / RAT_RA / (1 / RAT_RA + ca), kb = cb / RAT_RB / (1 / RAT_RB + cb);
      // the filter: 1.5k plus the 100k pot (reverse audio: `tone` 10 is open) into 3.3 nF
      const rf = 1.5e3 + 100e3 * (1 - toneKnob) * (1 - toneKnob);
      this.rLp.set(fo, Math.min(0.2 * fo, 1 / (2 * Math.PI * rf * 3.3e-9)));
      const Dn = gf + ka + kb, alpha = gf / Dn, kg = RAT_GBW / RAT_SR, step = T * RAT_SR, ir = 1 / RAT_RAIL, ground = sharedGround();
      let Vo = this.rVo, Vn = this.rVn, Va = this.rVa, Vb = this.rVb;
      for (let i = 0; i < m; i++) {
        const vp = up[i];
        // the inverting input is linear in Vo: Vn = alpha Vo + beta
        const beta = (-cf * (Vo - Vn) + ka * Va + kb * Vb) / Dn;
        const V0 = Vo;
        let vo = V0;
        for (let it = 0; it < 4; it++) {
          const e = kg * (vp - alpha * vo - beta), t = tanhf(e), A2 = Math.sqrt(t * t + 1e-4);
          // into a rail the slew slows to nothing; away from it the op-amp slews at its normal rate (only the
          // part of t pointing into the rail is taken away: 0.5 (t |s|^7 + |t| s^7))
          const s = vo * ir, s3 = s * s * s, s6 = s3 * s3, s7 = s6 * s, as7 = s7 < 0 ? -s7 : s7, sg = s < 0 ? -1 : 1;
          const rate = t - 0.5 * (t * as7 + A2 * s7);
          const dt = -kg * alpha * d308(e), dA = t * dt / A2;
          const h = vo - V0 - step * rate, dh = 1 - step * (dt - 0.5 * (dt * as7 + t * 7 * s6 * ir * sg + dA * s7 + A2 * 7 * s6 * ir));
          const dv = h / dh;
          vo -= dv;
          if (vo > RAT_RAIL * 1.02) vo = RAT_RAIL * 1.02; else if (vo < -RAT_RAIL * 1.02) vo = -RAT_RAIL * 1.02;
          if (dv < 1e-9 && dv > -1e-9) break;
        }
        Vo = vo;
        Vn = alpha * Vo + beta;
        Va = (Vn / RAT_RA + ca * Va) / (1 / RAT_RA + ca);
        Vb = (Vn / RAT_RB + cb * Vb) / (1 / RAT_RB + cb);
        const a = Math.abs(Vo); if (a > push) push = a;
        const w = this.rHp.tick(Vo);
        up[i] = this.rLp.tick(ground.adaa(w, this.rW)); this.rW = w;
      }
      this.rVo = Vo; this.rVn = Vn; this.rVa = Va; this.rVb = Vb;
      push /= 0.55;
    } else if (type === DRIVE_MUFF) {
      this.muffClip(up, m, gain, srcR, srcL);
      push = this.push;
    } else if (type === DRIVE_BOOST) {
      // the source into the input cap and the stage's input resistance: a linear branch, backward Euler
      const cin = 1e-6 * Math.pow(0.005, toneKnob);
      const ra = 150 + (1 - gain) * (1 - gain) * 3750, re = RM_VT / RM_IE;
      const zin = 1 / (1 / RM_BIAS + 1 / ((RM_BETA + 1) * (re + ra)));
      const lt = srcL / T, tc = T / cin, gin = 1 / (srcR + lt + tc), div = 1 / (1 + gin * zin);
      const a = ra * RM_IE / RM_VT, Gs = RM_RC / (re + ra);
      let bi = this.bI, bvc = this.bVc, u = this.bU;
      for (let i = 0; i < m; i++) {
        const cur = gin * (up[i] - bvc + lt * bi) * div;
        bi = cur; bvc += tc * cur;
        const vb = cur * zin;
        const p = Math.abs(vb) * Gs; if (p > push) push = p;
        // emitter current Ie0 e^u with u - vb/Vt + a (e^u - 1) = 0
        const z = vb / RM_VT;
        for (let k = 0; k < 2; k++) { const e = Math.exp(u); u -= (u - z + a * (e - 1)) / (1 + a * e); }
        const v = RM_RC * RM_IE * (Math.exp(u) - 1) * (RM_BETA / (RM_BETA + 1));
        // the collector can only come down as far as the emitter
        up[i] = RM_SAT - knee(RM_SAT - v, 0.15);
      }
      this.bI = bi; this.bVc = bvc; this.bU = u;
      push /= 1.5;
    } else if (type === DRIVE_TRANSPARENT) {
      // the amplifier stage's output through C9 and R13 into the 1N34As, out through C10 as a current
      const cl = this.kClip, tab = this.kTable, aux = this.aux;
      // (the amplifier's rails, the charge pump's, at 8x where clipping can't fold back)
      const ffs = this.aux2;
      for (let i = 0; i < m; i++) { const a = up[i]; cl.tickDiode(a >= 0 ? rails(a, KL_RAIL_P) : rails(a, KL_RAIL_N), 3, tab); aux[i] = cl.v[4] / 47e3 + ffs[i]; }
      this.os.downsample(aux, x, n);
      // the summing amp: the three currents into 392k || 820 pF, on the charge pump's rails
      const sum = this.kSum;
      if (toneKnob !== this.kToneKnob) {
        this.kToneKnob = toneKnob;
        const C = 3.9e-9, G1 = 1 / 100e3, G2 = 1 / (1.8e3 + (1 - toneKnob) * 10e3), G3 = 1 / (4.7e3 + toneKnob * 10e3), G4 = 1 / 100e3;
        this.kTone.set(fs, G1 * (G2 + G3), C * (G1 + G2), G4 * (G2 + G3), C * (G3 - G4));
      }
      for (let i = 0; i < n; i++) {
        const v = sum.tick(x[i]);
        x[i] = this.kTone.tick(v >= 0 ? rails(v, KL_RAIL_P) : rails(v, KL_RAIL_N)) * out;
      }
      this.push = push;
      return;
    } else if (type === DRIVE_OCTAVE) {
      // the Octavia: a transistor stage, the transformer's two halves into two germanium diodes (full-wave:
      // the octave), a little of the fundamental leaking past them, then the output transistor clipping it
      const G1 = 1.5 + 6 * gain, G2 = 2 + 10 * gain;
      for (let i = 0; i < m; i++) {
        const u = G1 * this.oHp.tick(up[i]);
        const a = Math.abs(u); if (a > push) push = a;
        const s = 2 * germanium(0.5 * u);
        const r = knee(Math.sqrt(s * s + 4e-4) - 0.02 - 0.15, 0.03);
        up[i] = this.oLp.tick(germanium(G2 * this.oDc.tick(r + 0.12 * s)));
      }
    } else if (type === DRIVE_METAL) {
      // stage 1: v + (Rf/Rg) HP(v) through the feedback cap's pole, into the rails; the mid push;
      // stage 2: diodes in the feedback across 470 pF (backward Euler); diodes to ground across 10 nF (backward Euler)
      const rf1 = 4.7e3 + 100e3 * gain * gain, G1 = rf1 / 4.7e3;
      this.xLp1.set(fo, Math.min(0.2 * fo, 1 / (2 * Math.PI * rf1 * 330e-12)));
      const c2 = 470e-12 / T, r2 = this.xTable2.r, c3 = 10e-9 / T, r3 = this.xTable3.r;
      let V2 = this.xV2, V3 = this.xV3;
      for (let i = 0; i < m; i++) {
        const v = up[i];
        const u1 = G1 * this.xHp1.tick(v);
        const a = Math.abs(u1); if (a > push) push = a;
        const s1 = this.xMid.tick(rails(v + this.xLp1.tick(u1), 3.8));
        V2 = this.xTable2.at(r2 * (this.xHp2.tick(s1) / 2.2e3 + c2 * V2));
        V3 = this.xTable3.at(r3 * ((s1 + V2) / 2.2e3 + c3 * V3));
        up[i] = V3;
      }
      this.xV2 = V2; this.xV3 = V3;
      push /= 2;
    } else {
      // the fuzz pot's resistance above the wiper (unbypassed), squared so the knob's travel is even in dB
      const ff = this.ff, ra = Math.max(1, (1 - gain) * (1 - gain) * FF_RE), rb = Math.max(1, FF_RE - ra);
      for (let i = 0; i < m; i++) {
        const v = up[i];
        const a = Math.abs(v); if (a > push) push = a;
        up[i] = ff.tick(v, srcR, srcL, ra, rb);
      }
      push *= 20;
    }
    this.push = push;
    os.downsample(up, x, n);
    // tone and level
    if (type === DRIVE_GLOW) {
      if (toneKnob !== this.gToneKnob) { this.gToneKnob = toneKnob; tsTone(this.gTone, fs, toneKnob); }
      for (let i = 0; i < n; i++) x[i] = this.gTone.tick(x[i]) * out;
      return;
    }
    if (type === DRIVE_RASP) {
      for (let i = 0; i < n; i++) x[i] *= out;
      return;
    }
    if (type === DRIVE_MUFF) {
      if (toneKnob !== this.mToneKnob) {
        this.mToneKnob = toneKnob;
        this.mStack.setR(this.mPotA, Math.max(1, toneKnob * 100e3)); this.mStack.setR(this.mPotB, Math.max(1, (1 - toneKnob) * 100e3));
      }
      // the output stage clips on its rails at the oversampled rate (at the base rate, with the treble up, it folded back at -53..-60 dB)
      const st = this.mStack, ax = this.aux2;
      for (let i = 0; i < n; i++) { st.tick(x[i]); x[i] = MUFF_GOUT * st.v[5]; }
      this.os2.upsample(x, ax, n);
      for (let i = 0; i < m; i++) ax[i] = rails(ax[i], 4);
      this.os2.downsample(ax, x, n);
      for (let i = 0; i < n; i++) x[i] *= out;
      return;
    }
    if (type === DRIVE_BOOST) {
      this.tone.set(fs, 9000);
      for (let i = 0; i < n; i++) x[i] = this.bOut.tick(this.tone.tick(x[i])) * out;
      return;
    }
    if (type === DRIVE_METAL) {
      this.tone.set(fs, 1500 * Math.pow(6, toneKnob));
      for (let i = 0; i < n; i++) x[i] = this.tone.tick(this.xScoop.tick(x[i])) * out;
      return;
    }
    if (type === DRIVE_FUZZ) {
      // the output cap into the volume pot; `tone` a gentle low-pass after it (open at 10)
      this.fLp.set(fs, Math.min(0.45 * fs, 600 * Math.pow(36, toneKnob)));
      for (let i = 0; i < n; i++) x[i] = this.fLp.tick(this.fDc.tick(x[i])) * out;
      return;
    }
    const fTone = 700 * Math.pow(12, toneKnob);
    this.tone.set(fs, fTone);
    this.tone2.set(fs, Math.min(fTone * 2.5, fs * 0.45));
    for (let i = 0; i < n; i++) x[i] = this.tone2.tick(this.tone.tick(x[i])) * out;
  }

  /**
   * The Big Muff up to its tone stack, at 8x, in place. Each clipping stage
   * is an inverting transistor stage, a virtual earth at its base: the input
   * current through the coupling cap and RG, the feedback through 470k ||
   * 470 pF and through the diodes in series with 1 uF. With w the diodes'
   * voltage and vcd the cap's, backward Euler gives
   *   w + (B / A) Id(w) = (-i + Cf/T vf[n-1]) / A - vcd[n-1],
   * A = 1/Rf + Cf/T, B = 1 + A T / Cd: one table lookup, exact.
   */
  private muffClip(up: Float32Array, m: number, gain: number, srcR: number, srcL: number): void {
    const T = 1 / this.fsOs, cf = MUFF_CF / T, A = 1 / MUFF_RF + cf, rB = this.mTable.r, tab = this.mTable;
    // stage 1 input: the source into 1 uF and 39k (a virtual earth); its gain is short of ideal by the transistor's own
    const lt = srcL / T, tc = T / MUFF_CC, g1 = 1 / (srcR + MUFF_RG1 + lt + tc);
    // each stage's shortfall from the ideal virtual earth, k = 1 / (1 + (1 + Rf / Rin) / A), as a shelf from A_LF to A_HF
    const kf = (q: FirstOrder, ideal: number) => {
      const lo = 1 / (1 + (1 + ideal) / MUFF_A_LF), hi = 1 / (1 + (1 + ideal) / MUFF_A_HF);
      q.set(this.fsOs, lo, hi / MUFF_WC, 1, 1 / MUFF_WC);
    };
    const ideal1 = MUFF_RF / (srcR + MUFF_RG1);
    // the sustain pot (100k audio) between stage 1 and stage 2: a divider with its own source resistance
    const a = 0.005 + 0.995 * audioTaper(gain), rIn2 = MUFF_RG + 1e3 + 100e3 * a * (1 - a), rIn3 = MUFF_RG + MUFF_ROUT;
    kf(this.mK1, ideal1); kf(this.mK2, MUFF_RF / rIn2); kf(this.mK3, MUFF_RF / rIn3);
    const K1 = this.mK1, K2 = this.mK2, K3 = this.mK3;
    const t2 = T / MUFF_CC, i2 = 1 / (rIn2 + t2), i3 = 1 / (rIn3 + t2), kT = T / MUFF_CD;
    let mI = this.mI, mC = this.mC, V1 = this.mV1, C2 = this.mC2, V2 = this.mV2, D2 = this.mD2, C3 = this.mC3, V3 = this.mV3, D3 = this.mD3;
    let push = 0;
    for (let i = 0; i < m; i++) {
      // stage 1: no diodes, the transistor's swing
      const vin = up[i] - mC + lt * mI, cur = g1 * vin;
      mI = cur; mC += tc * cur;
      V1 = (-K1.tick(cur) + cf * V1) / A;
      const o1 = V1 >= 0 ? rails(V1, MUFF_UP) : rails(V1, MUFF_DOWN);
      // stage 2
      const c2 = i2 * (a * o1 - C2); C2 += t2 * c2;
      const u2 = (-K2.tick(c2) + cf * V2) / A - D2;
      const p = Math.abs(u2); if (p > push) push = p;
      const w2 = tab.at(u2);
      D2 += kT * (u2 - w2) / rB;
      V2 = w2 + D2;
      // stage 3
      const c3 = i3 * (V2 - C3); C3 += t2 * c3;
      const u3 = (-K3.tick(c3) + cf * V3) / A - D3;
      const w3 = tab.at(u3);
      D3 += kT * (u3 - w3) / rB;
      V3 = w3 + D3;
      up[i] = V3;
    }
    this.mI = mI; this.mC = mC; this.mV1 = V1; this.mC2 = C2; this.mV2 = V2; this.mD2 = D2; this.mC3 = C3; this.mV3 = V3; this.mD3 = D3;
    this.push = push / 0.6;
  }
}

let GROUND: DiodeTable | null = null;
/** 1N914s to ground through 1k (the RAT's clipper). */
function sharedGround(): DiodeTable { if (!GROUND) GROUND = new DiodeTable(1e3); return GROUND; }
