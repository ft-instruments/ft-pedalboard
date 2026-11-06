// Offline checks of the DSP, in Node (type stripping, no build):
//
//   node scripts/render.ts              every rig x every demo loop: peak, RMS, NaNs, CPU
//   node scripts/render.ts test         unit checks: rigs, tuner, tone stack, every module at its extremes, swaps
//   node scripts/render.ts wav <rig> [strum|riff|lick] [seconds]
//                                       writes out/<rig>.wav to listen to (delete it afterwards)
//   node scripts/render.ts raw <dir>    every rig through the strum, raw float32 stereo, for scripts/null-test.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { PedalboardEngine } from '../src/dsp/engine.ts';
import { RIGS, MODULES, NSLOTS, NMODULES, MAX_KNOBS, rigValues, placeModule, defaults, slotTypeId, slotKnobId, type ParamValues } from '../src/dsp/params.ts';
import { DemoGuitar, DEMO_NAMES } from '../src/dsp/demo.ts';
import { Tuner } from '../src/dsp/tuner.ts';
import { treat } from '../src/doctor.ts';
import { insertUnit, moveUnit, removeUnit, pack, units, toRig } from '../src/rack.ts';
import { ToneStack, STACK_FENDER } from '../src/dsp/tonestack.ts';

const FS = 48000, BLOCK = 128;
const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

function render(values: Record<string, number>, pattern: number, seconds: number, at?: (t: number, e: PedalboardEngine) => void): { L: Float32Array; R: Float32Array; ms: number } {
  const e = new PedalboardEngine(FS);
  e.loadRig(values);
  e.snap();
  const g = new DemoGuitar(FS);
  g.setPattern(pattern);
  const n = Math.round(seconds * FS);
  const L = new Float32Array(n), R = new Float32Array(n), inp = new Float32Array(BLOCK);
  const t0 = performance.now();
  for (let off = 0; off < n; off += BLOCK) {
    const m = Math.min(BLOCK, n - off);
    at?.(off / FS, e);
    g.process(inp, m);
    e.process(inp, L.subarray(off, off + m), R.subarray(off, off + m), m);
  }
  return { L, R, ms: performance.now() - t0 };
}

function stats(L: Float32Array, R: Float32Array): { peak: number; rms: number; bad: number } {
  let peak = 0, sum = 0, bad = 0;
  for (let i = 0; i < L.length; i++) {
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) { bad++; continue; }
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    sum += L[i] * L[i] + R[i] * R[i];
  }
  return { peak, rms: Math.sqrt(sum / (2 * L.length)), bad };
}

