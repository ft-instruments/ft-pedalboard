// The rack: input gain and tuner, then NSLOTS slots in order, then the
// volume. Each slot owns one instance of every module (two of the mono ones,
// for after the signal has gone stereo), built up front, so putting a
// different module in a slot never allocates.
//
// Switching a unit on or off crossfades it with its own input over 15 ms
// (true bypass). Swapping one module for another dips the slot's output to
// silence and back instead (15 ms each way): crossfading through the dry
// signal would let a maxed fuzz skip the amp for a moment. A slot that was
// bypassed or empty switches at once.
//
// The signal is mono until the first stereo module; mono modules after it
// run their second instance on the right. No allocation after
// construction, no browser APIs.

import {
  PARAMS, NPARAMS, PARAM_INDEX, MODULES, NSLOTS, NMODULES, MAX_KNOBS, SLOT_BASE, SLOT_STRIDE, P_INGAIN, P_HEAT, P_VOLUME,
  M_NONE, M_GATE, M_COMP, M_GLOW, M_RASP, M_FUZZ, M_AMP, M_EQ, M_CHORUS, M_PHASER, M_TREM, M_ECHO, M_SPRING, M_HALL, M_MUFF, M_BOOST, M_AMP2, M_FLANGER, M_TRANSPARENT, M_METAL, M_AMP3, M_PLATE, M_ROOM, M_WAH, M_VIBE, M_ROTARY, M_OCTAVE, M_AMP4, M_GTONE, M_SDELAY, M_AMP_FIRST, isAmp, driveKind, AMP_VOICING_BASE,
  fromNorm, type ParamValues,
} from './params.ts';
import { dbToGain, Smooth } from './util.ts';
import { Gate } from './gate.ts';
import { Comp } from './comp.ts';
import { Drive } from './drive.ts';
import { Amp, MAX_STAGES } from './amp.ts';
import { Cab, CabCut } from './cab.ts';
import { Eq } from './eq.ts';
import { Wah } from './wah.ts';
import { GuitarTone } from './gtone.ts';
import { Chorus, Phaser, Tremolo, Flanger, Vibe, Rotary } from './mod.ts';
import { TapeEcho, StereoDelay } from './delay.ts';
import { SpringTank } from './spring.ts';
import { Hall } from './reverb.ts';
import { Tuner } from './tuner.ts';

const MAX_BLOCK = 512;
const SCOPE = 512;
const FADE_S = 0.015;
/** Per slot in `stageHeat`: the preamp stages, then the power stage. */
export const STAGE_STRIDE = MAX_STAGES + 1;

function copy(from: Float32Array, to: Float32Array, n: number): void { for (let i = 0; i < n; i++) to[i] = from[i]; }

class Slot {
  /** The module running now (it lags the `type` parameter while a swap fades). */
  type = M_NONE;
  /** 0 = bypassed, 1 = in. */
  fade = 0;
  /** The slot's output level: dips to 0 while one module is swapped for another. */
  level = 1;
  /** The running module's knobs in real units. */
  real = new Float64Array(MAX_KNOBS);
  gate: Gate[]; comp: Comp[]; drive: Drive[]; amp: Amp[]; cab: Cab[]; cut: CabCut[]; eq: Eq[]; wah: Wah[]; vibe: Vibe[]; gtone: GuitarTone[];
  chorus: Chorus; phaser: Phaser; flanger: Flanger; rotary: Rotary; trem: Tremolo; echo: TapeEcho; sdelay: StereoDelay; spring: SpringTank; hall: Hall;

  constructor(fs: number) {
    this.gate = [new Gate(fs), new Gate(fs)];
    this.comp = [new Comp(fs), new Comp(fs)];
    this.drive = [new Drive(fs), new Drive(fs)];
    this.amp = [new Amp(fs), new Amp(fs)];
    this.cab = [new Cab(fs), new Cab(fs)];
    this.cut = [new CabCut(fs), new CabCut(fs)];
    this.eq = [new Eq(fs), new Eq(fs)];
    this.wah = [new Wah(fs), new Wah(fs)];
    this.vibe = [new Vibe(fs), new Vibe(fs)];
    this.gtone = [new GuitarTone(fs), new GuitarTone(fs)];
    this.rotary = new Rotary(fs);
    this.chorus = new Chorus(fs);
    this.phaser = new Phaser(fs);
    this.flanger = new Flanger(fs);
    this.trem = new Tremolo(fs);
    this.echo = new TapeEcho(fs);
    this.sdelay = new StereoDelay(fs);
    this.spring = new SpringTank(fs);
    this.hall = new Hall(fs);
  }

