// Editing the rack as parameter values: add a module, remove a unit, move
// one. The rack is kept packed (units in slots 0..count-1, empty slots after),
// so a unit's position in the chain is its slot. Each operation edits a copy
// of the values and returns which old slot ended up in each new slot (-1 for
// a new or empty one), for state that travels with a unit (folded or not).

import { NSLOTS, MAX_KNOBS, MODULES, slotTypeId, slotOnId, slotKnobId, placeModule, toNorm, fromNorm, type ParamValues, type Rig, type Unit } from './dsp/params.ts';

export type Perm = number[];

const typeAt = (v: ParamValues, s: number) => Math.round(v[slotTypeId(s)] ?? 0);

function readSlot(v: ParamValues, s: number): number[] {
  const d = [v[slotTypeId(s)], v[slotOnId(s)]];
  for (let k = 0; k < MAX_KNOBS; k++) d.push(v[slotKnobId(s, k)]);
  return d;
}

function writeSlot(v: ParamValues, s: number, d: number[]): void {
  v[slotTypeId(s)] = d[0]; v[slotOnId(s)] = d[1];
  for (let k = 0; k < MAX_KNOBS; k++) v[slotKnobId(s, k)] = d[2 + k];
}

function clearSlot(v: ParamValues, s: number): void {
  v[slotTypeId(s)] = 0; v[slotOnId(s)] = 1;
  for (let k = 0; k < MAX_KNOBS; k++) v[slotKnobId(s, k)] = 0.5;
}

/** Rewrite `v` with its units in `order` (old slot numbers), the rest empty. */
function arrange(v: ParamValues, order: number[]): ParamValues {
  const out = { ...v };
  const data = order.map((s) => readSlot(v, s));
  for (let s = 0; s < NSLOTS; s++) {
    if (s < data.length) writeSlot(out, s, data[s]); else clearSlot(out, s);
  }
  return out;
}

const filled = (v: ParamValues) => Array.from({ length: NSLOTS }, (_, s) => s).filter((s) => typeAt(v, s) !== 0);
const permOf = (order: number[]): Perm => Array.from({ length: NSLOTS }, (_, s) => (s < order.length ? order[s] : -1));

/** The slots in use, in chain order. */
export function units(v: ParamValues): number[] { return filled(v); }

/** Close any gaps (a host may leave a slot empty between units). */
export function pack(v: ParamValues): { values: ParamValues; perm: Perm } {
  const order = filled(v);
  return { values: arrange(v, order), perm: permOf(order) };
}

/** Insert a module with its default knobs at chain position `at` (default: the end). Null when the rack is full. */
export function insertUnit(v: ParamValues, type: number, at?: number): { values: ParamValues; perm: Perm; slot: number } | null {
  const order = filled(v);
  if (order.length >= NSLOTS) return null;
  const pos = Math.max(0, Math.min(order.length, at ?? order.length));
  const fresh = { ...v };
  placeModule(fresh, 0, type);
  const data = order.map((s) => readSlot(v, s));
  data.splice(pos, 0, readSlot(fresh, 0));
  const out = { ...v };
  for (let s = 0; s < NSLOTS; s++) { if (s < data.length) writeSlot(out, s, data[s]); else clearSlot(out, s); }
  const perm = [...order];
  perm.splice(pos, 0, -1);
  return { values: out, perm: permOf(perm), slot: pos };
}

export function removeUnit(v: ParamValues, slot: number): { values: ParamValues; perm: Perm } {
  const order = filled(v).filter((s) => s !== slot);
  return { values: arrange(v, order), perm: permOf(order) };
}

/** Move the unit in `slot` to chain position `to` (counted after it is taken out). */
export function moveUnit(v: ParamValues, slot: number, to: number): { values: ParamValues; perm: Perm } {
  const rest = filled(v).filter((s) => s !== slot);
  const pos = Math.max(0, Math.min(rest.length, to));
  const order = [...rest.slice(0, pos), slot, ...rest.slice(pos)];
  return { values: arrange(v, order), perm: permOf(order) };
}

/** The parameters that differ between two value sets. */
export function changes(before: ParamValues, after: ParamValues): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id in after) if (before[id] !== after[id]) out[id] = after[id];
  return out;
}

/** The rack as a rig (module ids and real knob values), for copying out or saving as a file. */
export function toRig(v: ParamValues, name: string, tag: string): Rig {
  const rack: Unit[] = filled(v).map((s) => {
    const type = typeAt(v, s), def = MODULES[type];
    const vals: Record<string, number> = {};
    def.knobs.forEach((d, k) => {
      const real = fromNorm(d, v[slotKnobId(s, k)]);
      if (Math.abs(toNorm(d, real) - toNorm(d, d.def)) > 1e-4) vals[d.id] = Math.round(real * 1000) / 1000;
    });
    const u: Unit = { m: def.id };
    if (v[slotOnId(s)] < 0.5) u.off = true;
    if (Object.keys(vals).length) u.v = vals;
    return u;
  });
  const rig: Rig = { name, tag, rack };
  if (Math.abs(v.inGain) > 1e-6) rig.inGain = v.inGain;
  if (Math.abs(v.heat - 0.5) > 1e-6) rig.heat = v.heat;
  return rig;
}
