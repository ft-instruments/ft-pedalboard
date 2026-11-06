// The drive pedal: three circuits behind one footswitch. Signals are in
// volts (a DI guitar peaks around 0.1 to 0.5); everything nonlinear runs at
// 8x.
//
//  glow  op-amp with the diodes in its feedback loop (the green overdrive):
//        only the part above ~720 Hz is amplified and clipped, then added
//        back to the clean signal, so it is soft, mid-humped and keeps
//        the pick attack.
//  rasp  op-amp with up to 67 dB of gain into hard diodes to ground (the
//        black distortion box): the op-amp's gain-bandwidth closes the top
//        end as gain goes up, and its slew rate rounds the edges.
//  fuzz  two starved germanium transistors: lopsided clipping, a bias that
//        shifts under heavy playing (the sputter as a note dies) and a lot
//        of gain. Rolling the input down cleans it up.
//  muff  two cascaded clipping stages (soft, then hard) with a high-pass
//        between them, and the passive tone control that crossfades a low
//        pass at 400 Hz with a high pass at 1.8 kHz: the mids scoop out at
//        noon. Sustain is the gain of the stages, so it holds a note long
//        after the pick has gone.
//  transparent
//        a Klon-style overdrive: the clean signal stays under a soft
//        germanium clipper that only sees 220 Hz to 4.5 kHz, so the
//        low end and the pick attack survive; `treble` is a shelf after it.
//  metal a 150 Hz high-pass into three cascaded clippers (the last one hard
//        diodes), then a mid scoop at 700 Hz.
//  octave
//        a fuzz with a full-wave rectifier in it: the rectified half of the
//        wave is an octave up, mixed under the fuzz. It tracks one note at a
//        time and works best with the tone knob back, high up the neck.
//  boost one germanium stage behind an input high-pass (`focus` moves its
//        corner from 70 Hz to ~900 Hz): a treble booster that thins the
//        low end, saturates a little and pushes the amp's first stage.

import { Oversampler, OS, OnePoleLP, OnePoleHP, Biquad, tanhf, dbToGain } from './util.ts';

export const DRIVE_GLOW = 0, DRIVE_RASP = 1, DRIVE_FUZZ = 2, DRIVE_MUFF = 3, DRIVE_BOOST = 4, DRIVE_TRANSPARENT = 5, DRIVE_METAL = 6, DRIVE_OCTAVE = 7;

const MAX_BLOCK = 512;

/** Diodes in a feedback loop: soft knee, ~0.6 V ceiling. */
function diodeFeedback(u: number): number { return u / Math.sqrt(1 + u * u * 2.78); }
/** Silicon diodes to ground through 1k: a harder knee. */
function diodeGround(u: number): number { const a = Math.abs(u) * 1.82; return u / Math.pow(1 + a * a * Math.sqrt(a), 0.4); }
/** Germanium pair, lopsided: the negative side gives up earlier. */
function germanium(v: number): number { return v >= 0 ? tanhf(v) : 0.62 * tanhf(v * 1.9); }

function glowGain(g: number): number { return (51e3 + 500e3 * g * g) / 4.7e3; }
function raspPot(g: number): number { return 100 + 100e3 * g * g * Math.sqrt(g); }
function fuzzGain(g: number): number { return 6 + 260 * g * g; }
function muffGain1(g: number): number { return 6 + 60 * g * g; }
function muffGain2(g: number): number { return 3 + 9 * g; }
function boostGain(g: number): number { return 1.5 + 16 * g; }
function clearGain(g: number): number { return 3 + 40 * g * g; }
function metalGain(g: number): number { return 8 + 70 * Math.pow(g, 1.3); }
function octaveGain(g: number): number { return 4 + 60 * g * g; }
/** First muff stage: diodes in the feedback loop, soft, knee at 0.6 V. */
function muffSoft(u: number): number { return u / Math.sqrt(1 + (u * u) / 0.36); }
function muffHard(u: number): number { return 0.6 * tanhf(u / 0.6); }

