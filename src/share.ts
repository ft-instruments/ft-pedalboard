// Rig sharing: a rig as text. The portable form is the module-id Rig (module names and the knobs that differ
// from their defaults, in real units; see rack.ts toRig), so it survives new modules and reordered parameter
// ids. A share code is that JSON, deflated and base64url'd ('z' prefix; 'j' when this browser has no
// CompressionStream). Everything that comes in is untrusted: it is checked and clamped here before the app sees it.

import { MODULE_BY_ID, MODULES, NSLOTS, PARAM_BY_ID, type Rig, type Unit } from './dsp/params.ts';

const MAX_TEXT = 200_000;
const KEY = 'rig=';

/** A rig from anything JSON.parse gave us: the shape is checked, unknown modules and knobs are errors, numbers are clamped. */
export function cleanRig(raw: unknown): Rig {
  const o = (raw && typeof raw === 'object' && 'rig' in raw ? (raw as { rig: unknown }).rig : raw) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rack)) throw new Error('that is not a rig');
  const name = (typeof o.name === 'string' ? o.name : '').trim().slice(0, 40) || 'shared rig';
  const rig: Rig = { name, tag: 'mine', rack: [] };
  for (const id of ['inGain', 'heat'] as const) {
    const x = o[id];
    if (typeof x === 'number' && Number.isFinite(x)) { const p = PARAM_BY_ID[id]; rig[id] = Math.min(p.max, Math.max(p.min, x)); }
  }
  if (o.rack.length > NSLOTS) throw new Error(`a rack holds ${NSLOTS} units at most`);
  for (const u of o.rack as Record<string, unknown>[]) {
    const m = u && typeof u.m === 'string' ? MODULE_BY_ID[u.m] : undefined;
    if (m === undefined || MODULES[m].hidden) throw new Error(`this version has no module "${String(u && u.m)}"`);
    const unit: Unit = { m: u.m as string };
    if (u.off === true) unit.off = true;
    if (u.v && typeof u.v === 'object') {
      const v: Record<string, number> = {};
      for (const [k, x] of Object.entries(u.v as Record<string, unknown>)) {
        const d = MODULES[m].knobs.find((q) => q.id === k);
        if (!d) throw new Error(`${unit.m} has no knob "${k}"`);
        if (typeof x !== 'number' || !Number.isFinite(x)) continue;
        v[k] = Math.min(Math.max(d.min, d.max), Math.max(Math.min(d.min, d.max), x));
      }
      if (Object.keys(v).length) unit.v = v;
    }
    rig.rack.push(unit);
  }
  if (!rig.rack.length) throw new Error('that rig is empty');
  return rig;
}

const b64 = (bytes: Uint8Array): string => {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (t: string): Uint8Array => {
  const s = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  void w.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {}); void w.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** The rig as a short code: safe in a URL hash and in a chat message. */
export async function encodeShare(rig: Rig): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rig));
  if (typeof CompressionStream === 'undefined') return 'j' + b64(bytes);
  return 'z' + b64(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function decodeShare(code: string): Promise<Rig> {
  const c = code.trim();
  try {
    let bytes = unb64(c.slice(1));
    if (c[0] === 'z') {
      if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot open compressed codes');
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (c[0] !== 'j') throw new Error('bad code');
    return cleanRig(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    throw e instanceof Error && !/JSON|atob|Invalid|bad code|Unexpected/.test(e.message) ? e : new Error('that code is not a rig');
  }
}

/** A rig from pasted text: a share link, a bare code, or the rig as JSON (a file, or what "copy" puts on the clipboard). */
export async function parseAny(text: string): Promise<Rig> {
  const t = text.trim();
  if (!t || t.length > MAX_TEXT) throw new Error('that is not a rig');
  const at = t.indexOf('#' + KEY);
  if (at >= 0) return decodeShare(t.slice(at + 1 + KEY.length));
  if (t[0] === '{') { let j: unknown; try { j = JSON.parse(t); } catch { throw new Error('that is not valid JSON'); } return cleanRig(j); }
  return decodeShare(t);
}

/** The code in the page's address, if there is one. */
export function codeInHash(hash: string): string | null {
  const h = hash.replace(/^#/, '');
  return h.startsWith(KEY) && h.length > KEY.length ? h.slice(KEY.length) : null;
}

export const shareLink = (code: string): string => `${location.origin}${location.pathname}#${KEY}${code}`;

/** Offer the rig as a download. */
export function downloadRig(rig: Rig): void {
  const blob = new Blob([JSON.stringify(rig, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${rig.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'rig'}.ftrig.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
