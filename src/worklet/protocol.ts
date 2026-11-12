// Messages between the page and the worklet. Kept apart from processor.ts so
// the page can import them without pulling the worklet class into its bundle.

export const SRC_LIVE = 0, SRC_DEMO = 1, SRC_FILE = 2;

export type WorkletMessage =
  | { type: 'param'; id: string; value: number }
  | { type: 'params'; values: Record<string, number> }
  | { type: 'rig'; values: Record<string, number> }
  | { type: 'source'; kind: number; pattern: number }
  | { type: 'file'; data: Float32Array }
  | { type: 'ir'; data: Float32Array | null }
  | { type: 'channel'; value: number }      // 0 left / input 1, 1 right / input 2, 2 both
  | { type: 'mute'; value: boolean }
  | { type: 'reset' };

/** Per-slot meters, NSLOTS long (stageHeat: STAGE_STRIDE per slot). */

export interface WorkletStats {
  type: 'stats';
  load: number;          // fraction of the block period spent in process()
  peakIn: number;        // volts at the rack's input
  peakRaw: number;       // the input samples, 1 = digital full scale (clipping)
  peakL: number;
  peakR: number;
  slotPeak: Float32Array;
  slotHeat: Float32Array;
  slotLive: Float32Array;
  stageHeat: Float32Array;
  tunerHz: number;
  tunerClarity: number;
  scope: Float32Array;
}