/** The static curve (filters left out) at volts in, for the pedal's picture. */
export function driveCurve(type: number, gain: number, x: number): number {
  if (type === DRIVE_GLOW) return x + diodeFeedback(glowGain(gain) * x);
  if (type === DRIVE_RASP) { const R = raspPot(gain); return diodeGround(4.5 * tanhf((1 + R / 560 + R / 47) * x / 4.5)); }
  if (type === DRIVE_FUZZ) return tanhf(1.5 * germanium(fuzzGain(gain) * x));
  if (type === DRIVE_MUFF) return muffHard(muffGain2(gain) * muffSoft(muffGain1(gain) * x));
  if (type === DRIVE_BOOST) { const G = boostGain(gain); return germanium(G * x) * Math.pow(G, -0.3); }
  if (type === DRIVE_TRANSPARENT) return x * (1 - 0.4 * gain) + 0.54 * germanium(clearGain(gain) * x);
  if (type === DRIVE_METAL) return diodeGround(5 * tanhf(tanhf(metalGain(gain) * x) * 3));
  const s = tanhf(octaveGain(gain) * x);
  return 0.5 * s + 0.9 * Math.abs(s);
}

/** Rough output ceiling of each circuit, to make the level knob read 0 dB near unity. */
const CEILING = [0.75, 0.55, 1, 0.6, 0.35, 0.6, 0.55, 1.2];

