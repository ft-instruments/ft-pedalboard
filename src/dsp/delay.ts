// Tape echo: the repeats go through a low-pass, a high-pass and a
// soft-saturating record stage, the tape wobbles, and time changes slew so
// turning the knob bends the pitch like a motor changing speed. Ping-pong
// sends the repeats back and forth.
//
// As on a real machine the record amplifier pre-emphasises the treble (+6
// dB above ~2.5 kHz) before the tape saturates and the playback
// de-emphasises it again (the exact inverse), so loud repeats lose their
// top first and darken and soften as they pile up, while quiet ones stay
// clean. The wobble is a slow wow, a 6.3 Hz flutter and a random drift
// (low-passed noise, 3 Hz) so it never sounds like a sine LFO (after
// Chowdhury, "Real-time physical modelling for analog tape machines", DAFx
// 2019, and Arnardottir, Abel & Smith on the Echoplex, AES 2008).

import { tanhf, readDelayCubic, Rng } from './util.ts';

/** Record pre-emphasis: +6 dB (k = 1) above its corner. */
const EMPH_K = 1, EMPH_HZ = 2500, DRIFT_HZ = 3;

const MAX_SECONDS = 1.45;

export class TapeEcho {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private idx = 0;
  private time = 0;          // current (slewed) delay in samples
  private wowPh = 0; private flutPh = 0;
  private lpL = 0; private lpR = 0;
  private hpL = 0; private hpR = 0;
  private prL = 0; private prR = 0; private deL = 0; private deR = 0;   // the emphasis filters' low-pass states
  private drift = 0; private rng = new Rng();
  private readonly fs: number;
  /** For the UI: the loop's level. */
  level = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const len = Math.ceil(sampleRate * MAX_SECONDS);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.time = sampleRate * 0.38;
  }

  reset(): void { this.bufL.fill(0); this.bufR.fill(0); this.lpL = this.lpR = this.hpL = this.hpR = 0; this.prL = this.prR = this.deL = this.deR = 0; this.level = 0; }

  /** The record head: pre-emphasis, the tape's saturation, and the playback's de-emphasis (solved exactly). */
  private tape(w: number, left: boolean, ea: number): number {
    let pr = left ? this.prL : this.prR, de = left ? this.deL : this.deR;
    pr += (w - pr) * ea;
    const s = tanhf((1 + EMPH_K) * w - EMPH_K * pr);
    const y = (s + EMPH_K * (1 - ea) * de) / (1 + EMPH_K * (1 - ea));
    de += (y - de) * ea;
    if (left) { this.prL = pr; this.deL = de; } else { this.prR = pr; this.deR = de; }
    return y;
  }

  /** In place, stereo. */
  process(L: Float32Array, R: Float32Array, n: number, seconds: number, feedback: number, tone: number, wow: number, mix: number, pingPong: boolean): void {
    const fs = this.fs;
    const bufL = this.bufL, bufR = this.bufR, len = bufL.length;
    let idx = this.idx;
    const target = Math.min(len - 0.03 * fs, Math.max(8, seconds * fs));
    const slew = 1 - Math.exp(-1 / (0.12 * fs));
    const lpA = 1 - Math.exp(-2 * Math.PI * (1200 + tone * 7000) / fs);
    const hpA = 1 - Math.exp(-2 * Math.PI * 120 / fs);
    const wowInc = 2 * Math.PI * 0.55 / fs, flutInc = 2 * Math.PI * 6.3 / fs;
    const wowDepth = wow * 2.2e-3 * fs, flutDepth = wow * 0.18e-3 * fs;
    const fb = feedback, wet = mix, dry = 1 - mix * 0.5;
    const ea = 1 - Math.exp(-2 * Math.PI * EMPH_HZ / fs);
    const da = 1 - Math.exp(-2 * Math.PI * DRIFT_HZ / fs), dn = wow * 0.8e-3 * fs / Math.sqrt(da / (3 * (2 - da)));
    let time = this.time, wp = this.wowPh, fp = this.flutPh, drift = this.drift;
    const rng = this.rng;
    let lpL = this.lpL, lpR = this.lpR, hpL = this.hpL, hpR = this.hpR, peak = 0;
    for (let i = 0; i < n; i++) {
      time += (target - time) * slew;
      wp += wowInc; if (wp > 6.283185307) wp -= 6.283185307;
      fp += flutInc; if (fp > 6.283185307) fp -= 6.283185307;
      drift += (rng.bi() - drift) * da;
      const d = time + (1 + Math.sin(wp)) * wowDepth + Math.sin(fp) * flutDepth + (1 + drift) * dn * 0.5;
      let rl = readDelayCubic(bufL, idx, d);
      let rr = readDelayCubic(bufR, idx, d + 0.6e-3 * fs);
      lpL += (rl - lpL) * lpA; lpR += (rr - lpR) * lpA;
      hpL += (lpL - hpL) * hpA; hpR += (lpR - hpR) * hpA;
      rl = lpL - hpL; rr = lpR - hpR;
      const xl = L[i], xr = R[i];
      // the record head saturates what goes onto the tape, repeats included
      if (pingPong) {
        bufL[idx] = this.tape((xl + xr) * 0.5 + rr * fb, true, ea);
        bufR[idx] = this.tape(rl * fb, false, ea);
      } else {
        bufL[idx] = this.tape(xl + rl * fb, true, ea);
        bufR[idx] = this.tape(xr + rr * fb, false, ea);
      }
      const a = Math.abs(rl) + Math.abs(rr); if (a > peak) peak = a;
      L[i] = xl * dry + rl * wet;
      R[i] = xr * dry + rr * wet;
      if (++idx >= len) idx = 0;
    }
    this.idx = idx; this.time = time; this.wowPh = wp; this.flutPh = fp; this.drift = drift;
    this.lpL = lpL; this.lpR = lpR; this.hpL = hpL; this.hpR = hpR;
    this.level = peak * 0.5;
  }
}

