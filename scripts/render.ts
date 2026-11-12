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
import { Eq7 } from '../src/dsp/eq.ts';
import { StudioComp } from '../src/dsp/comp2.ts';
import { CabIR, prepareIR } from '../src/dsp/cabir.ts';
import { Tuner } from '../src/dsp/tuner.ts';
import { encodeShare, decodeShare, parseAny, cleanRig, codeInHash } from '../src/share.ts';
import { treat } from '../src/doctor.ts';
import { insertUnit, moveUnit, removeUnit, pack, units, toRig } from '../src/rack.ts';
import { ToneStack, STACK_BASSMAN, yehMag } from '../src/dsp/tonestack.ts';
import { Amp, ampStages, AMP_CHIME, AMP_CRUNCH, AMP_CLEAN, AMP_MODERN, AMP_BRIT, AMP_LEAD, AMP_BLACKFACE, VOICINGS } from '../src/dsp/amp.ts';
import { SpringTank } from '../src/dsp/spring.ts';
import { Hall } from '../src/dsp/reverb.ts';
import { StageTable, STAGE_KINDS, FollowerTable, TUBE_LO, TUBE_INV } from '../src/dsp/tube.ts';
import { Cab } from '../src/dsp/cab.ts';
import { Oversampler, OS, Biquad } from '../src/dsp/util.ts';
import { Drive, tsTone, BUFFER_R, PICKUP_R, PICKUP_L, DRIVE_GLOW, DRIVE_RASP, DRIVE_FUZZ, DRIVE_MUFF, DRIVE_BOOST, DRIVE_TRANSPARENT, DRIVE_METAL, DRIVE_OCTAVE } from '../src/dsp/drive.ts';
import { LinearNet } from '../src/dsp/net.ts';
import { Wah } from '../src/dsp/wah.ts';
import { Comp } from '../src/dsp/comp.ts';
import { Gate } from '../src/dsp/gate.ts';
import { GuitarTone } from '../src/dsp/gtone.ts';

