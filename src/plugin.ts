// The UI's handle on the rack when the page runs inside the plugin's WebView
// instead of a browser tab. Same surface as Board (audio.ts), but every call
// goes to the C++ side (plugin/Source/PluginEditor.cpp) over JUCE's event
// bridge, and parameter changes become host parameters. The host owns the
// audio: the input is the track's audio (or the demo guitar), and there is
// no power switch.

import { SRC_LIVE, type WorkletStats } from './worklet/protocol.ts';
import type { ParamValues } from './dsp/params.ts';
import type { InputDevice } from './audio.ts';

interface JuceBackend {
  emitEvent(id: string, payload: unknown): void;
  addEventListener(id: string, fn: (payload: unknown) => void): unknown;
}

const CHANNEL = 'pedalboard';

const backend = (): JuceBackend | undefined =>
  (window as unknown as { __JUCE__?: { backend?: JuceBackend } }).__JUCE__?.backend;

/** True when the page is the plugin's editor. */
export const inPlugin = (): boolean => backend() !== undefined;

export interface StoredRig { name: string; values: Partial<ParamValues> }

/** Everything the page needs when it opens (or when the host swaps the rig under it). */
export interface PluginState {
  values: ParamValues;
  preset: string;
  user: StoredRig[];
  source: string;
  channel: number;
  muted: boolean;
}

type FromPlugin =
  | { type: 'state'; values: ParamValues; preset: string; user: unknown; source: string; channel: number; muted: boolean }
  | { type: 'params'; values: Partial<ParamValues> }
  | { type: 'stats'; load: number; peakIn: number; peakL: number; peakR: number; tunerHz: number; tunerClarity: number;
      slotPeak: number[]; slotHeat: number[]; slotLive: number[]; stageHeat: number[] };

export class PluginBoard {
  public onStats: ((s: WorkletStats) => void) | null = null;
  public onState: ((s: PluginState) => void) | null = null;
  /** Parameters the host moved (automation, its own editor). */
  public onParams: ((values: Partial<ParamValues>) => void) | null = null;

  constructor() {
    backend()!.addEventListener(CHANNEL, (m) => this.receive(m as FromPlugin));
  }

  /** The host owns the audio device: the rack is always on. */
  get running(): boolean { return true; }
  get sampleRate(): number { return 48000; }
  async start(): Promise<void> { /* nothing to wake */ }
  async suspend(): Promise<void> { /* the host decides */ }
  get latencyMs(): number { return 0; }

  /** Ask for the current state; the answer arrives through onState. */
  ready(): void { this.send({ type: 'ready' }); }

  setParam(id: string, value: number): void { this.send({ type: 'param', id, value }); }
  /** Several at once (a rearranged rack): one message, so the host sees them together. */
  setParams(values: Record<string, number>): void { if (Object.keys(values).length) this.send({ type: 'params', values }); }
  /** A whole rig; everything it leaves out goes to its default. */
  loadRig(values: Record<string, number>, name = ''): void { this.send({ type: 'rig', values, name }); }
  setSource(kind: number, pattern = 0): void { this.send({ type: 'source', kind: kind === SRC_LIVE ? 0 : 1, pattern }); }
  setChannel(value: number): void { this.send({ type: 'channel', value }); }
  mute(value: boolean): void { this.send({ type: 'mute', value }); }

  /** The rig the header shows ('' once it is edited), kept with the session. */
  setCurrent(name: string): void { this.send({ type: 'current', name }); }
  /** Your rigs live in a file next to the plugin's other settings, shared by every instance. */
  saveUser(rigs: StoredRig[]): void { this.send({ type: 'saveUser', rigs }); }

  // the host's track is the input: no devices, files or permissions here
  async openInput(_deviceId?: string | null): Promise<string> { return 'host input'; }
  closeInput(): void { /* nothing to close */ }
  async inputDevices(): Promise<InputDevice[]> { return []; }
  async loadFile(_file?: File): Promise<number> { throw new Error('files play in the browser version only'); }

  private send(payload: Record<string, unknown>): void { backend()?.emitEvent(CHANNEL, payload); }

  private receive(m: FromPlugin): void {
    switch (m.type) {
      case 'state': {
        const user = Array.isArray(m.user)
          ? (m.user as StoredRig[]).filter((r) => typeof r?.name === 'string' && r.values && typeof r.values === 'object')
          : [];
        this.onState?.({ values: m.values, preset: m.preset, user, source: m.source, channel: m.channel, muted: m.muted });
        break;
      }
      case 'params': this.onParams?.(m.values); break;
      case 'stats':
        this.onStats?.({
          type: 'stats', load: m.load, peakIn: m.peakIn, peakL: m.peakL, peakR: m.peakR,
          tunerHz: m.tunerHz, tunerClarity: m.tunerClarity,
          slotPeak: Float32Array.from(m.slotPeak), slotHeat: Float32Array.from(m.slotHeat),
          slotLive: Float32Array.from(m.slotLive), stageHeat: Float32Array.from(m.stageHeat),
          scope: new Float32Array(0),
        });
        break;
    }
  }
}
