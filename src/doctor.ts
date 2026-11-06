// The tone doctor: "too bright", "too dirty" and so on as small, repeatable
// steps on whatever is in the rack. Each complaint is a list of nudges: a knob
// by name on every unit of a category (every amp's treble, every drive's
// gain...), by a step in the knob's own 0..1, in real units (dB) or as a
// multiple (cut frequencies move in ratios). Knobs the rack doesn't have are
// skipped; knobs at their end stop there.

import { MODULES, NSLOTS, slotTypeId, slotOnId, slotKnobId, fromNorm, toNorm, type ParamValues } from './dsp/params.ts';

export type Complaint = 'bright' | 'dark' | 'dirty' | 'clean' | 'thin' | 'muddy';

interface Nudge {
  /** The module category it applies to. */
  cat: string;
  knob: string;
  norm?: number;
  real?: number;
  mul?: number;
  /** For `mul`: never go below this (a low cut at 20 Hz has to jump, not creep). */
  floor?: number;
}

export const COMPLAINTS: { id: Complaint; label: string; hint: string }[] = [
  { id: 'bright', label: 'too bright', hint: 'less treble, presence and top end' },
  { id: 'dark', label: 'too dark', hint: 'more treble, presence and top end' },
  { id: 'dirty', label: 'too dirty', hint: 'less gain on the amps and drives' },
  { id: 'clean', label: 'too clean', hint: 'more gain on the amps and drives' },
  { id: 'thin', label: 'too thin', hint: 'more bass and low mids' },
  { id: 'muddy', label: 'too muddy', hint: 'less bass and low mids, a low cut' },
];

const RULES: Record<Complaint, Nudge[]> = {
  bright: [
    { cat: 'amp', knob: 'treble', norm: -0.07 }, { cat: 'amp', knob: 'presence', norm: -0.1 }, { cat: 'amp', knob: 'mic', norm: 0.07 },
    { cat: 'amp', knob: 'highcut', mul: 0.7 }, { cat: 'drive', knob: 'tone', norm: -0.07 }, { cat: 'guitar', knob: 'tone', norm: -0.07 },
    { cat: 'eq', knob: 'treble', real: -1.5 }, { cat: 'eq', knob: 'himid', real: -1 },
  ],
  dark: [
    { cat: 'amp', knob: 'treble', norm: 0.07 }, { cat: 'amp', knob: 'presence', norm: 0.1 }, { cat: 'amp', knob: 'mic', norm: -0.07 },
    { cat: 'amp', knob: 'highcut', mul: 1.4 }, { cat: 'drive', knob: 'tone', norm: 0.07 }, { cat: 'guitar', knob: 'tone', norm: 0.07 },
    { cat: 'eq', knob: 'treble', real: 1.5 }, { cat: 'eq', knob: 'himid', real: 1 },
  ],
  dirty: [
    { cat: 'amp', knob: 'gain', norm: -0.07 }, { cat: 'amp', knob: 'master', norm: -0.04 }, { cat: 'drive', knob: 'gain', norm: -0.07 },
  ],
  clean: [
    { cat: 'amp', knob: 'gain', norm: 0.07 }, { cat: 'amp', knob: 'master', norm: 0.04 }, { cat: 'drive', knob: 'gain', norm: 0.07 },
  ],
  thin: [
    { cat: 'amp', knob: 'bass', norm: 0.07 }, { cat: 'amp', knob: 'lowcut', mul: 0.8 },
    { cat: 'eq', knob: 'bass', real: 1.5 }, { cat: 'eq', knob: 'lomid', real: 1 },
  ],
  muddy: [
    { cat: 'amp', knob: 'bass', norm: -0.07 }, { cat: 'amp', knob: 'lowcut', mul: 1.3, floor: 70 },
    { cat: 'eq', knob: 'bass', real: -1.5 }, { cat: 'eq', knob: 'lomid', real: -1.5 },
  ],
};

/** `values` with one more step of `complaint` applied, and the names of the knobs that moved (once each). */
export function treat(values: ParamValues, complaint: Complaint): { values: ParamValues; moved: string[] } {
  const next = { ...values };
  const moved: string[] = [];
  for (let s = 0; s < NSLOTS; s++) {
    const type = Math.round(values[slotTypeId(s)]);
    if (type === 0 || values[slotOnId(s)] < 0.5) continue;
    const def = MODULES[type];
    for (const n of RULES[complaint]) {
      if (def.cat !== n.cat) continue;
      const k = def.knobs.findIndex((kd) => kd.id === n.knob);
      if (k < 0) continue;
      const id = slotKnobId(s, k), kd = def.knobs[k], cur = values[id];
      let to = cur;
      if (n.norm !== undefined) to = Math.min(1, Math.max(0, cur + n.norm));
      else if (n.real !== undefined) to = toNorm(kd, fromNorm(kd, cur) + n.real);
      else if (n.mul !== undefined) to = toNorm(kd, Math.max(n.floor ?? 0, fromNorm(kd, cur) * n.mul));
      if (Math.abs(to - cur) < 1e-6) continue;
      next[id] = to;
      if (!moved.includes(kd.name)) moved.push(kd.name);
    }
  }
  return { values: next, moved };
}
