// A synthetic DI guitar, so the rig can be heard without a guitar plugged in
// and the offline renders have something to play: six Karplus-Strong strings
// (pick-position comb on the pluck, pickup comb on the output, per-string
// sustain, palm muting) playing three short loops. Output is in volts, like
// a passive humbucker into an interface: peaks around 0.3.

import { Rng } from './util.ts';

export const DEMO_NAMES = ['strum', 'riff', 'lick'];

const OPEN = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];
const SUSTAIN = [6.5, 5.5, 4.8, 4.0, 3.4, 2.8];   // T60, seconds, ringing
const MUTED = 0.16;                                 // T60 under the palm
const MAX_LEN = 1024;

class PluckedString {
  private line = new Float32Array(MAX_LEN);
  private hist = new Float32Array(256);
  private exc = new Float32Array(MAX_LEN);
  private w = 0; private h = 0;
  private len = 400;            // loop length, fractional
  private g = 0.999;
  private bright = 0.5;
  private y1 = 0;
  private pickup = 40;

  reset(): void { this.line.fill(0); this.hist.fill(0); this.y1 = 0; }

  pluck(freq: number, vel: number, muted: boolean, fs: number, rng: Rng, string: number): void {
    // loop = delay + half a sample of the averaging filter
    this.len = Math.min(MAX_LEN - 2, fs / freq - 0.5);
    const t60 = muted ? MUTED : SUSTAIN[string] * Math.pow(0.82, Math.log2(freq / OPEN[string]) * 2);
    this.g = Math.pow(10, -3 / (t60 * freq));
    this.bright = muted ? 0.25 : 0.5 + 0.35 * vel;
    this.pickup = Math.max(1, Math.min(255, Math.round(this.len * 0.18)));
    // excitation: a filtered noise burst one period long, combed at the pick position
    const L = Math.round(this.len), pick = Math.max(1, Math.round(L * 0.13));
    const amp = (0.25 + 0.75 * vel) * 0.55;
    const lpA = muted ? 0.25 : 0.35 + 0.5 * vel;
    const exc = this.exc;
    let lp = 0;
    for (let k = 0; k < L; k++) { lp += (rng.bi() - lp) * lpA; exc[k] = lp * amp; }
    for (let k = 0; k < L; k++) {
      const idx = (this.w - L + k + MAX_LEN * 2) % MAX_LEN;
      this.line[idx] = this.line[idx] * 0.2 + exc[k] - (k >= pick ? 0.9 * exc[k - pick] : 0);
    }
  }

  damp(fs: number): void { this.g = Math.min(this.g, Math.pow(10, -3 / (MUTED * 2 * (fs / this.len)))); }
  tick(): number {
    const len = this.len;
    let r = this.w - len;
    while (r < 0) r += MAX_LEN;
    const i0 = r | 0, fr = r - i0;
    const i1 = i0 + 1 >= MAX_LEN ? 0 : i0 + 1;
    const y = this.line[i0] + (this.line[i1] - this.line[i0]) * fr;
    // loss filter: a two-tap average leaning towards the newest sample when bright
    const b = this.bright;
    const v = (y * (0.5 + 0.5 * b) + this.y1 * (0.5 - 0.5 * b)) * this.g;
    this.y1 = y;
    this.line[this.w] = v;
    if (++this.w >= MAX_LEN) this.w = 0;
    this.hist[this.h] = y;
    const p = (this.h - this.pickup + 256) & 255;
    this.h = (this.h + 1) & 255;
    return y - 0.6 * this.hist[p];
  }
}

// An event: seconds, string, fret (-1 damps the string), velocity, palm muted.
type Ev = [number, number, number, number, number];