function writeWav(path: string, L: Float32Array, R: Float32Array): void {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(FS, 24); buf.writeUInt32LE(FS * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

const slug = (name: string) => name.toLowerCase().split(/\s+/).join('-');

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const mode = process.argv[2] ?? 'all';

if (mode === 'test') {
  // every factory rig resolves (module and knob names exist) and has unique names
  let rigsOk = true;
  for (const r of RIGS) { try { rigValues(r); } catch (e) { console.log(`  ${(e as Error).message}`); rigsOk = false; } }
  check(rigsOk && new Set(RIGS.map((r) => r.name)).size === RIGS.length, `${RIGS.length} rigs resolve, names unique`);

  // rack edits keep the rack packed and carry each unit's knobs with it
  {
    const ids = (v: ParamValues) => units(v).map((s) => MODULES[Math.round(v[slotTypeId(s)])].id).join(' ');
    let v = rigValues(RIGS.find((r) => r.name === 'Solo Ridge')!);          // gate glow amp_plexi echo hall
    const echoTime = v[slotKnobId(3, 0)];
    v = moveUnit(v, 3, 0).values;                                           // echo first
    const moved = ids(v) === 'echo gate glow amp_plexi hall' && v[slotKnobId(0, 0)] === echoTime;
    v = insertUnit(v, MODULES.findIndex((m) => m.id === 'chorus'), 2)!.values;
    const inserted = ids(v) === 'echo gate chorus glow amp_plexi hall';
    const r = removeUnit(v, 1);
    const removed = ids(r.values) === 'echo chorus glow amp_plexi hall' && r.perm.slice(0, 5).join() === '0,2,3,4,5';
    let full = r.values;
    for (let i = units(full).length; i < NSLOTS; i++) full = insertUnit(full, 1)!.values;
    const capped = units(full).length === NSLOTS && insertUnit(full, 1) === null;
    const gap = { ...rigValues(RIGS[0]) }; gap[slotTypeId(1)] = 0;             // a host left a hole
    const packed = ids(pack(gap).values) === 'gate spring' && units(pack(gap).values).join() === '0,1';
    const round = JSON.stringify(rigValues(toRig(rigValues(RIGS[5]), 'x', 'clean'))) === JSON.stringify(rigValues(RIGS[5]));
    check(moved && inserted && removed && capped && packed, `rack edits: move ${moved}, insert ${inserted}, remove ${removed}, full at ${NSLOTS} ${capped}, pack ${packed}`);
    check(round, 'a rack copied out as a rig loads back the same');
  }

  // the tuner on guitar-like tones (fundamental + harmonics), open strings and a few frets
  const worst = [41.2, 65.41, 82.41, 110, 146.83, 196, 246.94, 329.63, 659.26, 987.77].reduce((w, f) => {
    const t = new Tuner(FS), x = new Float32Array(FS / 2);
    for (let i = 0; i < x.length; i++) {
      const ph = 2 * Math.PI * f * i / FS;
      x[i] = 0.2 * (Math.sin(ph) + 0.6 * Math.sin(2 * ph + 0.3) + 0.4 * Math.sin(3 * ph + 1.1) + 0.2 * Math.sin(4 * ph));
    }
    t.push(x, x.length);
    // a bass's low E may come back an octave up (the second harmonic): fine for a guitar tuner
    const cents = 1200 * Math.log2(t.freq / f);
    const err = Math.abs(cents - 1200 * Math.round(cents / 1200));
    return Math.max(w, Number.isFinite(err) ? err : 1e9);
  }, 0);
  check(worst < 1, `tuner within 1 cent on 41..988 Hz (worst ${worst.toFixed(2)} ct)`);
  const quiet = new Tuner(FS); quiet.push(new Float32Array(FS / 2), FS / 2);
  check(quiet.freq === 0, 'tuner reads nothing on silence');

  // the Bassman stack at noon: the scoop sits in the mids, ~10 dB under the lows
  const ts = new ToneStack(); ts.set(FS, STACK_FENDER, 0.5, 0.5, 0.5);
  const scoop = db(ts.mag(FS, 100)) - Math.min(...[400, 600, 800, 1000].map((f) => db(ts.mag(FS, f))));
  check(scoop > 6 && scoop < 12, `tone stack mid scoop ${scoop.toFixed(1)} dB`);

  // the tone doctor: each complaint moves the right knobs the right way, and does nothing where there is nothing to move
  {
    const k = (v: ParamValues, slot: number, id: string) => v[slotKnobId(slot, MODULES[Math.round(v[slotTypeId(slot)])].knobs.findIndex((d) => d.id === id))];
    const v0 = rigValues(RIGS.find((r) => r.name === 'Plexi Afternoon')!);     // gate, plexi, hall: the amp is slot 1
    const bright = treat(v0, 'bright').values, dark = treat(v0, 'dark').values, dirty = treat(v0, 'dirty').values, muddy = treat(v0, 'muddy').values;
    const ok = k(bright, 1, 'treble') < k(v0, 1, 'treble') && k(bright, 1, 'highcut') < k(v0, 1, 'highcut')
      && k(dark, 1, 'treble') > k(v0, 1, 'treble') && k(dirty, 1, 'gain') < k(v0, 1, 'gain') && k(muddy, 1, 'lowcut') > k(v0, 1, 'lowcut');
    let v = v0;
    for (let i = 0; i < 30; i++) v = treat(v, 'bright').values;
    const stops = k(v, 1, 'treble') === 0 && !treat(v, 'bright').moved.includes('treble');
    const empty = treat(rigValues({ name: 'x', tag: 'ambient', rack: [{ m: 'hall' }] }), 'bright').moved.length === 0;
    check(ok && stops && empty, `tone doctor: moves an amp's knobs the right way, stops at the ends, leaves a rack with nothing to turn alone`);
  }
  // every module with every knob at both ends, behind a hot amp, on all three loops: finite and bounded
  for (let m = 1; m < NMODULES; m++) {
    for (const end of [0, 1]) {
      const v: ParamValues = defaults();
      placeModule(v, 0, m);
      for (let k = 0; k < MODULES[m].knobs.length; k++) v[slotKnobId(0, k)] = end;
      if (m !== 6) placeModule(v, 1, 6, { gain: 0.8, master: 0.6 });
      let peak = 0, bad = 0;
      for (let pat = 0; pat < 3; pat++) { const o = render(v, pat, 3), s = stats(o.L, o.R); peak = Math.max(peak, s.peak); bad += s.bad; }
      check(bad === 0 && peak < 8, `${MODULES[m].id.padEnd(7)} knobs at ${end ? 'max' : 'min'}: peak ${db(peak).toFixed(1)} dBFS, ${bad} NaN`);
    }
  }
  // the whole rack full and maxed at once
  {
    const v = defaults();
    [5, 2, 6, 12, 9, 8, 11, 13].forEach((m, s) => placeModule(v, s, m));
    for (let s = 0; s < NSLOTS; s++) for (let k = 0; k < MAX_KNOBS; k++) v[slotKnobId(s, k)] = 1;
    const { L, R } = render(v, 1, 4);
    const st = stats(L, R);
    check(st.bad === 0 && st.peak < 8, `full rack, every knob at max: peak ${db(st.peak).toFixed(1)} dBFS, ${st.bad} NaN`);
  }
  // swapping modules while playing: no NaN, no jump bigger than the music's own
  {
    const v = rigValues(RIGS.find((r) => r.name === 'Solo Ridge')!);
    let jump = 0;
    const { L, R } = render(v, 0, 6, (t, e) => {
      const k = Math.floor(t * 4);       // a swap every 250 ms, cycling slot 3 through the library
      e.setParam(slotTypeId(3), k % NMODULES);
    });
    for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
    const st = stats(L, R);
    check(st.bad === 0 && jump < 0.6, `module swaps while playing: max step ${jump.toFixed(3)}, ${st.bad} NaN`);
  }
  // silence in, silence out (no self-oscillation, no denormal hiss)
  const e = new PedalboardEngine(FS);
  const loud = defaults();
  [5, 6, 9, 11, 13].forEach((m, s) => placeModule(loud, s, m, { gain: 1, fb: 0.9, decay: 10 }));
  e.loadRig(loud);
  const z = new Float32Array(FS * 3), L = new Float32Array(FS * 3), R = new Float32Array(FS * 3);
  e.process(z, L, R, z.length);
  check(stats(L, R).peak < 1e-4, `silence stays silent at max gain (${db(stats(L, R).peak).toFixed(0)} dBFS)`);
} else if (mode === 'wav') {
  const name = process.argv[3] ?? RIGS[0].name;
  const rig = RIGS.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!rig) { console.error(`no rig "${name}"; rigs: ${RIGS.map((r) => r.name).join(', ')}`); process.exit(1); }
  const pat = Math.max(0, DEMO_NAMES.indexOf(process.argv[4] ?? 'strum'));
  const secs = Number(process.argv[5] ?? 10);
  const { L, R } = render(rigValues(rig), pat, secs);
  mkdirSync('out', { recursive: true });
  const path = `out/${slug(rig.name)}-${DEMO_NAMES[pat]}.wav`;
  writeWav(path, L, R);
  const s = stats(L, R);
  console.log(`wrote ${path}: peak ${db(s.peak).toFixed(1)} dBFS, rms ${db(s.rms).toFixed(1)} dBFS`);
} else if (mode === 'raw') {
  const dir = process.argv[3] ?? 'out/ts';
  mkdirSync(dir, { recursive: true });
  for (const rig of RIGS) {
    const { L, R } = render(rigValues(rig), 0, 6);
    const inter = new Float32Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
    writeFileSync(`${dir}/${slug(rig.name)}.f32`, Buffer.from(inter.buffer));
  }
  console.log(`wrote ${RIGS.length} rigs to ${dir}`);
} else {
  // the DI on its own, for reference
  const di = new DemoGuitar(FS);
  for (let pat = 0; pat < 3; pat++) {
    di.setPattern(pat === 0 ? 1 : 0); di.setPattern(pat);
    const x = new Float32Array(FS * 8); di.process(x, x.length);
    const s = stats(x, x);
    console.log(`DI ${DEMO_NAMES[pat].padEnd(6)} peak ${db(s.peak).toFixed(1).padStart(6)} dBFS  rms ${db(s.rms).toFixed(1).padStart(6)}`);
  }
  console.log(`\n${'rig'.padEnd(18)} ${'tag'.padEnd(8)} ${DEMO_NAMES.map((d) => `${d} pk/rms`.padStart(15)).join('')}   x realtime`);
  let totalMs = 0, totalS = 0;
  for (const rig of RIGS) {
    const cells: string[] = [];
    for (let pat = 0; pat < 3; pat++) {
      const { L, R, ms } = render(rigValues(rig), pat, 8);
      totalMs += ms; totalS += 8;
      const s = stats(L, R);
      if (s.bad || s.peak > 1.5) failures++;
      cells.push(`${db(s.peak).toFixed(1).padStart(6)}/${db(s.rms).toFixed(1).padStart(6)}${s.bad ? ' NaN!' : '  '}`.padStart(15));
    }
    console.log(`${rig.name.padEnd(18)} ${rig.tag.padEnd(8)} ${cells.join('')}`);
  }
  console.log(`\nCPU: ${(totalS * 1000 / totalMs).toFixed(0)}x realtime on average (one core, Node)`);
  if (failures) console.log(`${failures} render(s) with NaNs or peaks over +3.5 dBFS`);
}
if (failures) process.exitCode = 1;