  /** Clear the state of the module now in the slot. */
  reset(): void {
    for (let c = 0; c < 2; c++) {
      if (isAmp(this.type)) { this.amp[c].reset(); this.cab[c].reset(); this.cut[c].reset(); continue; }
      switch (this.type) {
        case M_GATE: this.gate[c].reset(); break;
        case M_COMP: this.comp[c].reset(); break;
        case M_GLOW: case M_RASP: case M_FUZZ: case M_MUFF: case M_BOOST: case M_TRANSPARENT: case M_METAL: case M_OCTAVE: this.drive[c].reset(); break;
        case M_WAH: this.wah[c].reset(); break;
        case M_VIBE: this.vibe[c].reset(); break;
        case M_GTONE: this.gtone[c].reset(); break;
        case M_EQ: this.eq[c].reset(); break;
      }
    }
    switch (this.type) {
      case M_CHORUS: this.chorus.reset(); break;
      case M_PHASER: this.phaser.reset(); break;
      case M_FLANGER: this.flanger.reset(); break;
      case M_ROTARY: this.rotary.reset(); break;
      case M_ECHO: this.echo.reset(); break;
      case M_SDELAY: this.sdelay.reset(); break;
      case M_SPRING: this.spring.reset(); break;
      case M_HALL: case M_PLATE: case M_ROOM: this.hall.clear(); break;
    }
  }

  resetAll(): void {
    for (let c = 0; c < 2; c++) {
      this.gate[c].reset(); this.comp[c].reset(); this.drive[c].reset(); this.amp[c].reset(); this.cab[c].reset(); this.cut[c].reset(); this.eq[c].reset(); this.wah[c].reset(); this.vibe[c].reset(); this.gtone[c].reset();
    }
    this.chorus.reset(); this.phaser.reset(); this.flanger.reset(); this.rotary.reset(); this.echo.reset(); this.sdelay.reset(); this.spring.reset(); this.hall.clear();
  }
}

export class PedalboardEngine {
  readonly fs: number;
  /** Every parameter, by index into PARAMS. */
  readonly values = new Float64Array(NPARAMS);
  private slots: Slot[] = [];
  readonly tuner: Tuner;
  private dryL = new Float32Array(MAX_BLOCK); private dryR = new Float32Array(MAX_BLOCK);
  private inBuf = new Float32Array(MAX_BLOCK);
  private inGain: Smooth; private outGain: Smooth;
  private scopeIdx = 0;
  /** Mute the output (tuning). */
  muted = false;

