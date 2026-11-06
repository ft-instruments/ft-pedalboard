// What the page remembers between visits (localStorage `ft-pedalboard.*`):
// the rig and your edits to it, the volume, the input, and rigs of your own.
// Everything read back is sanitised here: unknown ids dropped, numbers
// clamped to their parameter's range.

import { PARAM_BY_ID, NOT_IN_RIG, type ParamValues } from './dsp/params.ts';

const KEY_STATE = 'ft-pedalboard.state';
const KEY_RIGS = 'ft-pedalboard.rigs';

export interface Saved {
  rig: string;
  values: ParamValues;
  volume: number;
  source: string;
  device: string;
  channel: number;
}

export interface UserRig { name: string; values: Partial<ParamValues> }

export function cleanValues(raw: unknown, keepVolume = false): Partial<ParamValues> {
  const out: Partial<ParamValues> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const def = PARAM_BY_ID[id];
    if (!def || typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (!keepVolume && NOT_IN_RIG.includes(id)) continue;
    out[id] = Math.min(def.max, Math.max(def.min, v));
  }
  return out;
}

function read(key: string): unknown {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
function write(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked: forget it */ }
}

export function loadState(): Partial<Saved> {
  const s = read(KEY_STATE) as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return {};
  const out: Partial<Saved> = {};
  if (typeof s.rig === 'string') out.rig = s.rig.slice(0, 60);
  if (s.values) out.values = cleanValues(s.values) as ParamValues;
  if (typeof s.volume === 'number' && Number.isFinite(s.volume)) out.volume = Math.min(1, Math.max(0, s.volume));
  if (typeof s.source === 'string' && /^(live|demo:[0-2])$/.test(s.source)) out.source = s.source;
  if (typeof s.device === 'string') out.device = s.device.slice(0, 200);
  if (typeof s.channel === 'number' && [0, 1, 2].includes(s.channel)) out.channel = s.channel;
  return out;
}

export function saveState(s: Saved): void { write(KEY_STATE, s); }

export function loadUserRigs(): UserRig[] {
  const r = read(KEY_RIGS);
  if (!Array.isArray(r)) return [];
  return r.filter((x) => x && typeof x.name === 'string' && x.name.trim())
    .map((x) => ({ name: String(x.name).trim().slice(0, 40), values: cleanValues(x.values) }));
}

export function saveUserRigs(rigs: UserRig[]): void { write(KEY_RIGS, rigs); }
