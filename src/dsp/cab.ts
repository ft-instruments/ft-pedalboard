// The speaker cabinet and the mic in front of it, with no third-party
// impulse responses: each cabinet's magnitude response is synthesised from
// the speakers' published data and the shape of a close-miked guitar
// speaker (see VOICES), and turned into a minimum-phase FIR by the cepstrum
// (a guitar speaker is close to minimum phase: Fractal's staff; Pakarinen &
// Yeh cite a min-phase FIR loudspeaker model), ~6 ms long. The box resonance
// below that, too slow for a 6 ms FIR, is a high-pass and a bump at the
// same resonance the power amp sees in SPEAKERS. The responses are built
// once per sample rate at five mic positions (dust cap to cone edge); the
// knob interpolates between neighbours.

import { Biquad } from './util.ts';

/**
 * The electrical side of each cabinet's speaker, for the power amp (amp.ts):
 * the voice coil (Re, Le) in series with the motional branch, a parallel
 * Res, Lces, Cmes that resonates at the speaker's resonance in its box.
 * Lces and Cmes follow from `fs` and the branch's Q: Lces = Res / (2 pi fs
 * Q), Cmes = Q / (2 pi fs Res). The 4x12 v30 is Macak's measured Celestion
 * Vintage 30 (thesis Table 5.15: Re 6.8, Le 0.6 mH, Res 45, Cmes 193 uF,
 * Lces 23 mH: 75 Hz in free air, Q 4.1), with the resonance raised to
 * ~105 Hz by its closed box (the Q rising with it, sqrt(1 + Vas/Vb)). The
 * others take their free-air resonance from the datasheets (Celestion G12M
 * and Alnico Blue 75 Hz, G12H 85 Hz, Jensen P12Q ~90 Hz) and the rest
 * (peak height, Q, Le, the box's shift) by analogy with the V30: estimates,
 * not measurements. All on an 8 ohm scale.
 */
export interface Speaker { re: number; le: number; fs: number; q: number; res: number }
/** By cabinet (the cab knob less one). */
export const SPEAKERS: Speaker[] = [
  { re: 6.6, le: 0.5e-3, fs: 90, q: 4, res: 35 },     // 1x12 open
  { re: 6.7, le: 0.55e-3, fs: 95, q: 4.5, res: 40 },  // 2x12 closed
  { re: 6.5, le: 0.6e-3, fs: 100, q: 4.5, res: 40 },  // 4x12 closed
  { re: 6.8, le: 0.45e-3, fs: 80, q: 5, res: 48 },    // 2x12 alnico blue, open back
  { re: 6.7, le: 0.55e-3, fs: 98, q: 4.5, res: 40 },  // 4x12 greenback
  { re: 6.5, le: 0.4e-3, fs: 95, q: 3, res: 30 },     // 1x12 tweed (Jensen), open back
  { re: 6.8, le: 0.6e-3, fs: 105, q: 5.4, res: 45 },  // 4x12 v30 (Macak's measured V30, closed box)
  { re: 6.5, le: 0.35e-3, fs: 105, q: 3.5, res: 30 }, // 4x10 blackface, open back
  { re: 6.4, le: 0.25e-3, fs: 150, q: 3, res: 25 },   // 1x8 small
];

/** |Z| of a speaker at f Hz (ohms). */
export function speakerZ(sp: Speaker, f: number): number {
  const w = 2 * Math.PI * f, lces = sp.res / (2 * Math.PI * sp.fs * sp.q), cmes = sp.q / (2 * Math.PI * sp.fs * sp.res);
  // motional branch: 1 / (1/Res + 1/(jw Lces) + jw Cmes)
  const gr = 1 / sp.res, gi = w * cmes - 1 / (w * lces), g2 = gr * gr + gi * gi;
  const zr = sp.re + gr / g2, zi = w * sp.le - gi / g2;
  return Math.hypot(zr, zi);
}