  // ---- meters, read by the UI after each process()
  peakIn = 0; peakL = 0; peakR = 0;
  /** Peak level leaving each slot. */
  slotPeak = new Float32Array(NSLOTS);
  /** 0..1 per slot: how hard its module is working (gain reduction, clipping, tail level). */
  slotHeat = new Float32Array(NSLOTS);
  /** One number per slot for its picture: the gate's and drive's input level, the compressor's
   *  gain reduction (dB), the amp's sag, a modulation LFO's phase, a delay or spring's level. */
  slotLive = new Float32Array(NSLOTS);
  /** The amps' tubes: STAGE_STRIDE per slot. */
  stageHeat = new Float32Array(NSLOTS * STAGE_STRIDE);
  scope = new Float32Array(SCOPE);

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    for (let s = 0; s < NSLOTS; s++) this.slots.push(new Slot(sampleRate));
    this.tuner = new Tuner(sampleRate);
    for (let i = 0; i < NPARAMS; i++) this.values[i] = PARAMS[i].def;
    this.inGain = new Smooth(dbToGain(this.values[P_INGAIN]), sampleRate, 20);
    this.outGain = new Smooth(this.volumeGain(), sampleRate, 20);
  }

  private volumeGain(): number { const v = this.values[P_VOLUME]; return v * v * 2; }

  setParamIndex(i: number, value: number): void {
    if (i < 0 || i >= NPARAMS || !Number.isFinite(value)) return;
    const p = PARAMS[i];
    this.values[i] = value < p.min ? p.min : value > p.max ? p.max : value;
  }

  setParam(id: string, value: number): void {
    const i = PARAM_INDEX[id];
    if (i !== undefined) this.setParamIndex(i, value);
  }

  setParams(values: Partial<ParamValues>): void {
    for (const k in values) this.setParam(k, values[k] as number);
  }

  /** A rig: the defaults plus `values`; the volume stays where it is. */
  loadRig(values: Partial<ParamValues>): void {
    for (let i = 0; i < NPARAMS; i++) if (i !== P_VOLUME) this.values[i] = PARAMS[i].def;
    this.setParams(values);
  }

  /** Clear every tail and filter state (after a dropout, or between offline renders). */
  reset(): void { for (const s of this.slots) s.resetAll(); }

  /** Put every slot straight into its settled state (no fades): for a fresh start and offline renders. */
  snap(): void {
    for (let s = 0; s < NSLOTS; s++) {
      const slot = this.slots[s];
      const base = SLOT_BASE + s * SLOT_STRIDE;
      let want = Math.round(this.values[base]);
      if (want < 0 || want >= NMODULES) want = M_NONE;
      if (want !== slot.type) { slot.type = want; slot.reset(); }
      slot.fade = want !== M_NONE && this.values[base + 1] >= 0.5 ? 1 : 0;
      slot.level = 1;
    }
    this.inGain.jump(dbToGain(this.values[P_INGAIN]));
    this.outGain.jump(this.muted ? 0 : this.volumeGain());
  }

  /** `input` mono (volts), into stereo L/R. Any n. */
  process(input: Float32Array, L: Float32Array, R: Float32Array, n: number): void {
    if (n <= MAX_BLOCK) { this.run(input, L, R, n); return; }
    // offline renders only: subarray() allocates a view
    for (let off = 0; off < n; off += MAX_BLOCK) {
      const m = Math.min(MAX_BLOCK, n - off);
      this.run(input.subarray(off, off + m), L.subarray(off, off + m), R.subarray(off, off + m), m);
    }
  }

  private run(input: Float32Array, L: Float32Array, R: Float32Array, n: number): void {
    const vals = this.values;
    this.inGain.set(dbToGain(vals[P_INGAIN]));
    let peakIn = 0;
    const x = this.inBuf;
    for (let i = 0; i < n; i++) {
      const v = input[i] * this.inGain.tick();
      x[i] = v; L[i] = v;
      const a = Math.abs(v); if (a > peakIn) peakIn = a;
    }
    this.peakIn = peakIn;
    this.tuner.push(x, n);

    const heatMul = Math.pow(2, (vals[P_HEAT] - 0.5) * 4);   // ±12 dB into the drives and the amps
    let stereo = false;
    const fadeStep = n / (FADE_S * this.fs);
    for (let s = 0; s < NSLOTS; s++) {
      const slot = this.slots[s];
      const base = SLOT_BASE + s * SLOT_STRIDE;
      let want = Math.round(vals[base]);
      if (want < 0 || want >= NMODULES) want = M_NONE;
      const on = vals[base + 1] >= 0.5;
      if (want !== slot.type) {
        // bypassed or empty: switch now. Audible: fade to dry if the slot is being emptied, else dip to silence first
        if (slot.fade <= 0 || slot.level <= 0) {
          const dipped = slot.level <= 0;
          slot.type = want; slot.reset();
          if (dipped) slot.fade = on && want !== M_NONE ? 1 : 0;
        }
      }
      const settled = want === slot.type;
      const type = slot.type;
      if (settled) {
        // knobs follow their parameters; while a swap is pending they stay where the old module had them
        const knobs = MODULES[type].knobs;
        for (let k = 0; k < knobs.length; k++) slot.real[k] = fromNorm(knobs[k], vals[base + 2 + k]);
      }
      const dip = !settled && want !== M_NONE;
      const fadeIn = settled ? on && type !== M_NONE : dip;     // a dipping module stays in until it is silent
      const f0 = slot.fade;
      const f1 = fadeIn ? Math.min(1, f0 + fadeStep) : Math.max(0, f0 - fadeStep);
      slot.fade = f1;
      const l0 = slot.level;
      const l1 = dip ? Math.max(0, l0 - fadeStep) : Math.min(1, l0 + fadeStep);
      slot.level = l1;
      if (f0 === 0 && f1 === 0) {
        this.slotHeat[s] *= 0.9;
      } else {
        if (MODULES[type].stereo && !stereo) { copy(L, R, n); stereo = true; }
        const crossfade = f0 < 1 || f1 < 1;
        if (crossfade) { copy(L, this.dryL, n); if (stereo) copy(R, this.dryR, n); }
        this.module(s, slot, L, R, n, stereo, heatMul);
        if (crossfade) {
          const dl = this.dryL, dr = this.dryR;
          for (let i = 0; i < n; i++) {
            const g = f0 + (f1 - f0) * (i / n);
            L[i] = dl[i] + (L[i] - dl[i]) * g;
            if (stereo) R[i] = dr[i] + (R[i] - dr[i]) * g;
          }
        }
      }
      if (l0 < 1 || l1 < 1) {
        for (let i = 0; i < n; i++) {
          const g = l0 + (l1 - l0) * (i / n);
          L[i] *= g;
          if (stereo) R[i] *= g;
        }
      }
      let pk = 0;
      for (let i = 0; i < n; i++) { const a = Math.abs(L[i]); if (a > pk) pk = a; }
      this.slotPeak[s] = pk;
    }
    if (!stereo) copy(L, R, n);

    // volume, meters, scope
    this.outGain.set(this.muted ? 0 : this.volumeGain());
    let pl = 0, pr = 0;
    const scope = this.scope;
    let si = this.scopeIdx;
    for (let i = 0; i < n; i++) {
      const g = this.outGain.tick();
      let l = L[i] * g, r = R[i] * g;
      if (!(l === l) || !(r === r)) { l = 0; r = 0; }   // never pass a NaN to the speakers
      L[i] = l; R[i] = r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pl) pl = al; if (ar > pr) pr = ar;
      scope[si] = (l + r) * 0.5; si = (si + 1) % SCOPE;
    }
    this.scopeIdx = si;
    this.peakL = pl; this.peakR = pr;
  }

  private module(s: number, slot: Slot, L: Float32Array, R: Float32Array, n: number, stereo: boolean, heatMul: number): void {
    const r = slot.real;
    const chans = stereo ? 2 : 1;
    let heat = 0, live = 0;
    if (isAmp(slot.type)) {
      // the older amps have a channel knob in front (knob 0); the named ones don't
      const legacy = slot.type < M_AMP_FIRST, o = legacy ? 1 : 0;
      const voicing = legacy ? AMP_VOICING_BASE[slot.type] + Math.round(r[0]) : slot.type - M_AMP_FIRST;
      const cab = Math.round(r[o + 7]);
      for (let c = 0; c < chans; c++) {
        const x = c ? R : L;
        slot.amp[c].process(x, n, voicing, r[o], r[o + 1], r[o + 2], r[o + 3], r[o + 4], r[o + 5], r[o + 6], heatMul);
        if (cab > 0) slot.cab[c].process(x, n, cab - 1, r[o + 8]);
        if (!legacy) slot.cut[c].process(x, n, r[9], r[10]);   // the named amps: low cut, high cut
      }
      const sh = slot.amp[0].stageHeat;
      let h = 0;
      for (let k = 0; k < STAGE_STRIDE; k++) { this.stageHeat[s * STAGE_STRIDE + k] = sh[k]; if (sh[k] > h) h = sh[k]; }
      this.slotHeat[s] = Math.min(1, Math.log2(1 + h) / 6);
      this.slotLive[s] = slot.amp[0].sagDepth;
      return;
    }
    switch (slot.type) {
      case M_GTONE:
        for (let c = 0; c < chans; c++) slot.gtone[c].process(c ? R : L, n, r[0], r[1]);
        break;
      case M_GATE:
        for (let c = 0; c < chans; c++) slot.gate[c].process(c ? R : L, n, r[0], r[1]);
        heat = slot.gate[0].reduction; live = slot.gate[0].level;
        break;
      case M_COMP:
        for (let c = 0; c < chans; c++) slot.comp[c].process(c ? R : L, n, r[0], r[1], r[2], r[3], r[4]);
        live = slot.comp[0].reduction; heat = Math.min(1, live / 18);
        break;
      case M_GLOW: case M_RASP: case M_FUZZ: case M_MUFF: case M_BOOST: case M_TRANSPARENT: case M_METAL: case M_OCTAVE: {
        const pre = Math.sqrt(heatMul);
        for (let c = 0; c < chans; c++) {
          const x = c ? R : L;
          for (let i = 0; i < n; i++) x[i] *= pre;
          slot.drive[c].process(x, n, driveKind(slot.type), r[0], r[1], r[2]);
        }
        heat = Math.min(1, Math.log2(1 + slot.drive[0].push) / 5); live = slot.drive[0].peakIn;
        break;
      }
      case M_EQ:
        for (let c = 0; c < chans; c++) {
          slot.eq[c].set(r[0], r[1], r[2], r[3], r[4]);
          slot.eq[c].process(c ? R : L, n, r[5]);
        }
        break;
      case M_CHORUS:
        slot.chorus.process(L, R, n, r[0], r[1], r[2], r[3]);
        live = slot.chorus.phase; heat = r[3] * r[1];
        break;
      case M_PHASER:
        slot.phaser.process(L, R, n, r[0], r[1], r[2], Math.round(r[3]), r[4], r[5]);
        live = slot.phaser.phase; heat = r[5] * r[1];
        break;
      case M_FLANGER:
        slot.flanger.process(L, R, n, r[0], r[1], r[2], r[3], r[4]);
        live = slot.flanger.phase; heat = r[4] * r[1];
        break;
      case M_TREM:
        slot.trem.process(L, R, n, stereo, r[0], r[1], r[2]);
        live = slot.trem.phase; heat = r[1];
        break;
      case M_ECHO:
        slot.echo.process(L, R, n, r[0], r[1], r[2], r[3], r[4], r[5] >= 0.5);
        live = slot.echo.level; heat = Math.min(1, live * 2);
        break;
      case M_SDELAY:
        slot.sdelay.process(L, R, n, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]);
        live = slot.sdelay.level; heat = Math.min(1, live * 2);
        break;
      case M_SPRING:
        slot.spring.process(L, R, n, r[0], r[1], r[2]);
        live = slot.spring.level; heat = Math.min(1, live * 3);
        break;
      case M_HALL:
        slot.hall.process(L, R, n, r[1], r[0], r[2], r[3], r[4]);
        heat = r[4];
        break;
      case M_PLATE:
        slot.hall.process(L, R, n, 0.02, r[0], r[1], 0, r[2]);
        heat = r[2];
        break;
      case M_ROOM:
        slot.hall.process(L, R, n, r[0] * 0.3, r[1], r[2], 0, r[3]);
        heat = r[3];
        break;
      case M_VIBE:
        for (let c = 0; c < chans; c++) slot.vibe[c].process(c ? R : L, n, r[0], r[1], r[2]);
        live = slot.vibe[0].phase; heat = r[1];
        break;
      case M_ROTARY:
        slot.rotary.process(L, R, n, r[0], r[1], r[2]);
        live = slot.rotary.phase; heat = r[1] * r[2];
        break;
      case M_WAH:
        for (let c = 0; c < chans; c++) slot.wah[c].process(c ? R : L, n, r[0], r[1], r[2], r[3]);
        live = slot.wah[0].pos; heat = r[1];
        break;
    }
    this.slotHeat[s] = heat;
    this.slotLive[s] = live;
  }
}