/** In-place radix-2 FFT. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const w = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const c = Math.cos(w * k), s = Math.sin(w * k), a = i + k, b = a + len / 2;
      const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

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

  // sharing: every factory rig survives a trip through a share code (same sound), and what comes in is checked
  {
    let same = true, longest = 0;
    for (const r of RIGS) {
      const a = rigValues(toRig(rigValues(r), r.name, r.tag));
      const code = await encodeShare(toRig(a, r.name, r.tag));
      longest = Math.max(longest, code.length);
      const b = rigValues(await decodeShare(code));
      for (const k in a) if (Math.abs(a[k] - b[k]) > 1e-3) { same = false; console.log(`  ${r.name}: ${k} ${a[k]} -> ${b[k]}`); break; }
    }
    check(same, `all rigs round-trip through a share code (longest ${longest} chars)`);
    const rejects = async (t: string) => { try { await parseAny(t); return false; } catch { return true; } };
    check(await rejects('') && await rejects('zzzz') && await rejects('{"rack":[{"m":"nope"}]}') && await rejects('{"rack":[{"m":"glow","v":{"nope":1}}]}')
      && await rejects('{"rack":[]}') && await rejects('{not json') && await rejects('j' + btoa('{"rack":5}')), 'garbage, unknown modules/knobs and empty racks are rejected');
    const c = cleanRig({ name: '  x'.repeat(40), inGain: 1e9, rack: [{ m: 'glow', v: { gain: 99, tone: -5, level: 'loud' } }] });
    check(c.name.length <= 40 && c.inGain! <= 30 && c.rack[0].v!.gain === 1 && c.rack[0].v!.tone === 0 && !('level' in c.rack[0].v!), 'imported names and numbers are clamped');
    const viaLink = await parseAny(`https://x.example/p/#rig=${await encodeShare(toRig(rigValues(RIGS[0]), 'a', 'clean'))}`);
    check(viaLink.name === 'a' && codeInHash('#rig=abc') === 'abc' && codeInHash('#other') === null, 'a pasted share link and the address hash are read');
  }

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
  const ts = new ToneStack(); ts.set(FS, STACK_BASSMAN, 0.5, 0.5, 0.5);
  const scoop = db(ts.mag(FS, 100)) - Math.min(...[400, 600, 800, 1000].map((f) => db(ts.mag(FS, f))));
  check(scoop > 6 && scoop < 12, `tone stack mid scoop ${scoop.toFixed(1)} dB`);
  // T9: the Bassman stack at noon, cathode-follower driven into 1M: about -12 dB at 700 Hz-1 kHz (ampbooks)
  const loss = (db(ts.mag(FS, 700)) + db(ts.mag(FS, 1000))) / 2;
  check(loss > -14 && loss < -10, `T9 Bassman stack loss at 700 Hz-1 kHz ${loss.toFixed(1)} dB (ampbooks ~-12)`);
  // T10: the network solver against Yeh and Smith's closed form (ideal source, no load: here 1 ohm and the 1M grid, so within 0.5 dB; exact unloaded)
  {
    let worst = 0;
    for (const [t, m, b] of [[0.5, 0.5, 0.5], [0, 0, 0], [1, 1, 1], [0.2, 0.8, 0.3]]) {
      ts.set(FS * 8, STACK_BASSMAN, t, m, b, 1);
      for (const f of [82, 330, 1000, 3000, 10000]) worst = Math.max(worst, Math.abs(db(ts.mag(FS, f)) - db(yehMag(STACK_BASSMAN, t, m, b, f))));
    }
    check(worst < 3, `T10 stack solver vs Yeh-Smith closed form (1M load): worst ${worst.toFixed(2)} dB`);
  }

  // ---- acceptance tests from the amp dossier (08-testing-without-listening.md)
  {
    const g = (k: number) => 20 * Math.log10(Math.abs(new StageTable(STAGE_KINDS[k]).gain));
    check(g(0) > 35 && g(0) < 39, `T1 12AX7 100k / 1.5k bypassed: ${g(0).toFixed(1)} dB (36-38)`);
    check(g(1) > 29.5 && g(1) < 32.5, `T2 the same unbypassed: ${g(1).toFixed(1)} dB (30-32)`);
    // T5: the cold clipper, 10k unbypassed: ~17-19 dB, mostly second harmonic when it starts to clip
    const t = new StageTable(STAGE_KINDS[3]);
    let c1 = [0, 0], c2 = [0, 0], c3 = [0, 0];
    for (let i = 0; i < 4096; i++) {
      const a = 2 * Math.PI * i / 4096, p = (4 * Math.sin(a) - TUBE_LO) * TUBE_INV, j = p | 0, y = t.vp[j] + (p - j) * (t.vp[j + 1] - t.vp[j]);
      c1 = [c1[0] + y * Math.cos(a), c1[1] + y * Math.sin(a)]; c2 = [c2[0] + y * Math.cos(2 * a), c2[1] + y * Math.sin(2 * a)]; c3 = [c3[0] + y * Math.cos(3 * a), c3[1] + y * Math.sin(3 * a)];
    }
    const h2 = Math.hypot(c2[0], c2[1]) / Math.hypot(c1[0], c1[1]), h3 = Math.hypot(c3[0], c3[1]) / Math.hypot(c1[0], c1[1]);
    check(g(3) > 16.5 && g(3) < 19.5 && h2 > h3, `T5 cold clipper (10k unbypassed): ${g(3).toFixed(1)} dB (17-19), H2 ${db(h2).toFixed(0)} dB over H3 ${db(h3).toFixed(0)} dB at 4 V pk`);
    const cf = new FollowerTable().gain;
    check(cf > 0.96 && cf < 0.995, `T7 cathode follower gain ${cf.toFixed(3)} (~0.98)`);
  }
  // small-signal response of a voicing at a preamp node (the grid of stage `tap`), dB re 1 kHz
  const node = (type: number, tap: number, f: number): number => {
    const a = new Amp(FS); a.tap = tap;
    const x = new Float32Array(BLOCK), blocks = Math.ceil(FS * 0.5 / BLOCK); let ph = 0, pk = 0;
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < BLOCK; i++) { x[i] = 1e-4 * Math.sin(ph); ph += 2 * Math.PI * f / FS; }
      a.process(x, BLOCK, type, 0.5, 0.5, 0.5, 0.5, 0.4, 0.4, 0, 1, -1);
      if (b > blocks * 0.6) for (let i = 0; i < BLOCK; i++) pk = Math.max(pk, Math.abs(x[i]));
    }
    return db(pk);
  };
  {
    // T13 / T15: into the Soldano voicing's last clipping stage: a shelf of -10..-18 dB at 82 Hz, flattening below (41 Hz within 3 dB of 82)
    const last = ampStages(AMP_MODERN) - 1, ref = node(AMP_MODERN, last, 1000);
    const r82 = node(AMP_MODERN, last, 82) - ref, r41 = node(AMP_MODERN, last, 41) - ref, r10k = node(AMP_MODERN, last, 10000) - ref;
    check(r82 > -18 && r82 < -10 && r82 - r41 < 3, `T13/T15 modern (SLO) into stage 4: ${r82.toFixed(1)} dB at 82 Hz, ${r41.toFixed(1)} at 41 Hz, ${r10k.toFixed(1)} at 10 kHz (ampbooks ~-16 / flat below / ~-15)`);
    const b = ampStages(AMP_BRIT) - 1, rb = node(AMP_BRIT, b, 82) - node(AMP_BRIT, b, 1000);
    check(rb > -14 && rb < -4, `brit 800 into V2a: ${rb.toFixed(1)} dB at 82 Hz (a shelf, not 30-45 dB of high-passes)`);
    // T14: the SLO overdrives stage 4 from ~3.4 mV pk at half gain: the small-signal gain to its grid against its ~1.5 V headroom
    const sens = 1.5 / Math.pow(10, (ref + 80) / 20) * 1e3;   // node() is the level of a 0.1 mV sine
    check(sens > 1.5 && sens < 7, `T14 modern at half gain overdrives stage 4 from ${sens.toFixed(1)} mV pk (ampbooks SLO: 3.4 mV)`);
    // the AC30 bright channel's small coupling cap: nearly 18 dB down at 82 Hz
    const ch = node(AMP_CHIME, 1, 82) - node(AMP_CHIME, 1, 1000);
    check(ch > -21 && ch < -14, `chime: ${ch.toFixed(1)} dB at 82 Hz into the second stage (ampbooks AC30: nearly -18)`);
  }
  {
    // T8: the bias shift after a 20 ms burst that drives the grid positive recovers on C x R (tens of ms), not in ~1 ms
    const a = new Amp(FS), n = 48, x = new Float32Array(n), caps: number[] = [];
    for (let b = 0; b < 3000; b++) {
      for (let i = 0; i < n; i++) { const t = (b * n + i) / FS; x[i] = t > 0.1 && t < 0.12 ? 0.5 * Math.sin(2 * Math.PI * 330 * t) : 0; }
      a.process(x, n, AMP_CRUNCH, 0.8, 0.5, 0.5, 0.5, 0.4, 0.4, 0, 1, -1);
      caps.push((a as unknown as { cap: Float64Array }).cap[1]);
    }
    const i0 = Math.round(0.125 * FS / n), c0 = Math.abs(caps[i0]); let k = i0;
    while (k < caps.length && Math.abs(caps[k]) > c0 / Math.E) k++;
    const tau = (k - i0) * n / FS * 1e3;
    check(c0 > 0.2 && tau > 10 && tau < 60, `T8 plexi V2a bias shift ${c0.toFixed(2)} V recovers to 1/e in ${tau.toFixed(0)} ms (22 nF x 1.47M = 32 ms; not < 5)`);
  }
  {
    // T17: the speaker load at the power stage (the 4x12 v30: Macak's measured V30 in a closed box), re 1 kHz at its resonance
    const out = (type: number, f: number, cab: number) => {
      const a = new Amp(FS), x = new Float32Array(BLOCK), blocks = Math.ceil(FS * 0.6 / BLOCK); let ph = 0, pk = 0;
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) { x[i] = 1e-4 * Math.sin(ph); ph += 2 * Math.PI * f / FS; }
        a.process(x, BLOCK, type, 0.3, 0.5, 0.5, 0.5, 0, 0.2, 0, 1, cab);
        if (b > blocks * 0.6) for (let i = 0; i < BLOCK; i++) pk = Math.max(pk, Math.abs(x[i]));
      }
      return db(pk);
    };
    const bump = (type: number, f: number) => out(type, f, 6) - out(type, f, -1) - (out(type, 1000, 6) - out(type, 1000, -1));
    const none = bump(AMP_CHIME, 105), top = bump(AMP_CHIME, 4000), marshall = bump(AMP_CRUNCH, 105), heavy = bump(AMP_CLEAN, 105);
    check(none > 7.5 && none < 11 && top > 4 && top < 8, `T17 no-feedback amp into a V30: +${none.toFixed(1)} dB at the resonance, +${top.toFixed(1)} at 4 kHz (+8-10, +4-7)`);
    check(marshall > 1.5 && marshall < none && heavy > 1 && heavy < marshall, `T17 with feedback: plexi +${marshall.toFixed(1)}, 6L6 clean +${heavy.toFixed(1)} dB (less with more feedback)`);
  }
  {
    // T23: the cabinets' -10 dB points re 1 kHz, mic at its default: the top near 5-6 kHz (Celestion: 70/75-5000 Hz)
    const c = new Cab(FS); let ok = true; const tops: string[] = [];
    for (const t of [2, 4, 6]) {
      c.set(t, 0.3); const r = c.mag(1000); let hi = 0;
      for (let f = 3000; f < 16000 && !hi; f *= 1.01) if (c.mag(f) / r < 0.316) hi = f;
      tops.push(hi.toFixed(0)); ok = ok && hi > 4500 && hi < 7500;
    }
    check(ok, `T23 4x12 / greenback / v30 cabinets fall 10 dB by ${tops.join(' / ')} Hz`);
  }
  {
    // T26-style: what folds back into the audio band from a tone made at 8x above it (the oversampler's rejection)
    let worst = -Infinity;
    for (const f of [28000, 33000, 40000, 60000, 100000]) {
      const o = new Oversampler(FS), N = 1 << 14, u = new Float32Array(N * OS), y = new Float32Array(N);
      for (let i = 0; i < N * OS; i++) u[i] = Math.sin(2 * Math.PI * f * i / (FS * OS));
      o.downsample(u, y, N);
      let al = f % FS; if (al > FS / 2) al = FS - al;
      let re = 0, im = 0, ws = 0;
      for (let i = N / 2; i < N; i++) { const t = (i - N / 2) / (N / 2), w = 0.35875 - 0.48829 * Math.cos(2 * Math.PI * t) + 0.14128 * Math.cos(4 * Math.PI * t) - 0.01168 * Math.cos(6 * Math.PI * t); ws += w; re += w * y[i] * Math.cos(2 * Math.PI * al * i / FS); im += w * y[i] * Math.sin(2 * Math.PI * al * i / FS); }
      worst = Math.max(worst, db(2 * Math.hypot(re, im) / ws + 1e-30));
    }
    check(worst < -100, `oversampler: tones at 28-100 kHz fold into the audio band at ${worst.toFixed(0)} dB or less (>= 100 dB rejection)`);
  }
  // ---- acceptance tests from the pedal dossier (pedals-01/02/04): drives in volts, at the level pot full (+12)
  {
    const sine = (f: number, a: number, s: number) => { const x = new Float32Array(Math.round(s * FS)); for (let i = 0; i < x.length; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / FS); return x; };
    const drv = (type: number, gain: number, tone: number, x: Float32Array, srcR = BUFFER_R, srcL = 0) => {
      const d = new Drive(FS), y = new Float32Array(x);
      for (let o = 0; o < y.length; o += BLOCK) d.process(y.subarray(o, o + BLOCK), Math.min(BLOCK, y.length - o), type, gain, tone, 12, srcR, srcL);
      return y;
    };
    // the amplitude of f in the second half of y
    const amp = (y: Float32Array, f: number) => {
      const s = y.length >> 1; let re = 0, im = 0;
      for (let i = s; i < y.length; i++) { re += y[i] * Math.cos(2 * Math.PI * f * i / FS); im += y[i] * Math.sin(2 * Math.PI * f * i / FS); }
      return 2 * Math.hypot(re, im) / (y.length - s);
    };
    const thd = (y: Float32Array, f: number) => { let h = 0; for (let k = 2; k < 10; k++) h += amp(y, f * k) ** 2; return db(Math.sqrt(h) / amp(y, f)); };
    // inharmonic content (worst FFT bin away from the harmonics, below 20 kHz, re the fundamental), 2^15 Blackman-Harris
    const inharmonic = (type: number, f0: number) => {
      const N = 1 << 15, fq = Math.round(f0 * N / FS) * FS / N, y = drv(type, 1, 0.5, sine(fq, 0.5, (N + 24000) / FS));
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) { const t = i / N; re[i] = y[24000 + i] * (0.35875 - 0.48829 * Math.cos(2 * Math.PI * t) + 0.14128 * Math.cos(4 * Math.PI * t) - 0.01168 * Math.cos(6 * Math.PI * t)); }
      fftInPlace(re, im);
      const k0 = Math.round(fq * N / FS), ref = Math.hypot(re[k0], im[k0]);
      let worst = 0;
      for (let k = 10; k < Math.floor(20000 * N / FS); k++) { const h = k / k0; if (Math.abs(h - Math.round(h)) * k0 > 6) worst = Math.max(worst, Math.hypot(re[k], im[k])); }
      return db(worst / ref);
    };
    // P6: the TS clipping stage (Yeh's ODE, solved by backward Euler) and its tone stage against the analytic small-signal response
    {
      const tone = new Biquad(); tsTone(tone, FS, 0.5);
      const A = (f: number) => {   // 1 + Zf / Zs at the drive knob's 0: R2 = 51k across 51 pF, Zs = 4.7k + 47 nF
        const w = 2 * Math.PI * f, R2 = 51e3, zfR = R2 / (1 + (w * R2 * 51e-12) ** 2), zfI = -w * R2 * R2 * 51e-12 / (1 + (w * R2 * 51e-12) ** 2);
        const zsR = 4.7e3, zsI = -1 / (w * 47e-9), d = zsR * zsR + zsI * zsI;
        return Math.hypot(1 + (zfR * zsR + zfI * zsI) / d, (zfI * zsR - zfR * zsI) / d);
      };
      let worst = 0;
      for (const f of [100, 300, 720, 2000, 5000]) worst = Math.max(worst, Math.abs(db(amp(drv(DRIVE_GLOW, 0, 0.5, sine(f, 0.002, 0.5)), f) / 0.002) - db(A(f) * tone.mag(FS, f))));
      check(worst < 0.6, `P6 TS small-signal response (drive 0, tone noon) against Yeh's A(s) and the tone circuit: worst ${worst.toFixed(2)} dB`);
      const y = drv(DRIVE_GLOW, 0.5, 0.5, sine(220, 0.1, 1)), h2 = db(amp(y, 440) / amp(y, 220)), h3 = db(amp(y, 660) / amp(y, 220));
      check(h2 > -50 && h2 < -25 && h3 > h2, `P6 TS at 220 Hz, 100 mV: a little second harmonic (${h2.toFixed(0)} dB), odd still dominant (H3 ${h3.toFixed(0)} dB)`);
    }
    // P2: the Big Muff's tone stack at noon scoops 5-10 dB near 1 kHz (J.L.: ~-6 dB at 0.9 kHz; Ram's Head, a big scoop)
    {
      const net = new LinearNet(4, FS);
      net.r(1, 2, 5e3); net.r(2, 3, 39e3); net.c(3, 0, 10e-9); net.c(2, 4, 4e-9); net.r(4, 0, 22e3); net.r(3, 5, 50e3); net.r(5, 4, 50e3); net.r(5, 0, 100e3);
      const mag = (f: number) => { net.reset(); let re = 0, im = 0; for (let i = 0; i < FS; i++) { const s = Math.sin(2 * Math.PI * f * i / FS); net.tick(s); if (i >= FS / 2) { re += net.v[5] * s; im += net.v[5] * Math.cos(2 * Math.PI * f * i / FS); } } return db(Math.hypot(re, im) * 4 / FS); };
      const notch = Math.min(mag(800), mag(1000), mag(1200)), scoop = (mag(100) + mag(8000)) / 2 - notch;
      check(scoop > 5 && scoop < 10, `P2 muff tone stack at noon: ${scoop.toFixed(1)} dB scoop near 1 kHz`);
    }
    // P3 / P4 / P5: what folds back from full gain and a 0.5 V sine (dossier target: below -80 dB; hard clippers at 8x can't reach it)
    {
      const lim: [number, string, number][] = [[DRIVE_GLOW, 'glow', -100], [DRIVE_RASP, 'rasp', -85], [DRIVE_MUFF, 'muff', -90], [DRIVE_BOOST, 'boost', -100], [DRIVE_TRANSPARENT, 'transparent', -100], [DRIVE_METAL, 'metal', -95], [DRIVE_OCTAVE, 'octave', -100], [DRIVE_FUZZ, 'fuzz', -70]];
      for (const [t, name, l] of lim) {
        const a = inharmonic(t, 1370), b = inharmonic(t, 4100);
        check(a < l, `aliasing, ${name.padEnd(11)} full gain, 0.5 V: ${a.toFixed(0)} dB at 1.37 kHz (limit ${l}), ${b.toFixed(0)} dB at 4.1 kHz`);
      }
    }
    // P7: the Fuzz Face's idle point (germanium targets: Q1 ~0.25 mA, Q2 ~0.45 mA) and the cleanup with the guitar's volume
    {
      const ff = (new Drive(FS) as unknown as { ff: { vc: number; vk: number } }).ff, i1 = (9 - ff.vc) / 33, i2 = (9 - ff.vk) / 8.67;
      check(i1 > 0.2 && i1 < 0.3 && i2 > 0.38 && i2 < 0.52, `P7 fuzz idles at Q1 ${i1.toFixed(3)} mA, Q2 ${i2.toFixed(3)} mA (Q2 collector ${ff.vk.toFixed(2)} V)`);
      const vol = (v: number) => { const a = v * v; return drv(DRIVE_FUZZ, 0.4, 1, sine(196, 0.3 * a, 0.6), 250e3 * a * (1 - a) + a * a * PICKUP_R, a * a * PICKUP_L); };
      const full = thd(vol(1), 196), back = thd(vol(0.6), 196), buffered = thd(drv(DRIVE_FUZZ, 0.4, 1, sine(196, 0.3 * 0.36, 0.6)), 196);
      check(full > -10 && back < -30 && buffered > -10, `P7 fuzz at 4: THD ${full.toFixed(0)} dB at guitar volume 10, ${back.toFixed(0)} dB at 6 (it cleans up), ${buffered.toFixed(0)} dB at the same level behind a buffer (it doesn't)`);
    }
    // P8: the Klon's treble control (Chowdhury's eq. 2) moves the top by ~20 dB; RAT's filter knob by more than 15 dB
    {
      const k = (t: number) => db(amp(drv(DRIVE_TRANSPARENT, 0, t, sine(4000, 0.005, 0.5)), 4000));
      const r = (t: number) => db(amp(drv(DRIVE_RASP, 0, t, sine(4000, 0.005, 0.5)), 4000));
      const kd = k(1) - k(0), rd = r(1) - r(0);
      check(kd > 18 && kd < 27 && rd > 15, `P8 transparent treble 0 to 10 at 4 kHz: +${kd.toFixed(1)} dB; rasp filter: +${rd.toFixed(1)} dB`);
    }
    // P9: the wah (Smith's Cry Baby fit): the band's power about level heel to toe, the peak where it should be, Holters' saturation
    {
      const run = (pos: number, x: Float32Array) => { const w = new Wah(FS), y = new Float32Array(x); for (let o = 0; o < y.length; o += BLOCK) w.process(y.subarray(o, o + BLOCK), Math.min(BLOCK, y.length - o), pos, 0, 0.6, 0); return y; };
      let seed = 1; const noise = new Float32Array(FS * 2);
      for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; noise[i] = 0.01 * ((seed / 2147483648) * 2 - 1); }
      const pw = (pos: number) => { const y = run(pos, noise); let s = 0; for (let i = FS; i < y.length; i++) s += y[i] * y[i]; return 10 * Math.log10(s); };
      const tilt = pw(1) - pw(0);
      const peakAt = (pos: number) => { let best = 0, bf = 0; for (let f = 300; f < 3500; f *= 1.03) { const g = amp(run(pos, sine(f, 1e-3, 0.4)), f); if (g > best) { best = g; bf = f; } } return bf; };
      const heel = peakAt(0), toe = peakAt(1);
      const g = (a: number) => db(amp(run(0, sine(450, a, 0.5)), 450) / a), red = g(1e-3) - g(1);
      check(Math.abs(tilt) < 2 && heel > 400 && heel < 500 && toe > 2000 && toe < 2500 && red > 10 && red < 16,
        `P9 wah: toe ${tilt >= 0 ? '+' : ''}${tilt.toFixed(1)} dB re heel in power (was +2), peaks at ${heel.toFixed(0)} / ${toe.toFixed(0)} Hz, ${red.toFixed(1)} dB less gain at 1 V (Holters ~13)`);
    }
    // P13: the compressor at its fastest release doesn't ride a low note's waveform (dossier: hold >= 2 periods of 80 Hz)
    {
      const c = new Comp(FS), x = sine(100, 0.3, 1);
      for (let o = 0; o < x.length; o += BLOCK) c.process(x.subarray(o, o + BLOCK), BLOCK, 1, 0.0005, 0.05, 0, 1);
      const t = thd(x, 100);
      check(t < -60, `P13 squeeze at 100 Hz, 0.5 ms attack, 50 ms release: THD ${t.toFixed(0)} dB (was -41: 0.9%)`);
    }
    // the gate on a decaying note with a little noise: it closes once, no chatter
    {
      const g = new Gate(FS), n = FS * 4, x = new Float32Array(n); let s = 7, flips = 0, last = -1;
      for (let i = 0; i < n; i++) { const t = i / FS; s = (s * 1103515245 + 12345) % 2147483648; x[i] = 0.3 * Math.exp(-t * 1.7) * Math.sin(2 * Math.PI * 110 * t) + 3e-4 * ((s / 2147483648) * 2 - 1); }
      for (let o = 0; o < n; o += BLOCK) { g.process(x.subarray(o, o + BLOCK), BLOCK, -62, 0.08); const st = g.reduction < 0.5 ? 1 : 0; if (last >= 0 && st !== last) flips++; last = st; }
      check(flips <= 1, `gate on a 4 s decay through its threshold: ${flips} open/close changes`);
    }
    // the guitar-tone unit with both knobs at 10 is transparent on a real guitar's DI (it used to load the pickup a second time)
    {
      let worst = 0;
      for (const f of [50, 500, 2000, 4000, 6000, 10000, 16000]) {
        const u = new GuitarTone(FS), x = sine(f, 0.01, 0.4);
        for (let o = 0; o < x.length; o += BLOCK) u.process(x.subarray(o, o + BLOCK), BLOCK, 1, 1);
        worst = Math.max(worst, Math.abs(db(amp(x, f) / 0.01)));
      }
      check(worst < 0.1, `guitar tone at 10/10: within ${worst.toFixed(2)} dB of flat, 50 Hz-16 kHz (was -7.7 dB at 5 kHz)`);
    }
    // P14: the EQ's 6 kHz shelf and 2.5 kHz bell at +-12 dB stay within 1 dB of their analog prototypes at 44.1 kHz
    {
      const fs = 44100, A = Math.pow(10, 12 / 40), sh = new Biquad(), bl = new Biquad(); sh.highShelf(fs, 6000, 12); bl.peak(fs, 2500, 0.9, 12);
      let worst = 0;
      for (let f = 20; f < 20000; f *= 1.02) {
        const w = f / 6000, Q = Math.SQRT1_2, s = Math.hypot(A * (1 - A * w * w), A * Math.sqrt(A) / Q * w) / Math.hypot(A - w * w, Math.sqrt(A) / Q * w);
        const u = f / 2500, b = Math.hypot(1 - u * u, A / 0.9 * u) / Math.hypot(1 - u * u, u / (A * 0.9));
        worst = Math.max(worst, Math.abs(db(sh.mag(fs, f) / s)), Math.abs(db(bl.mag(fs, f) / b)));
      }
      check(worst < 1, `P14 eq shelf and bell against their analog prototypes at 44.1 kHz: worst ${worst.toFixed(2)} dB`);
    }
  }
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
  // ---- robustness (fixer audit, pedals #1): the Fuzz Face behind a buffer went to NaN and silenced the whole rack
  {
    // an additive pluck: harmonics of each note decaying, peak scaled to `pk` volts
    const pluckAt = (fs: number, secs: number, notes: number[], pk: number) => {
      const n = Math.round(fs * secs), y = new Float32Array(n);
      for (const f0 of notes) for (let k = 1; k <= 12 && f0 * k < fs / 2.2; k++) for (let i = 0; i < n; i++) y[i] += Math.exp(-i / fs * (1.2 + 0.5 * k)) * Math.sin(2 * Math.PI * f0 * k * i / fs + k) / k;
      // the pick: a 2 ms burst of noise (the old solve failed on this kind of edge)
      let r = 7; for (let i = 0; i < Math.min(n, fs * 0.01); i++) { r = (r * 1103515245 + 12345) % 2147483648; y[i] += 2 * (r / 2147483648 - 0.5) * Math.exp(-i / (0.002 * fs)); }
      let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(y[i]));
      for (let i = 0; i < n; i++) y[i] *= pk / m;
      return y;
    };
    const run = (e: PedalboardEngine, x: Float32Array, block = 128) => {
      const L = new Float32Array(x.length), R = new Float32Array(x.length);
      for (let o = 0; o < x.length; o += block) { const m = Math.min(block, x.length - o); e.process(x.subarray(o, o + m), L.subarray(o, o + m), R.subarray(o, o + m), m); }
      return { L, R };
    };
    const pkOf = (y: Float32Array, a: number, b: number) => { let p = 0; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(y[i])); return p; };
    // the auditor's rack: gate, fuzz at 1, plexi, hall; a hard humbucker chord, then an ordinary single-coil note
    for (const fs of [44100, 48000]) {
      const e = new PedalboardEngine(fs);
      e.loadRig(rigValues({ name: 't', tag: 'fuzz', rack: [{ m: 'gate' }, { m: 'fuzz', v: { gain: 0.1, level: -12 } }, { m: 'amp_plexi' }, { m: 'hall' }] })); e.snap();
      const x = new Float32Array(3 * fs); x.set(pluckAt(fs, 1, [82.4, 164.8, 246.9], 0.6), 0); x.set(pluckAt(fs, 2, [164.8], 0.15), fs);
      const { L } = run(e, x), late = pkOf(L, fs + 1000, 3 * fs), faults = e.slotFaults.reduce((a, b) => a + b, 0);
      check(L.every(Number.isFinite) && late > 0.05 && faults === 0, `gate > fuzz > plexi > hall at ${fs / 1000} kHz: a 0.6 V chord then a 0.15 V note, the note still plays (peak ${late.toFixed(3)}), ${faults} slot resets`);
    }
    // the fuzz alone behind a buffer and on the pickup, every knob end, chords and sines to 5 V
    {
      let bad = 0, faults = 0;
      for (const fs of [44100, 48000, 96000]) for (const [sr, sl] of [[BUFFER_R, 0], [PICKUP_R, PICKUP_L]]) for (const g of [0, 0.2, 0.5, 1]) for (const pk of [0.3, 0.6, 1, 2, 5]) {
        const x = pluckAt(fs, 0.5, [82.4, 164.8, 246.9], pk), d = new Drive(fs);
        for (let o = 0; o < x.length; o += 128) d.process(x.subarray(o, o + 128), Math.min(128, x.length - o), DRIVE_FUZZ, g, 0.5, 0, sr, sl);
        if (!x.every(Number.isFinite)) bad++;
        faults += (d as unknown as { ff: { faults: number } }).ff.faults;
      }
      check(bad === 0 && faults === 0, `fuzz solve, 120 runs (44.1/48/96 kHz, buffered and pickup, fuzz 0-1, 0.3-5 V chords; the old solve failed 22 of the buffered ones): ${bad} non-finite, ${faults} fallbacks to the last sample`);
    }
    // a module that does go non-finite is reset and silenced, and the slots after it carry on
    {
      const e = new PedalboardEngine(FS);
      e.loadRig(rigValues({ name: 't', tag: 'fuzz', rack: [{ m: 'gate' }, { m: 'glow' }, { m: 'amp_plexi' }, { m: 'hall' }] })); e.snap();
      const drv = (e as unknown as { slots: { drive: Drive[] }[] }).slots[1].drive[0], orig = drv.process.bind(drv);
      let calls = 0;
      drv.process = (x: Float32Array, n: number, ...a: unknown[]) => { (orig as (...z: unknown[]) => void)(x, n, ...a); if (++calls === 50) x[3] = NaN; };
      const peaks: number[] = [];
      const x = pluckAt(FS, 2, [196, 247], 0.3), L = new Float32Array(x.length), R = new Float32Array(x.length);
      for (let o = 0; o < x.length; o += BLOCK) { e.process(x.subarray(o, o + BLOCK), L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK), BLOCK); peaks.push(e.slotPeak[1]); }
      const late = pkOf(L, FS, 2 * FS);
      check(L.every(Number.isFinite) && e.slotFaults[1] === 1 && peaks[49] >= 1000 && late > 0.01, `a NaN injected into a slot: reset once (${e.slotFaults[1]}), its meter pegs for that block, the rack plays on (peak ${late.toFixed(3)} a second later)`);
    }
    // random stress: every module after a gate (so the drives see a buffer), random knobs, hot random input, 44.1 kHz
    {
      let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      let bad = 0, resets = 0, runs = 0;
      for (let m = 1; m < NMODULES; m++) for (let t = 0; t < 3; t++) {
        const fs = 44100, v = defaults();
        placeModule(v, 0, 1);
        placeModule(v, 1, m);
        for (let k = 0; k < MAX_KNOBS; k++) v[slotKnobId(1, k)] = rnd();
        placeModule(v, 2, MODULES.findIndex((d) => d.id === 'amp_hot'), { gain: rnd(), master: rnd() });
        const e = new PedalboardEngine(fs); e.loadRig(v); e.snap();
        const kind = t, a = 0.1 * Math.pow(30, rnd()), x = new Float32Array(Math.round(0.6 * fs));
        if (kind === 0) x.set(pluckAt(fs, 0.6, [82.4, 164.8, 246.9], a));
        else for (let i = 0; i < x.length; i++) x[i] = kind === 1 ? a * (rnd() * 2 - 1) : (Math.sin(2 * Math.PI * 110 * i / fs) > 0 ? a : -a);
        const { L, R } = run(e, x, 37);
        if (!L.every(Number.isFinite) || !R.every(Number.isFinite)) bad++;
        resets += e.slotFaults.reduce((p, q) => p + q, 0); runs++;
      }
      check(bad === 0 && resets === 0, `random stress, ${runs} runs (every module after a gate, random knobs, 0.1-3 V chords, noise and squares, into a hot plexi): ${bad} non-finite, ${resets} slot resets`);
    }
  }
  // ---- the fixer audit's other findings, each as a check
  {
    const amp = (y: Float32Array, f: number) => { const s0 = y.length >> 1; let re = 0, im = 0; for (let i = s0; i < y.length; i++) { re += y[i] * Math.cos(2 * Math.PI * f * i / FS); im += y[i] * Math.sin(2 * Math.PI * f * i / FS); } return 2 * Math.hypot(re, im) / (y.length - s0); };
    const inh = (y: Float32Array, fs: number, N: number, k0: number) => {   // inharmonic power re the total below 20 kHz, bin-exact tone, no window
      const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = y[y.length - N + i];
      fftInPlace(re, im); let tot = 0, bad = 0;
      for (let k = 1; k < Math.floor(20000 * N / fs); k++) { const p = re[k] * re[k] + im[k] * im[k]; tot += p; if (k % k0) bad += p; }
      return 10 * Math.log10(bad / tot);
    };
    // aliasing at 44.1 kHz (the Spark GO's rate), full gain, 0.5 V, the treble up: the worst of 1.37 / 2.8 / 4.1 kHz
    {
      const fs = 44100, N = 16384, rows: string[] = []; let ok = true;
      for (const [t, name, lim] of [[DRIVE_FUZZ, 'fuzz', -68], [DRIVE_RASP, 'rasp', -72], [DRIVE_METAL, 'metal', -85], [DRIVE_OCTAVE, 'octave', -95], [DRIVE_MUFF, 'muff', -95]] as [number, string, number][]) {
        let w = -Infinity;
        for (const f0 of [1370, 2800, 4100]) {
          const k0 = Math.round(f0 * N / fs), f = k0 * fs / N, x = new Float32Array(N * 3), d = new Drive(fs), pu = t === DRIVE_FUZZ || t === DRIVE_MUFF;
          for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / fs);
          for (let o = 0; o < x.length; o += 128) d.process(x.subarray(o, o + 128), 128, t, 1, 1, 12, pu ? PICKUP_R : BUFFER_R, pu ? PICKUP_L : 0);
          w = Math.max(w, inh(x, fs, N, k0));
        }
        ok = ok && w < lim; rows.push(`${name} ${w.toFixed(0)}`);
      }
      // the amps, gain and master full, 0.3 V, no cabinet (they were -42..-49 at 8x)
      for (const [v, name] of [[AMP_LEAD, 'hot plexi'], [8, 'rectified'], [12, 'orange']] as [number, string][]) {
        let w = -Infinity;
        for (const f0 of [1370, 5900]) {
          const k0 = Math.round(f0 * N / fs), f = k0 * fs / N, x = new Float32Array(N * 3), a = new Amp(fs);
          for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * f * i / fs);
          for (let o = 0; o < x.length; o += 128) a.process(x.subarray(o, o + 128), 128, v, 1, 0.5, 0.5, 0.5, 0.4, 1, 0.35, 1, -1);
          w = Math.max(w, inh(x, fs, N, k0));
        }
        ok = ok && w < -70; rows.push(`${name} ${w.toFixed(0)}`);
      }
      check(ok, `aliasing at 44.1 kHz, full gain (inharmonic re total, worst tone): ${rows.join(', ')} dB`);
    }
    // the power stage: a Deluxe Reverb (blackface, volume at 5) is at full power from ~63 mV peak at 1 kHz (Robinette:
    // 37 mV RMS gives 15 of its 22 W); the old scaling needed 1.27 V with the master full and never got there at 0.4
    {
      const fp = (v: number, gain: number) => {
        const at = (a: number) => { const amp = new Amp(FS), x = new Float32Array(BLOCK); let ph = 0, h = 0;
          for (let o = 0; o < BLOCK * 60; o += BLOCK) { for (let i = 0; i < BLOCK; i++) { x[i] = a * Math.sin(ph); ph += 2 * Math.PI * 1000 / FS; } amp.process(x, BLOCK, v, gain, 0.5, 0.5, 0.5, 0.4, VOICINGS[v].mv ? 0.4 : 1, 0.35, 1, -1); if (o > BLOCK * 30) h = Math.max(h, amp.stageHeat[4]); }
          return h; };
        let lo = 1e-4, hi = 10; for (let it = 0; it < 16; it++) { const m = Math.sqrt(lo * hi); if (at(m) >= 1) hi = m; else lo = m; } return hi;
      };
      const bf = fp(AMP_BLACKFACE, 0.5), pl = fp(AMP_CRUNCH, 1);
      check(bf > 0.016 && bf < 0.25 && pl < 0.01, `power stage at full power: blackface at gain 5 from ${(bf * 1e3).toFixed(0)} mV pk (Robinette ~63), plexi at gain 10 from ${(pl * 1e3).toFixed(1)} mV`);
    }
    // the AC30 top boost's treble is a log pot: at noon about 15% of its travel (it was linear, +9.6 dB at 4 kHz instead of +4.4)
    {
      const t = new ToneStack(); const STB = { topo: 1, R1: 1e6, R2: 1e6, R3: 20e3, R4: 100e3, C1: 50e-12, C2: 22e-9, C3: 22e-9 };
      t.set(FS, STB, 0.5, 0.5, 0.5, 600); const a = db(t.mag(FS, 4000) / t.mag(FS, 1000));
      t.set(FS, STB, 1, 0.5, 0.5, 600); const b = db(t.mag(FS, 4000) / t.mag(FS, 1000));
      check(a < 7 && b > a + 5, `top boost treble: 4 kHz re 1 kHz ${a.toFixed(1)} dB at noon, ${b.toFixed(1)} dB at full (log taper)`);
    }
    // the Big Muff's output is upright (four inversions) and has some second harmonic (stage 1 swings lopsided)
    {
      const x = new Float32Array(FS); for (let i = 0; i < x.length; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / FS);
      const d = new Drive(FS), y = new Float32Array(x);
      for (let o = 0; o < y.length; o += BLOCK) d.process(y.subarray(o, o + BLOCK), BLOCK, DRIVE_MUFF, 1, 0.5, 12, BUFFER_R, 0);
      let re = 0, im = 0, re2 = 0, im2 = 0;
      for (let i = FS / 2; i < FS; i++) { const w = 2 * Math.PI * 220 * i / FS; re += y[i] * Math.sin(w); im += y[i] * Math.cos(w); re2 += y[i] * Math.cos(2 * w); im2 += y[i] * Math.sin(2 * w); }
      const h2 = db(Math.hypot(re2, im2) / Math.hypot(re, im));
      check(re > 0 && Math.abs(im) < re && h2 > -60, `muff: in phase with its input (${re > 0 ? 'upright' : 'inverted'}), H2 ${h2.toFixed(0)} dB at 0.4 V, sustain 10 (was below -80)`);
    }
    // the treble booster's output cap: no DC moving with the envelope (it was 0.57 V on a 1 V chord)
    {
      const x = new Float32Array(FS); for (let i = 0; i < x.length; i++) { const t = i / FS; x[i] = Math.exp(-3 * t) * (Math.sin(2 * Math.PI * 110 * t) + 0.7 * Math.sin(2 * Math.PI * 165 * t)) * 0.6; }
      const d = new Drive(FS); for (let o = 0; o < x.length; o += BLOCK) d.process(x.subarray(o, o + BLOCK), BLOCK, DRIVE_BOOST, 1, 0.5, 12, BUFFER_R, 0);
      let m = 0; for (let i = FS / 10; i < FS / 2; i++) m += x[i]; m /= FS * 0.4;
      let pk = 0; for (let i = FS / 10; i < FS / 2; i++) pk = Math.max(pk, Math.abs(x[i]));
      check(Math.abs(m) < 0.02 * pk, `boost at 10 on a 1 V chord: mean ${m.toFixed(3)} V against a ${pk.toFixed(2)} V peak`);
    }
    // the fuzz, muff and booster don't get the DI's pickup resonance a second time: small-signal 3.7 kHz re 500 Hz with the
    // pickup in front is no higher than behind a buffer plus the coil's own loading
    {
      const rel = (srcR: number, srcL: number) => { const g = (f: number) => { const x = new Float32Array(FS / 2); for (let i = 0; i < x.length; i++) x[i] = 0.002 * Math.sin(2 * Math.PI * f * i / FS);
        const d = new Drive(FS); for (let o = 0; o < x.length; o += BLOCK) d.process(x.subarray(o, o + BLOCK), BLOCK, DRIVE_BOOST, 0.5, 1, 12, srcR, srcL); return amp(x, f); }; return db(g(3700) / g(500)); };
      const pu = rel(PICKUP_R, PICKUP_L), bu = rel(BUFFER_R, 0);
      check(pu < bu + 1, `booster small-signal 3.7 kHz re 500 Hz: ${pu.toFixed(1)} dB on the pickup, ${bu.toFixed(1)} dB behind a buffer (the DI's resonance is taken out first)`);
    }
    // knobs glide: the guitar tone's tone knob stepped 0 -> 1 under a 0.2 V sine (a rig change) gave a 4.5 V burst
    {
      const v = defaults(); placeModule(v, 0, MODULES.findIndex((m) => m.id === 'gtone'), { tone: 0 });
      const e = new PedalboardEngine(FS); e.loadRig(v); e.snap();
      const n = Math.round(1.5 * FS), x = new Float32Array(n), L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / FS);
      for (let o = 0; o < n; o += BLOCK) { if (o === BLOCK * 375) e.setParam(slotKnobId(0, 0), 1); e.process(x.subarray(o, o + BLOCK), L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK), BLOCK); }
      let pk = 0; for (let i = BLOCK * 375; i < BLOCK * 375 + FS / 50; i++) pk = Math.max(pk, Math.abs(L[i]));
      check(pk < 0.3, `guitar tone stepped 0 -> 10 under a 0.2 V sine: peak ${pk.toFixed(3)} V in the next 20 ms (was 4.5 V)`);
    }
    // reverb decay: the spring reaches its knob (it stopped near 3 s), the hall's T30 at 1 kHz within 5% of its knob (it was 10-15% short)
    {
      const t30 = (fx: (L: Float32Array, R: Float32Array, n: number) => void) => {
        const n = FS * 8, L = new Float32Array(n), R = new Float32Array(n); L[0] = R[0] = 1; for (let o = 0; o < n; o += BLOCK) fx(L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK), BLOCK);
        const bp = new Biquad(); bp.bandpass(FS, 1000, 1.4); const e = new Float64Array(n); for (let i = 0; i < n; i++) { const y = bp.tick(L[i]); e[i] = y * y; }
        for (let i = n - 2; i >= 0; i--) e[i] += e[i + 1];
        const at = (d: number) => { for (let i = 0; i < n; i++) if (10 * Math.log10(e[i] / e[0]) < d) return i / FS; return n / FS; };
        return 2 * (at(-35) - at(-5));
      };
      const sp = new SpringTank(FS), hl = new Hall(FS);
      const s5 = t30((L, R, m) => sp.process(L, R, m, 5, 0.5, 1)), h6 = t30((L, R, m) => hl.process(L, R, m, 0.6, 6, 0.5, 0, 1, 0.3));
      check(s5 > 4.4 && s5 < 5.6 && Math.abs(h6 / 6 - 1) < 0.06, `reverb T30 at 1 kHz: spring at 5 s ${s5.toFixed(2)} s (was 3.0), hall at 6 s ${h6.toFixed(2)} s (was 5.2)`);
    }
  }
  // silence in, silence out (no self-oscillation, no denormal hiss)
  const e = new PedalboardEngine(FS);
  const loud = defaults();
  [5, 6, 9, 11, 13].forEach((m, s) => placeModule(loud, s, m, { gain: 1, fb: 0.9, decay: 10 }));
  e.loadRig(loud);
  const z = new Float32Array(FS * 3), L = new Float32Array(FS * 3), R = new Float32Array(FS * 3);
  e.process(z, L, R, z.length);
  { // cab IR: no IR passes through; a delta IR is unity; a 3-tap IR matches direct convolution
    const x = new Float32Array(300); for (let i = 0; i < 300; i++) x[i] = Math.sin(i * 0.37) * 0.5;
    const a = Float32Array.from(x), c = new CabIR();
    c.process(a, 300, null, 0, 1);
    check(a.every((v, i) => v === x[i]), 'cab IR: no IR passes through');
    const d = prepareIR([1, 0, 0, 0])!, b = Float32Array.from(x);
    c.process(b, 300, d, 0, 1);
    check(b.every((v, i) => Math.abs(v - x[i]) < 1e-6), 'cab IR: a delta IR is unity');
    const h = [0.8, 0.5, -0.3, 0, 0, 0, 0, 0], ir = prepareIR(h)!, y = Float32Array.from(x), c2 = new CabIR();
    c2.process(y.subarray(0, 100), 100, ir, 0, 1); c2.process(y.subarray(100), 200, ir, 0, 1);
    let err = 0;
    for (let i = 0; i < 300; i++) { let s = 0; for (let k = 0; k < ir.length; k++) if (i - k >= 0) s += ir[k] * x[i - k]; err = Math.max(err, Math.abs(s - y[i])); }
    check(err < 1e-5, `cab IR: matches direct convolution across blocks (err ${err.toExponential(1)})`);
  }
  { // 7-band eq and the studio compressor
    const sine = (f: number, a: number, n = 48000) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / 48000); return x; };
    const rms = (x: Float32Array) => { let e = 0; for (let i = x.length >> 1; i < x.length; i++) e += x[i] * x[i]; return Math.sqrt(e / (x.length - (x.length >> 1))); };
    const flat = new Eq7(48000); flat.set(new Float64Array(8)); const a = sine(500, 0.3); const a0 = Float32Array.from(a); flat.process(a, a.length, 0);
    check(a.every((v, i) => Math.abs(v - a0[i]) < 1e-6), 'eq7: flat is unity');
    const up = new Eq7(48000); up.set(Float64Array.from([0, 0, 0, 12, 0, 0, 0, 0])); const b = sine(800, 0.1); up.process(b, b.length, 0);
    const gain = 20 * Math.log10(rms(b) / rms(sine(800, 0.1)));
    check(Math.abs(gain - 12) < 0.3, `eq7: +12 dB at 800 Hz reads ${gain.toFixed(2)} dB`);
    const far = new Eq7(48000); far.set(Float64Array.from([0, 0, 0, 12, 0, 0, 0, 0])); const f = sine(100, 0.1); far.process(f, f.length, 0);
    const leak = 20 * Math.log10(rms(f) / rms(sine(100, 0.1)));
    check(Math.abs(leak) < 1.5, `eq7: a band leaves 100 Hz alone (${leak.toFixed(2)} dB)`);
    const loud = sine(1000, 0.5), c = new StudioComp(48000);
    c.process(loud, loud.length, -26, 4, 0.01, 0.25, 0, 0, 1);
    const drop = 20 * Math.log10(rms(loud) / rms(sine(1000, 0.5)));
    check(Math.abs(drop + 12.75) < 0.6, `compressor: 17 dB over a 4:1 threshold takes off ${(-drop).toFixed(2)} dB (12.75 expected)`);
    const quiet = sine(1000, 0.01), q0 = Float32Array.from(quiet); new StudioComp(48000).process(quiet, quiet.length, -26, 4, 0.01, 0.25, 6, 0, 1);
    check(quiet.every((v, i) => Math.abs(v - q0[i]) < 1e-6), 'compressor: under the threshold it does nothing');
  }
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