/**
 * Each cabinet's acoustic voice, drawn from the speakers' published data and
 * the general shape of a close-miked guitar speaker: the box
 * resonance (the same `fs` the power amp sees in SPEAKERS) with its bump and
 * a 12 dB/oct fall below, an open back's extra low loss, the low-mid dip,
 * the broad presence rise of the cone, a set of narrow break-up peaks and
 * notches between ~1 and 6 kHz (the speaker's own fingerprint: placed from
 * forum readings of Celestion's curves where there are any, e.g. a V30's
 * 1.6-3.5 kHz hump and a Greenback's softer 1.8 kHz; elsewhere chosen), the
 * steep fall above ~5 kHz (Celestion: 70/75-5000 Hz), a weak reflection a
 * couple of ms late (the floor, the grille), and the mic: on the dust cap
 * bright with the most proximity bass, towards the edge darker with the
 * presence and the top break-ups falling away.
 *   closed, bump dB, dip [Hz, dB], presence [Hz, dB], top Hz, break-ups [Hz, dB, Q]..., reflection [ms, dB], proximity dB
 */
interface Voice { closed: boolean; bump: number; dip: [number, number]; pres: [number, number]; top: number; br: [number, number, number][]; refl: [number, number]; prox: number }
const VOICES: Voice[] = [
  // 1x12 open: lighter low end, airy, a little honk
  { closed: false, bump: 2, dip: [650, -2.5], pres: [2600, 4], top: 5600, br: [[1500, 2.5, 6], [2500, 3, 8], [3300, -4, 10], [4200, 3, 8]], refl: [1.2, -14], prox: 2 },
  // 2x12 closed: rounder, even
  { closed: true, bump: 3.5, dip: [500, -3], pres: [2800, 5], top: 5000, br: [[1900, 2.5, 6], [2600, -3, 9], [3400, 4, 8], [4400, -5, 10]], refl: [1.8, -16], prox: 3 },
  // 4x12 closed: the thump, scooped low mids, a hard presence peak
  { closed: true, bump: 5, dip: [420, -4.5], pres: [3000, 6], top: 4600, br: [[1700, 2, 6], [2400, -3, 8], [3000, 4, 8], [3900, -5, 10], [5000, 2, 8]], refl: [2.2, -15], prox: 3 },
  // 2x12 alnico blue: open-ish back, a loose low end and the bright upper-mid bark
  { closed: false, bump: 2.5, dip: [600, -2], pres: [3600, 6], top: 6200, br: [[1600, 1.5, 6], [2900, -3, 8], [3800, 4, 8], [4800, -4, 10]], refl: [1.4, -14], prox: 2 },
  // 4x12 greenback: a fat bottom, the low mids carved, a creamy 1.8 kHz and a top that falls off early
  { closed: true, bump: 4.5, dip: [450, -3.5], pres: [2000, 4], top: 4600, br: [[900, -1.5, 4], [1800, 3, 5], [2500, 2, 10], [3200, -4, 9], [4100, -3, 10]], refl: [2.2, -15], prox: 3 },
  // 1x12 tweed (a Jensen in a small open box): honk at 700 Hz, no real bottom end
  { closed: false, bump: 2.5, dip: [1400, -2], pres: [2600, 3], top: 4800, br: [[700, 2.5, 2], [3600, -3, 9]], refl: [1.1, -13], prox: 2 },
  // 4x12 v30: tight bottom, the low mids scooped, the V30's upper-mid hump and bite
  { closed: true, bump: 5, dip: [380, -5], pres: [3200, 7], top: 5200, br: [[1600, 2.5, 4], [2200, -2.5, 9], [2800, 3, 7], [3500, 4, 8], [4300, -6, 10], [5400, 2, 9]], refl: [2.2, -15], prox: 3 },
  // 4x10 blackface: open back, a glassy top
  { closed: false, bump: 2.5, dip: [500, -2.5], pres: [3200, 4], top: 6600, br: [[1200, 1.5, 4], [2400, -2, 8], [3600, 3, 7], [4800, -3, 9], [6000, 2, 8]], refl: [1.3, -14], prox: 2 },
  // 1x8: a small cone, punchy around its resonance and nothing below it
  { closed: false, bump: 3, dip: [1800, -1], pres: [3000, 3], top: 4300, br: [[900, 2, 2]], refl: [0.9, -13], prox: 1 },
];
export const NCABS = VOICES.length;
/** Mic positions the impulse responses are built at (the knob interpolates between them). */
const NMIC = 5;
/** Length of the speaker's impulse response: ~6 ms, which resolves ~170 Hz; the box resonance below it is the biquads'. */
const FIR_S = 0.006;
const NFFT = 4096;