/**
 * Stereo delay: two delay lines, each with its own time, repeats and level,
 * and a cross-feed that decides where the repeats go. At 0 the sides are
 * independent (a different delay on each ear); at 1 each side feeds the other
 * and the input enters on the left only: a ping-pong with two different
 * times. The repeats go through a low-pass (`tone`) and a high-pass, and an
 * optional soft saturation (`drive`); `mod` wobbles the lines like a chorus
 * on the repeats. Time changes slew, so turning a time knob bends the pitch.
 */
const SD_MAX_SECONDS = 1.55;

export class StereoDelay {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private idx = 0;
  private tl = 0; private tr = 0;             // current (slewed) delays in samples
  private ph1 = 0; private ph2 = 0.3;
  private lpL = 0; private lpR = 0; private hpL = 0; private hpR = 0;
  private readonly fs: number;
  /** For the UI: the repeats' level. */
  level = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const len = Math.ceil(sampleRate * SD_MAX_SECONDS);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.tl = sampleRate * 0.375; this.tr = sampleRate * 0.5;
  }

  reset(): void { this.bufL.fill(0); this.bufR.fill(0); this.lpL = this.lpR = this.hpL = this.hpR = 0; this.level = 0; }

  /** In place, stereo. Times in seconds; repeats, cross, tone, mod, levels, mix, drive 0..1. */
  process(L: Float32Array, R: Float32Array, n: number, timeL: number, timeR: number, fbL: number, fbR: number, cross: number,
    tone: number, mod: number, levelL: number, levelR: number, mix: number, drive: number): void {
    const fs = this.fs, bufL = this.bufL, bufR = this.bufR, len = bufL.length;
    let idx = this.idx;
    const maxT = len - 0.04 * fs;
    const targetL = Math.min(maxT, Math.max(8, timeL * fs)), targetR = Math.min(maxT, Math.max(8, timeR * fs));
    const slew = 1 - Math.exp(-1 / (0.1 * fs));
    const lpA = 1 - Math.exp(-2 * Math.PI * (1200 + tone * 8000) / fs);
    const hpA = 1 - Math.exp(-2 * Math.PI * 100 / fs);
    const inc1 = 2 * Math.PI * 0.6 / fs, inc2 = 2 * Math.PI * 0.83 / fs, depth = mod * 1.5e-3 * fs;
    const g = 1 + 3 * drive, gInv = 1 / g;
    const wet = mix, dry = 1 - mix * 0.5;
    let tl = this.tl, tr = this.tr, p1 = this.ph1, p2 = this.ph2;
    let lpL = this.lpL, lpR = this.lpR, hpL = this.hpL, hpR = this.hpR, peak = 0;
    for (let i = 0; i < n; i++) {
      tl += (targetL - tl) * slew; tr += (targetR - tr) * slew;
      p1 += inc1; if (p1 > 6.283185307) p1 -= 6.283185307;
      p2 += inc2; if (p2 > 6.283185307) p2 -= 6.283185307;
      let rl = readDelayCubic(bufL, idx, tl + Math.sin(p1) * depth + depth);
      let rr = readDelayCubic(bufR, idx, tr + Math.sin(p2) * depth + depth);
      lpL += (rl - lpL) * lpA; lpR += (rr - lpR) * lpA;
      hpL += (lpL - hpL) * hpA; hpR += (lpR - hpR) * hpA;
      rl = lpL - hpL; rr = lpR - hpR;
      const xl = L[i], xr = R[i];
      // the input: both sides apart, or into the left alone as the cross-feed closes
      const inL = xl + (xr - xl) * 0.5 * cross, inR = xr * (1 - cross);
      let wl = inL + ((1 - cross) * rl + cross * rr) * fbL;
      let wr = inR + ((1 - cross) * rr + cross * rl) * fbR;
      if (drive > 0) { wl = tanhf(wl * g) * gInv; wr = tanhf(wr * g) * gInv; }
      bufL[idx] = wl; bufR[idx] = wr;
      const a = Math.abs(rl) + Math.abs(rr); if (a > peak) peak = a;
      L[i] = xl * dry + rl * wet * levelL;
      R[i] = xr * dry + rr * wet * levelR;
      if (++idx >= len) idx = 0;
    }
    this.idx = idx; this.tl = tl; this.tr = tr; this.ph1 = p1; this.ph2 = p2;
    this.lpL = lpL; this.lpR = lpR; this.hpL = hpL; this.hpR = hpR;
    this.level = peak * 0.5;
  }
}

