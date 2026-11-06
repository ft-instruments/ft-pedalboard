// AudioWorklet wrapper around the pedalboard: picks the input (the
// interface, the demo guitar or a looped file), runs the engine, and posts
// meters, the tuner and the scope back for the UI.

import { PedalboardEngine } from '../dsp/engine.ts';
import { DemoGuitar } from '../dsp/demo.ts';
import { NSLOTS } from '../dsp/params.ts';

import { SRC_LIVE, SRC_DEMO, SRC_FILE, type WorkletMessage, type WorkletStats } from './protocol.ts';

class PedalboardProcessor extends AudioWorkletProcessor {
  private engine = new PedalboardEngine(sampleRate);
  private demo = new DemoGuitar(sampleRate);
  private kind = SRC_DEMO;
  private channel = 2;
  private file: Float32Array | null = null;
  private filePos = 0;
  private mono = new Float32Array(128);
  private blockCount = 0;
  private busy = 0;
  private samples = 0;
  private peakIn = 0; private peakL = 0; private peakR = 0;
  private slotPeak = new Float32Array(NSLOTS);
  private fresh = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.handle(e.data);
  }

  private handle(m: WorkletMessage): void {
    const e = this.engine;
    switch (m.type) {
      case 'param': e.setParam(m.id, m.value); break;
      case 'params': e.setParams(m.values); break;
      case 'rig':
        e.loadRig(m.values);
        // the first rig after power-on comes in without fades
        if (this.fresh) { e.snap(); this.fresh = false; }
        break;
      case 'source':
        if (m.kind !== this.kind) e.reset();
        this.kind = m.kind;
        if (m.kind === SRC_DEMO) { this.demo.setPattern(m.pattern); }
        break;
      case 'file': this.file = m.data; this.filePos = 0; break;
      case 'channel': this.channel = m.value; break;
      case 'mute': e.muted = m.value; break;
      case 'reset': e.reset(); this.demo.reset(); break;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const L = out[0];
    const R = out[1] ?? out[0];
    const n = L.length;
    if (this.mono.length < n) this.mono = new Float32Array(n);
    const x = this.mono;
    if (this.kind === SRC_LIVE) {
      const inp = inputs[0];
      const a = inp?.[0], b = inp?.[1];
      if (!a) x.fill(0, 0, n);
      else if (this.channel === 0 || !b) for (let i = 0; i < n; i++) x[i] = a[i];
      else if (this.channel === 1) for (let i = 0; i < n; i++) x[i] = b[i];
      else for (let i = 0; i < n; i++) x[i] = (a[i] + b[i]) * 0.5;
    } else if (this.kind === SRC_FILE && this.file && this.file.length > 0) {
      const f = this.file;
      for (let i = 0; i < n; i++) { x[i] = f[this.filePos]; if (++this.filePos >= f.length) this.filePos = 0; }
    } else if (this.kind === SRC_DEMO) {
      this.demo.process(x, n);
    } else {
      x.fill(0, 0, n);
    }
    const t0 = Date.now();
    this.engine.process(x, L, R, n);
    this.busy += Date.now() - t0;
    this.samples += n;
    const e = this.engine;
    if (e.peakIn > this.peakIn) this.peakIn = e.peakIn;
    if (e.peakL > this.peakL) this.peakL = e.peakL;
    if (e.peakR > this.peakR) this.peakR = e.peakR;
    for (let s = 0; s < NSLOTS; s++) if (e.slotPeak[s] > this.slotPeak[s]) this.slotPeak[s] = e.slotPeak[s];
    if (++this.blockCount % 8 === 0) {
      const period = (this.samples / sampleRate) * 1000;
      const msg: WorkletStats = {
        type: 'stats',
        load: this.busy / period,
        peakIn: this.peakIn, peakL: this.peakL, peakR: this.peakR,
        slotPeak: this.slotPeak.slice(),
        slotHeat: e.slotHeat.slice(),
        slotLive: e.slotLive.slice(),
        stageHeat: e.stageHeat.slice(),
        tunerHz: e.tuner.freq,
        tunerClarity: e.tuner.clarity,
        scope: e.scope.slice(),
      };
      this.port.postMessage(msg, [msg.scope.buffer, msg.slotPeak.buffer, msg.slotHeat.buffer, msg.slotLive.buffer, msg.stageHeat.buffer]);
      this.busy = 0; this.samples = 0; this.peakIn = this.peakL = this.peakR = 0;
      this.slotPeak.fill(0);
    }
    return true;
  }
}

registerProcessor('ft-pedalboard', PedalboardProcessor);
