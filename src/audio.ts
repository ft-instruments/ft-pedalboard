// Main-thread handle on the AudioWorklet pedalboard and its input: the
// audio interface (getUserMedia with every voice-call "enhancement" off),
// the built-in demo guitar, or a file you drop in.

import workletUrl from './worklet/processor.ts?worker&url';
import { SRC_LIVE, SRC_DEMO, SRC_FILE, type WorkletMessage, type WorkletStats } from './worklet/protocol.ts';

export { SRC_LIVE, SRC_DEMO, SRC_FILE };

export interface InputDevice { id: string; label: string }

export class Board {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private inputLatency = 0;
  public onStats: ((s: WorkletStats) => void) | null = null;

  get running(): boolean { return this.ctx?.state === 'running'; }
  get sampleRate(): number { return this.ctx?.sampleRate ?? 48000; }

  async start(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      await this.ctx.audioWorklet.addModule(workletUrl);
      this.node = new AudioWorkletNode(this.ctx, 'ft-pedalboard', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
        outputChannelCount: [2],
      });
      this.node.port.onmessage = (e: MessageEvent<WorkletStats>) => { if (e.data?.type === 'stats') this.onStats?.(e.data); };
      this.node.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx?.state === 'running') await this.ctx.suspend();
  }

  /** Round trip as far as the browser reports it, ms. */
  get latencyMs(): number {
    if (!this.ctx) return 0;
    return (this.ctx.baseLatency + (this.ctx.outputLatency || 0) + this.inputLatency) * 1000;
  }

  /** Open the interface input (asks for permission the first time). */
  async openInput(deviceId: string | null): Promise<string> {
    if (!this.ctx || !this.node) throw new Error('start the board first');
    this.closeInput();
    const audio: MediaTrackConstraints & { latency?: number } = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: { ideal: 2 }, latency: 0, sampleRate: 48000,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    const track = this.stream.getAudioTracks()[0];
    const settings = track.getSettings() as MediaTrackSettings & { latency?: number };
    this.inputLatency = settings.latency ?? 0;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
    return track.label;
  }

  closeInput(): void {
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null; this.stream = null; this.inputLatency = 0;
  }

  async inputDevices(): Promise<InputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `input ${i + 1}` }));
  }

  /** Decode an audio file to mono at the context's rate and loop it. */
  async loadFile(file: File): Promise<number> {
    if (!this.ctx) throw new Error('start the board first');
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    this.send({ type: 'file', data: mono }, [mono.buffer]);
    return buf.duration;
  }

  /** Decode a WAV as the cab IR units' impulse response (mono, at the context's rate); returns its length in ms. */
  async loadIR(file: File): Promise<number> {
    if (!this.ctx) throw new Error('start the board first');
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    this.send({ type: 'ir', data: mono }, [mono.buffer]);
    return buf.duration * 1000;
  }

  private send(m: WorkletMessage, transfer: Transferable[] = []): void { this.node?.port.postMessage(m, transfer); }

  setParam(id: string, value: number): void { this.send({ type: 'param', id, value }); }
  setParams(values: Record<string, number>): void { this.send({ type: 'params', values }); }
  loadRig(values: Record<string, number>): void { this.send({ type: 'rig', values }); }
  setSource(kind: number, pattern = 0): void { this.send({ type: 'source', kind, pattern }); }
  setChannel(value: number): void { this.send({ type: 'channel', value }); }
  mute(value: boolean): void { this.send({ type: 'mute', value }); }
}
