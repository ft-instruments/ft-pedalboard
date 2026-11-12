// Cabinet impulse response: the user's WAV, convolved directly (no FFT; the IR
// is cut to IR_MAX taps, about 40 ms at 48 kHz, which is what a guitar cab
// needs). One IR is shared by every cab IR unit in the rack. With no IR loaded
// the unit passes the signal through.

import { dbToGain } from './util.ts';

export const IR_MAX = 2048;

/** Cut, fade the tail out and set the gain so a white-noise input keeps its level; null for nothing usable. */
export function prepareIR(data: ArrayLike<number>): Float64Array | null {
  const n = Math.min(data.length, IR_MAX);
  if (n < 2) return null;
  const ir = new Float64Array(n);
  const fade = Math.max(1, Math.floor(n / 8));
  let e = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) return null;
    const w = i >= n - fade ? 0.5 + 0.5 * Math.cos(Math.PI * (i - (n - fade)) / fade) : 1;
    ir[i] = v * w; e += ir[i] * ir[i];
  }
  if (e < 1e-12) return null;
  const g = 1 / Math.sqrt(e);
  for (let i = 0; i < n; i++) ir[i] *= g;
  return ir;
}

export class CabIR {
  private hist = new Float64Array(2 * IR_MAX);
  private pos = 0;

  reset(): void { this.hist.fill(0); this.pos = 0; }

  /** `ir` null: pass through. level in dB, mix 0..1 (dry to wet). */
  process(x: Float32Array, n: number, ir: Float64Array | null, level: number, mix: number): void {
    if (!ir) return;
    const len = ir.length, gain = dbToGain(level), h = this.hist;
    let pos = this.pos;
    for (let i = 0; i < n; i++) {
      pos = pos === 0 ? IR_MAX - 1 : pos - 1;
      const dry = x[i];
      h[pos] = dry; h[pos + IR_MAX] = dry;
      let s = 0;
      for (let k = 0; k < len; k++) s += ir[k] * h[pos + k];
      x[i] = dry + (s * gain - dry) * mix;
    }
    this.pos = pos;
  }
}