function strum(): { ev: Ev[]; len: number } {
  const beat = 60 / 92, ev: Ev[] = [];
  const chords = [[0, 2, 2, 0, 0, 0], [-1, 3, 2, 0, 1, 0], [3, 2, 0, 0, 0, 3], [-1, -1, 0, 2, 3, 2]];
  const pattern = [[0, 1], [1, 1], [1.5, -1], [2.5, -1], [3, 1], [3.5, -1]];   // beat, direction
  chords.forEach((shape, bar) => {
    const t0 = bar * 4 * beat;
    shape.forEach((f, s) => { if (f < 0) ev.push([t0, s, -1, 0, 0]); });
    for (const [b, dir] of pattern) {
      const strings = shape.map((f, s) => [s, f]).filter(([, f]) => f >= 0);
      const order = dir > 0 ? strings : strings.slice(-4).reverse();
      order.forEach(([s, f], k) => ev.push([t0 + b * beat + k * (dir > 0 ? 0.011 : 0.008), s, f, dir > 0 ? 0.75 : 0.45, 0]));
    }
  });
  return { ev, len: 16 * beat };
}

function riff(): { ev: Ev[]; len: number } {
  const e8 = 60 / 120 / 2, ev: Ev[] = [];
  const power = (t: number, root: number, fret: number, vel: number, muted: number) => {
    ev.push([t, root, fret, vel, muted], [t + 0.004, root + 1, fret + 2, vel, muted]);
    if (!muted) ev.push([t + 0.008, root + 2, fret + 2, vel * 0.9, 0]);
  };
  for (let bar = 0; bar < 4; bar++) {
    const t0 = bar * 8 * e8;
    for (let k = 0; k < 5; k++) power(t0 + k * e8, 0, 0, 0.7, 1);
    const last = bar === 3;
    power(t0 + 5 * e8, 0, last ? 5 : 3, 0.9, 0);
    power(t0 + 6.5 * e8, 0, last ? 7 : 5, 0.9, 0);
  }
  return { ev, len: 32 * e8 };
}

function lick(): { ev: Ev[]; len: number } {
  const s16 = 60 / 100 / 4, ev: Ev[] = [];
  // E minor pentatonic around the 12th fret, up and back down, then a held note
  const notes: [number, number][] = [[3, 12], [3, 14], [4, 12], [4, 15], [5, 12], [5, 15], [5, 12], [4, 15],
    [4, 12], [3, 14], [3, 12], [2, 14], [2, 12], [1, 14], [2, 14], [3, 14]];
  notes.forEach(([s, f], k) => {
    ev.push([k * s16, s, f, 0.6 + 0.25 * ((k % 4) === 0 ? 1 : 0), 0]);
    // the previous note on another string stops when the next is fretted
    if (k > 0 && notes[k - 1][0] !== s) ev.push([k * s16 + 0.02, notes[k - 1][0], -1, 0, 0]);
  });
  const t = notes.length * s16;
  ev.push([t, 4, 15, 0.85, 0], [t + 8 * s16, 4, -1, 0, 0]);
  ev.push([t + 12 * s16, 3, 14, 0.8, 0], [t + 12 * s16 + 0.03, 4, 15, 0.7, 0]);
  return { ev, len: t + 28 * s16 };
}

export class DemoGuitar {
  private strings: PluckedString[] = [];
  private patterns = [strum(), riff(), lick()];
  private pattern = 0;
  private t = 0;
  private next = 0;
  private rng = new Rng(0x51ed);
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    for (let s = 0; s < 6; s++) this.strings.push(new PluckedString());
    for (const p of this.patterns) p.ev.sort((a, b) => a[0] - b[0]);
  }

  setPattern(i: number): void {
    i = Math.max(0, Math.min(this.patterns.length - 1, i | 0));
    if (i === this.pattern) return;
    this.pattern = i;
    this.reset();
  }

  reset(): void {
    this.t = 0; this.next = 0;
    for (const s of this.strings) s.reset();
  }

  process(out: Float32Array, n: number): void {
    const p = this.patterns[this.pattern], dt = 1 / this.fs;
    for (let i = 0; i < n; i++) {
      while (this.next < p.ev.length && p.ev[this.next][0] <= this.t) {
        const [, s, f, vel, muted] = p.ev[this.next++];
        if (f < 0) this.strings[s].damp(this.fs);
        else this.strings[s].pluck(OPEN[s] * Math.pow(2, f / 12), vel, muted > 0, this.fs, this.rng, s);
      }
      let v = 0;
      for (let s = 0; s < 6; s++) v += this.strings[s].tick();
      out[i] = v * 0.16;
      this.t += dt;
      if (this.t >= p.len) { this.t -= p.len; this.next = 0; }
    }
  }
}