/** In-place radix-2 complex FFT (sign -1 forward, +1 inverse, unscaled). */
function fft(re: Float64Array, im: Float64Array, sign: number): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = sign * 2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** How much of each voice's low-mid dip and presence bell is applied. */
const CAB_DIP_W = 0.6, CAB_PRES_W = 0.5;
/** The target magnitude (dB) of a cabinet's upper part (everything but the box resonance) at f Hz, mic 0..1. */
function voiceDb(v: Voice, mic: number, f: number): number {
  const lg = (x: number) => Math.log2(Math.max(1, f) / x);
  let d = 0;
  // the low-mid dip and the presence rise: log-frequency bells, about an octave wide
  // (weighted down, fixer audit: with the break-ups and the speaker load's own electrical rise on top they stacked to
  // +10-12 dB at 3 kHz over 400 Hz; a datasheet SPL curve is a constant-voltage response, the load is the amp's)
  d += CAB_DIP_W * v.dip[1] * Math.exp(-0.5 * (lg(v.dip[0]) / 0.6) ** 2);
  d += CAB_PRES_W * v.pres[1] * (1.3 - mic) * Math.exp(-0.5 * (lg(v.pres[0]) / 0.7) ** 2);
  // the break-ups: narrow bells (Q as octave widths ~ 1 / Q), the upper ones fading off-axis
  for (const [bf, bd, bq] of v.br) {
    const g = bf > 3000 ? bd * (1.2 - 0.6 * mic) : bd;
    d += g * Math.exp(-0.5 * (lg(bf) * bq / 1.2) ** 2);
  }
  // the top: ~24 dB/oct above the cone's limit, which moves down towards the edge; a further shelf off the cap
  const top = v.top * (0.95 - 0.4 * mic);
  d += -10 * Math.log10(1 + (f / top) ** 8);
  d += -6 * mic / (1 + (2500 / Math.max(1, f)) ** 2);
  // a reflection a little later: |1 + g e^-jwt|, low-passed (only the lows and mids come back strongly)
  const g = Math.pow(10, v.refl[1] / 20) / Math.sqrt(1 + (f / 2500) ** 2), ph = 2 * Math.PI * f * v.refl[0] * 1e-3;
  d += 10 * Math.log10((1 + g * Math.cos(ph)) ** 2 + (g * Math.sin(ph)) ** 2);
  return d;
}

/** The impulse responses, built once per sample rate: [cab][mic][tap]. */
let IR_FS = 0, IR_LEN = 0;
let IRS: Float64Array[] = [];
function buildIrs(fs: number): void {
  if (IR_FS === fs) return;
  const L = Math.round(fs * FIR_S);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const irs: Float64Array[] = [];
  for (let c = 0; c < NCABS; c++) {
    for (let mi = 0; mi < NMIC; mi++) {
      const mic = mi / (NMIC - 1), v = VOICES[c];
      const ref = voiceDb(v, mic, 1000);
      // log magnitude (natural log), the floor at -80 dB, symmetric spectrum
      for (let k = 0; k <= NFFT / 2; k++) {
        const f = k * fs / NFFT;
        const db = Math.max(-80, f > 20000 ? -80 : voiceDb(v, mic, f) - ref);
        re[k] = db / 20 * Math.LN10; im[k] = 0;
        if (k > 0 && k < NFFT / 2) { re[NFFT - k] = re[k]; im[NFFT - k] = 0; }
      }
      // the real cepstrum, folded onto positive quefrency: the minimum-phase spectrum's log
      fft(re, im, 1);
      for (let k = 0; k < NFFT; k++) { re[k] /= NFFT; im[k] = 0; }
      for (let k = 1; k < NFFT / 2; k++) { re[k] *= 2; re[NFFT - k] = 0; }
      fft(re, im, -1);
      for (let k = 0; k < NFFT; k++) { const m = Math.exp(re[k]), p = im[k]; re[k] = m * Math.cos(p); im[k] = m * Math.sin(p); }
      fft(re, im, 1);
      const h = new Float64Array(L);
      // the last quarter fades out (half a Hann window)
      const fade = Math.floor(L / 4);
      for (let k = 0; k < L; k++) {
        const w = k < L - fade ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (k - (L - fade)) / fade);
        h[k] = re[k] / NFFT * w;
      }
      irs.push(h);
    }
  }
  IRS = irs; IR_FS = fs; IR_LEN = L;
}