export class Drive {
  private os: Oversampler;
  private up = new Float32Array(MAX_BLOCK * OS);
  private readonly fs: number;
  private readonly fsOs: number;
  // glow
  private gHp: OnePoleHP; private gLp: OnePoleLP;
  // rasp
  private rHpLo: OnePoleHP; private rHpHi: OnePoleHP; private rGbw: OnePoleLP;
  private rLast = 0;
  // fuzz
  private fBias = 0; private fLp: OnePoleLP;
  // muff
  private mHp: OnePoleHP; private mLp1: OnePoleLP; private mLp2: OnePoleLP;
  private mToneLp: OnePoleLP; private mToneHp: OnePoleHP;
  // boost
  private bHp: OnePoleHP;
  // transparent
  private kHp: OnePoleHP; private kLp: OnePoleLP; private kTilt: OnePoleHP;
  // metal
  private oHp: OnePoleHP; private oDc: OnePoleHP; private oLp: OnePoleLP;
  private xHp: OnePoleHP; private xCouple: OnePoleHP; private xLp: OnePoleLP; private xScoop: Biquad = new Biquad();
  // after the circuit, at the base rate
  private tone: OnePoleLP; private tone2: OnePoleLP;
  private inHp: OnePoleHP;
  private lastType = -1;
  /** For the UI: how far past its knee the circuit was pushed (peak of the input to the clipper, in knee units). */
  push = 0;
  /** Peak input, volts, for the picture's live dot. */
  peakIn = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate; this.fsOs = sampleRate * OS;
    this.os = new Oversampler(sampleRate);
    this.gHp = new OnePoleHP(this.fsOs, 720); this.gLp = new OnePoleLP(this.fsOs, 6000);
    this.rHpLo = new OnePoleHP(this.fsOs, 60); this.rHpHi = new OnePoleHP(this.fsOs, 1540); this.rGbw = new OnePoleLP(this.fsOs, 20000);
    this.fLp = new OnePoleLP(this.fsOs, 7000);
    this.mHp = new OnePoleHP(this.fsOs, 90); this.mLp1 = new OnePoleLP(this.fsOs, 6500); this.mLp2 = new OnePoleLP(this.fsOs, 5200);
    this.mToneLp = new OnePoleLP(sampleRate, 400); this.mToneHp = new OnePoleHP(sampleRate, 1800);
    this.bHp = new OnePoleHP(this.fsOs, 250);
    this.kHp = new OnePoleHP(this.fsOs, 220); this.kLp = new OnePoleLP(this.fsOs, 4500); this.kTilt = new OnePoleHP(sampleRate, 1500);
    this.oHp = new OnePoleHP(this.fsOs, 140); this.oDc = new OnePoleHP(this.fsOs, 90); this.oLp = new OnePoleLP(this.fsOs, 6000);
    this.xHp = new OnePoleHP(this.fsOs, 150); this.xCouple = new OnePoleHP(this.fsOs, 120); this.xLp = new OnePoleLP(this.fsOs, 6500);
    this.xScoop.peak(sampleRate, 700, 0.8, -7);
    this.tone = new OnePoleLP(sampleRate, 3000); this.tone2 = new OnePoleLP(sampleRate, 9000);
    this.inHp = new OnePoleHP(sampleRate, 25);
  }

  reset(): void {
    this.os.reset(); this.rLast = 0; this.fBias = 0;
    this.gHp.reset(); this.gLp.z = 0; this.rHpLo.reset(); this.rHpHi.reset(); this.rGbw.z = 0;
    this.fLp.z = 0; this.mHp.reset(); this.mLp1.z = 0; this.mLp2.z = 0; this.mToneLp.z = 0; this.mToneHp.reset(); this.bHp.reset(); this.oHp.reset(); this.oDc.reset(); this.oLp.z = 0; this.kHp.reset(); this.kLp.z = 0; this.kTilt.reset(); this.xHp.reset(); this.xCouple.reset(); this.xLp.z = 0; this.xScoop.reset(); this.tone.z = 0; this.tone2.z = 0; this.inHp.reset();
  }

  process(x: Float32Array, n: number, type: number, gain: number, toneKnob: number, levelDb: number): void {
    if (type !== this.lastType) { this.reset(); this.lastType = type; }
    let peakIn = 0;
    for (let i = 0; i < n; i++) {
      x[i] = this.inHp.tick(x[i]);
      const a = Math.abs(x[i]); if (a > peakIn) peakIn = a;
    }
    this.peakIn = peakIn;
    const up = this.up, m = n * OS;
    this.os.upsample(x, up, n);
    let push = 0;
    if (type === DRIVE_GLOW) {
      const G = glowGain(gain);
      this.gLp.set(this.fsOs, Math.min(60000, 1 / (2 * Math.PI * (51e3 + 500e3 * gain * gain) * 51e-12)));
      for (let i = 0; i < m; i++) {
        const v = up[i];
        const u = this.gLp.tick(G * this.gHp.tick(v));
        const a = Math.abs(u); if (a > push) push = a;
        up[i] = v + diodeFeedback(u);
      }
      push /= 0.6;
    } else if (type === DRIVE_RASP) {
      const R = raspPot(gain);
      const gLo = R / 560, gHi = R / 47;
      this.rGbw.set(this.fsOs, Math.min(40000, 1e6 / (1 + gLo + gHi)));
      const slew = 0.3e6 / this.fsOs;           // 0.3 V/us
      let last = this.rLast;
      for (let i = 0; i < m; i++) {
        const v = up[i];
        let u = this.rGbw.tick(v + gLo * this.rHpLo.tick(v) + gHi * this.rHpHi.tick(v));
        u = 4.5 * tanhf(u / 4.5);                  // the rails
        const d = u - last;
        if (d > slew) u = last + slew; else if (d < -slew) u = last - slew;
        last = u;
        const a = Math.abs(u); if (a > push) push = a;
        up[i] = diodeGround(u);
      }
      this.rLast = last;
      push /= 0.55;
    } else if (type === DRIVE_MUFF) {
      const G1 = muffGain1(gain), G2 = muffGain2(gain);
      for (let i = 0; i < m; i++) {
        const u = G1 * up[i];
        const a = Math.abs(u); if (a > push) push = a;
        const s = this.mLp1.tick(this.mHp.tick(muffSoft(u)));
        up[i] = this.mLp2.tick(muffHard(G2 * s));
      }
      push /= 0.6;
    } else if (type === DRIVE_BOOST) {
      const G = boostGain(gain), comp = Math.pow(G, -0.3);
      this.bHp.set(this.fsOs, 70 * Math.pow(10, toneKnob * 1.1));
      for (let i = 0; i < m; i++) {
        const u = G * this.bHp.tick(up[i]);
        const a = Math.abs(u); if (a > push) push = a;
        up[i] = germanium(u) * comp;
      }
    } else if (type === DRIVE_TRANSPARENT) {
      const G = clearGain(gain), keep = 1 - 0.4 * gain;
      for (let i = 0; i < m; i++) {
        const v = up[i];
        const u = G * this.kLp.tick(this.kHp.tick(v));
        const a = Math.abs(u); if (a > push) push = a;
        up[i] = v * keep + 0.54 * germanium(u);
      }
    } else if (type === DRIVE_OCTAVE) {
      const G = octaveGain(gain);
      for (let i = 0; i < m; i++) {
        const u = G * this.oHp.tick(up[i]);
        const a = Math.abs(u); if (a > push) push = a;
        const s = tanhf(u);
        // the rectified wave has a DC offset: the second high-pass takes it out
        up[i] = this.oLp.tick(0.5 * s + 0.9 * this.oDc.tick(Math.abs(s)));
      }
    } else if (type === DRIVE_METAL) {
      const G1 = metalGain(gain);
      for (let i = 0; i < m; i++) {
        const u = G1 * this.xHp.tick(up[i]);
        const a = Math.abs(u); if (a > push) push = a;
        const s1 = tanhf(u);
        const s2 = tanhf(3 * this.xCouple.tick(s1));
        up[i] = this.xLp.tick(diodeGround(5 * s2));
      }
      push /= 2;
    } else {
      const G = fuzzGain(gain);
      const charge = 1 - Math.exp(-1 / (0.002 * this.fsOs));
      const relax = 1 - Math.exp(-1 / (0.04 * this.fsOs));
      let bias = this.fBias;
      for (let i = 0; i < m; i++) {
        const v = G * up[i] + bias;
        const a = Math.abs(v); if (a > push) push = a;
        // the coupling cap charges when the transistor is driven hard, which
        // shifts the bias and starves the quiet tail of the note
        const target = v > 1.2 ? Math.max(-3, -0.4 * (v - 1.2)) : 0;
        bias += (target - bias) * (target < bias ? charge : relax);
        up[i] = this.fLp.tick(tanhf(1.5 * germanium(v)));
      }
      this.fBias = bias;
    }
    this.push = push;
    this.os.downsample(up, x, n);
    // tone and level
    if (type === DRIVE_MUFF) {
      // the passive tone control: a 400 Hz low pass and a 1.8 kHz high pass, crossfaded
      const out = dbToGain(levelDb) / CEILING[type] * 0.35 * 2.2;
      const lo = 1 - toneKnob, hi = toneKnob;
      for (let i = 0; i < n; i++) x[i] = (lo * this.mToneLp.tick(x[i]) + hi * this.mToneHp.tick(x[i])) * out;
      return;
    }
    if (type === DRIVE_BOOST) {
      this.tone.set(this.fs, 9000);
      const out = dbToGain(levelDb) / CEILING[type] * 0.35;
      for (let i = 0; i < n; i++) x[i] = this.tone.tick(x[i]) * out;
      return;
    }
    if (type === DRIVE_TRANSPARENT) {
      // `treble`: a shelf, -30% of everything above 1.5 kHz at 0, +150% at 10
      const k = Math.max(-0.7, (toneKnob * 2 - 1) * 1.5);
      const out = dbToGain(levelDb) / CEILING[type] * 0.35;
      for (let i = 0; i < n; i++) { const v = x[i]; x[i] = (v + k * this.kTilt.tick(v)) * out; }
      return;
    }
    if (type === DRIVE_METAL) {
      this.tone.set(this.fs, 1500 * Math.pow(6, toneKnob));
      const out = dbToGain(levelDb) / CEILING[type] * 0.35;
      for (let i = 0; i < n; i++) x[i] = this.tone.tick(this.xScoop.tick(x[i])) * out;
      return;
    }
    const fTone = type === DRIVE_GLOW ? 800 * Math.pow(8, toneKnob) : type === DRIVE_RASP ? 600 * Math.pow(25, toneKnob) : 700 * Math.pow(12, toneKnob);
    this.tone.set(this.fs, fTone);
    this.tone2.set(this.fs, Math.min(fTone * 2.5, this.fs * 0.45));
    const out = dbToGain(levelDb) / CEILING[type] * 0.35;
    for (let i = 0; i < n; i++) x[i] = this.tone2.tick(this.tone.tick(x[i])) * out;
  }
}