export class Cab {
  /** The box: the resonance's high-pass, its bump (with the mic's proximity), an open back's low shelf. */
  private hp = new Biquad(); private bump = new Biquad(); private back = new Biquad();
  private h: Float64Array; private hist: Float64Array; private pos = 0; private readonly len: number;
  private curType = -1; private curMic = -1;
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    buildIrs(sampleRate);
    this.len = IR_LEN;
    this.h = new Float64Array(this.len);
    this.hist = new Float64Array(2 * this.len);
  }

  reset(): void { this.hp.reset(); this.bump.reset(); this.back.reset(); this.hist.fill(0); }

  /** Coefficients for a cabinet and a mic position (0 = dust cap, 1 = cone edge). */
  set(type: number, mic: number): void {
    if (type === this.curType && mic === this.curMic) return;
    this.curType = type; this.curMic = mic;
    const t = Math.max(0, Math.min(NCABS - 1, type)), v = VOICES[t], sp = SPEAKERS[t], fs = this.fs;
    this.hp.highpass(fs, sp.fs, v.closed ? 0.9 : 0.7);
    this.bump.peak(fs, sp.fs * 1.15, 1.2, v.bump + v.prox * (1 - mic));
    if (v.closed) this.back.bypass(); else this.back.lowShelf(fs, 180, -4);
    // the impulse response, between the two nearest mic positions
    const m = Math.min(1, Math.max(0, mic)) * (NMIC - 1), i0 = Math.min(NMIC - 2, Math.floor(m)), f = m - i0;
    const a = IRS[t * NMIC + i0], b = IRS[t * NMIC + i0 + 1], h = this.h;
    for (let k = 0; k < this.len; k++) h[k] = a[k] + f * (b[k] - a[k]);
  }

  process(x: Float32Array, n: number, type: number, mic: number): void {
    this.set(type, mic);
    const h = this.h, hist = this.hist, L = this.len, hp = this.hp, bump = this.bump, back = this.back;
    let pos = this.pos;
    for (let i = 0; i < n; i++) {
      const v = back.tick(bump.tick(hp.tick(x[i])));
      // the history twice over, so the newest L samples are always contiguous from pos
      pos = pos === 0 ? L - 1 : pos - 1;
      hist[pos] = v; hist[pos + L] = v;
      let y = 0;
      for (let k = 0; k < L; k++) y += h[k] * hist[pos + k];
      x[i] = y;
    }
    this.pos = pos;
  }

  /** |H| at `f` Hz, for the tests and the cabinet's picture (not for the audio thread). */
  mag(f: number): number {
    const w = 2 * Math.PI * f / this.fs;
    let r = 0, im = 0;
    for (let k = 0; k < this.len; k++) { r += this.h[k] * Math.cos(w * k); im -= this.h[k] * Math.sin(w * k); }
    return Math.hypot(r, im) * this.hp.mag(this.fs, f) * this.bump.mag(this.fs, f) * this.back.mag(this.fs, f);
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
