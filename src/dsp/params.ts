// The rack: what can go in it (the module library), the flat parameter list
// a plugin host sees, and the factory rigs.
//
// The rack has NSLOTS slots. Each slot is three kinds of parameter: which
// module it holds (`s3type`), whether it is switched on (`s3on`), and
// MAX_KNOBS generic knobs (`s3k1`..`s3k12`), stored 0..1. What a knob means
// depends on the module in the slot: the module's knob list maps 0..1 to its
// real range ("gain" on a drive, "rate" on a chorus). The list never
// changes, so a host can automate any slot whatever is in it. The chain runs
// in slot order: moving a unit moves its parameters to another slot.

export type Scale = 'lin' | 'log' | 'int' | 'enum' | 'bool';

export interface ParamDef {
  id: string;
  name: string;
  group: string;
  min: number;
  max: number;
  def: number;
  scale: Scale;
  unit?: string;
  labels?: string[];   // for enum
}

const P = (id: string, name: string, group: string, min: number, max: number, def: number, scale: Scale = 'lin', unit?: string, labels?: string[]): ParamDef =>
  ({ id, name, group, min, max, def, scale, unit, labels });

// ---- the module library ----------------------------------------------------

export const NSLOTS = 16;
export const MAX_KNOBS = 12;

export const M_NONE = 0, M_GATE = 1, M_COMP = 2, M_GLOW = 3, M_RASP = 4, M_FUZZ = 5, M_AMP = 6, M_EQ = 7,
  M_CHORUS = 8, M_PHASER = 9, M_TREM = 10, M_ECHO = 11, M_SPRING = 12, M_HALL = 13,
  M_MUFF = 14, M_BOOST = 15, M_AMP2 = 16, M_FLANGER = 17, M_TRANSPARENT = 18, M_METAL = 19, M_AMP3 = 20, M_PLATE = 21, M_ROOM = 22, M_WAH = 23,
  M_VIBE = 24, M_ROTARY = 25, M_OCTAVE = 26, M_AMP4 = 27, M_GTONE = 28;
/** The amps as units of their own, one per voicing (the voicing index is the module's offset from M_AMP_FIRST). */
export const M_AMP_FIRST = 29, M_AMP_LAST = 42;
export const M_SDELAY = 43;
export const NMODULES = 44;
/** Any amp unit: the four older ones (with a channel knob, hidden from the library) and the fourteen named ones. */
export const isAmp = (m: number): boolean => m === M_AMP || m === M_AMP2 || m === M_AMP3 || m === M_AMP4 || (m >= M_AMP_FIRST && m <= M_AMP_LAST);

/** Which circuit of the drive pedal a module runs (0 glow, 1 rasp, 2 fuzz, 3 muff, 4 boost, 5 transparent, 6 metal), or -1 if it isn't a drive. */
export const driveKind = (m: number): number =>
  m >= M_GLOW && m <= M_FUZZ ? m - M_GLOW : m === M_MUFF ? 3 : m === M_BOOST ? 4 : m === M_TRANSPARENT ? 5 : m === M_METAL ? 6 : m === M_OCTAVE ? 7 : -1;
/** The amps' channels index one voicing table: `amp` 0..3, `amp2` from 4, `amp3` from 7. */
export const AMP_VOICING_BASE = { [M_AMP]: 0, [M_AMP2]: 4, [M_AMP3]: 7, [M_AMP4]: 10 } as Record<number, number>;

export interface ModuleDef {
  id: string;          // stable, used in rigs and saved files
  name: string;        // on the faceplate
  cat: string;         // library category
  blurb: string;       // one line under the name
  accent: string;
  /** Makes the signal stereo: everything after it runs on two channels. */
  stereo: boolean;
  knobs: ParamDef[];   // in slot knob order; `group` is the module id
  /** Kept so saved rigs still load, but not offered in the library. */
  hidden?: boolean;
}

export const AMP_CHANNELS = ['clean', 'crunch', 'lead', 'chime'];
export const CAB_TYPES = ['off', '1x12 open', '2x12', '4x12', '2x12 blue'];
export const AMP2_CHANNELS = ['tweed', 'hi-watt', 'boutique'];
export const AMP3_CHANNELS = ['brit 800', 'rectified', 'modern'];
export const AMP4_CHANNELS = ['blackface', 'champ', 'orange', 'brown'];
export const CAB2_TYPES = [...CAB_TYPES, '4x12 greenback', '1x12 tweed'];
export const CAB3_TYPES = [...CAB2_TYPES, '4x12 v30'];
export const CAB4_TYPES = [...CAB3_TYPES, '4x10 blackface', '1x8 small'];
export const VIBE_MODES = ['chorus', 'vibrato'];
export const PHASER_STAGES = ['4', '6', '8'];

const K = (m: string, id: string, name: string, min: number, max: number, def: number, scale: Scale = 'lin', unit?: string, labels?: string[]) =>
  P(id, name, m, min, max, def, scale, unit, labels);
const drive = (id: string, name: string, blurb: string, accent: string, gain = 'gain', tone = 'tone'): ModuleDef => ({
  id, name, cat: 'drive', blurb, accent, stereo: false,
  knobs: [K(id, 'gain', gain, 0, 1, 0.5), K(id, 'tone', tone, 0, 1, 0.5), K(id, 'level', 'level', -24, 12, 0, 'lin', 'dB')],
});


/** The amps, one unit each. Index = voicing in amp.ts. `cab` is the default cabinet (index into CAB4_TYPES). */
const AMP_MODELS: { id: string; name: string; blurb: string; accent: string; cab: number; gain?: number }[] = [
  { id: 'amp_clean', name: 'clean stack', blurb: 'lots of headroom and a scooped middle: a big, clear American stack', accent: '#9cc3dd', cab: 2 },
  { id: 'amp_plexi', name: 'plexi', blurb: 'a cranked 100-watt British stack: crunch with the pick attack intact', accent: '#ffb04a', cab: 3 },
  { id: 'amp_hot', name: 'hot plexi', blurb: 'the same stack with a fourth gain stage: lead and sustain', accent: '#ff7a45', cab: 3 },
  { id: 'amp_chime', name: 'chime combo', blurb: 'class A British combo: jangle, early breakup, top boost', accent: '#ffe08a', cab: 4 },
  { id: 'amp_tweed', name: 'tweed combo', blurb: 'a 1950s tweed: warm, soft, compresses as it breaks up', accent: '#d8b48a', cab: 6 },
  { id: 'amp_hiwatt', name: 'hi-watt', blurb: 'tight, bright and clean for a long way: pedals drive it', accent: '#ffd27a', cab: 3 },
  { id: 'amp_boutique', name: 'boutique combo', blurb: 'smooth three-stage overdrive with vocal mids, breaks up gradually', accent: '#f0b0ff', cab: 5 },
  { id: 'amp_brit800', name: 'brit 800', blurb: 'tight eighties British crunch: more gain on tap, a firm low end', accent: '#ff9a3a', cab: 3 },
  { id: 'amp_rectified', name: 'rectified', blurb: 'four stages, scooped and saggy: a big modern American high-gain', accent: '#ff5a5a', cab: 3 },
  { id: 'amp_modern', name: 'modern high-gain', blurb: 'four tight stages with bite in the upper mids', accent: '#ff4d8a', cab: 7 },
  { id: 'amp_blackface', name: 'blackface combo', blurb: 'huge headroom and glassy sparkle: it stays clean, pedals do the rest', accent: '#8ad0ff', cab: 8 },
  { id: 'amp_champ', name: 'tweed champ', blurb: 'five watts, one small speaker: it breaks up on the first note', accent: '#e8c880', cab: 9 },
  { id: 'amp_orange', name: 'orange stack', blurb: 'fat, thick low mids and no scoop: a heavy, fuzzy British voice', accent: '#ff8a1a', cab: 5 },
  { id: 'amp_brown', name: 'brown plexi', blurb: 'a plexi on a variac: it sags, compresses and sings at moderate gain', accent: '#c98a5a', cab: 3 },
];
const ampModule = (a: (typeof AMP_MODELS)[number]): ModuleDef => ({
  id: a.id, name: a.name, cat: 'amp', blurb: a.blurb, accent: a.accent, stereo: false, knobs: [
    K(a.id, 'gain', 'gain', 0, 1, 0.5), K(a.id, 'bass', 'bass', 0, 1, 0.5), K(a.id, 'mid', 'middle', 0, 1, 0.5),
    K(a.id, 'treble', 'treble', 0, 1, 0.5), K(a.id, 'presence', 'presence', 0, 1, 0.4), K(a.id, 'master', 'master', 0, 1, 0.4),
    K(a.id, 'sag', 'sag', 0, 1, 0.35), K(a.id, 'cab', 'cabinet', 0, 9, a.cab, 'enum', undefined, CAB4_TYPES), K(a.id, 'mic', 'mic', 0, 1, 0.3),
    K(a.id, 'lowcut', 'low cut', 20, 300, 20, 'log', 'Hz'), K(a.id, 'highcut', 'high cut', 2500, 12000, 12000, 'log', 'Hz')],
});
/** Ids of the amp units by voicing, so a rig written for a channel of the older amps (`channel` 0..3 of `amp`) resolves to one. */
export const AMP_IDS = AMP_MODELS.map((a) => a.id);

export const MODULES: ModuleDef[] = [
  { id: 'none', name: 'empty', cat: '', blurb: '', accent: '#6f655b', stereo: false, knobs: [] },
  { id: 'gate', name: 'gate', cat: 'dynamics', blurb: 'noise gate', accent: '#9cc3dd', stereo: false, knobs: [
    K('gate', 'thr', 'threshold', -90, -20, -62, 'lin', 'dB'), K('gate', 'rel', 'release', 0.01, 0.5, 0.08, 'log', 's')] },
  { id: 'comp', name: 'squeeze', cat: 'dynamics', blurb: 'compressor', accent: '#e8d36a', stereo: false, knobs: [
    K('comp', 'sustain', 'sustain', 0, 1, 0.5), K('comp', 'attack', 'attack', 0.0005, 0.05, 0.008, 'log', 's'),
    K('comp', 'release', 'release', 0.05, 1, 0.25, 'log', 's'), K('comp', 'level', 'level', -12, 12, 0, 'lin', 'dB'),
    K('comp', 'blend', 'blend', 0, 1, 1)] },
  drive('glow', 'glow', 'overdrive · diodes in the feedback loop', '#7dff9a'),
  drive('rasp', 'rasp', 'distortion · op-amp into hard diodes', '#ff6b5c'),
  drive('fuzz', 'fuzz', 'two germanium transistors', '#ff8fd0'),
  { id: 'amp', hidden: true, name: 'classic amp', cat: 'amp', blurb: 'clean · crunch · lead · chime: triode preamp, tone stack, power tubes, cabinet', accent: '#ffb04a', stereo: false, knobs: [
    K('amp', 'channel', 'channel', 0, 3, 1, 'enum', undefined, AMP_CHANNELS),
    K('amp', 'gain', 'gain', 0, 1, 0.5), K('amp', 'bass', 'bass', 0, 1, 0.5), K('amp', 'mid', 'middle', 0, 1, 0.5),
    K('amp', 'treble', 'treble', 0, 1, 0.5), K('amp', 'presence', 'presence', 0, 1, 0.4), K('amp', 'master', 'master', 0, 1, 0.4),
    K('amp', 'sag', 'sag', 0, 1, 0.35), K('amp', 'cab', 'cabinet', 0, 4, 2, 'enum', undefined, CAB_TYPES), K('amp', 'mic', 'mic', 0, 1, 0.3)] },
  { id: 'eq', name: 'eq', cat: 'eq', blurb: 'five-band equaliser', accent: '#d8b48a', stereo: false, knobs: [
    K('eq', 'bass', '100', -12, 12, 0, 'lin', 'dB'), K('eq', 'lomid', '400', -12, 12, 0, 'lin', 'dB'),
    K('eq', 'mid', '1k', -12, 12, 0, 'lin', 'dB'), K('eq', 'himid', '2.5k', -12, 12, 0, 'lin', 'dB'),
    K('eq', 'treble', '6k', -12, 12, 0, 'lin', 'dB'), K('eq', 'level', 'level', -12, 12, 0, 'lin', 'dB')] },
  { id: 'chorus', name: 'chorus', cat: 'modulation', blurb: 'bucket-brigade chorus · stereo', accent: '#5fe0d0', stereo: true, knobs: [
    K('chorus', 'rate', 'rate', 0.05, 5, 0.6, 'log', 'Hz'), K('chorus', 'depth', 'depth', 0, 1, 0.5),
    K('chorus', 'tone', 'tone', 0, 1, 0.5), K('chorus', 'mix', 'mix', 0, 1, 0.5)] },
  { id: 'phaser', name: 'phaser', cat: 'modulation', blurb: 'allpass sweep · stereo', accent: '#c58bff', stereo: true, knobs: [
    K('phaser', 'rate', 'rate', 0.05, 8, 0.4, 'log', 'Hz'), K('phaser', 'depth', 'depth', 0, 1, 0.7),
    K('phaser', 'fb', 'feedback', 0, 0.9, 0.4), K('phaser', 'stages', 'stages', 0, 2, 0, 'enum', undefined, PHASER_STAGES),
    K('phaser', 'spread', 'spread', 0, 1, 0.5), K('phaser', 'mix', 'mix', 0, 1, 0.5)] },
  { id: 'trem', name: 'tremolo', cat: 'modulation', blurb: 'amp tremolo', accent: '#ffd08a', stereo: false, knobs: [
    K('trem', 'rate', 'rate', 0.5, 12, 4.5, 'log', 'Hz'), K('trem', 'depth', 'depth', 0, 1, 0.5), K('trem', 'shape', 'shape', 0, 1, 0.3)] },
  { id: 'echo', name: 'tape echo', cat: 'delay', blurb: 'wow, flutter and a saturating loop', accent: '#5fd8ff', stereo: true, knobs: [
    K('echo', 'time', 'time', 0.04, 1.2, 0.38, 'log', 's'), K('echo', 'fb', 'repeats', 0, 0.95, 0.35),
    K('echo', 'tone', 'tone', 0, 1, 0.45), K('echo', 'wow', 'wow', 0, 1, 0.3), K('echo', 'mix', 'mix', 0, 1, 0.25),
    K('echo', 'ping', 'ping-pong', 0, 1, 0, 'bool')] },
  { id: 'spring', name: 'spring', cat: 'reverb', blurb: 'dispersive spring tank', accent: '#9bb7ff', stereo: true, knobs: [
    K('spring', 'decay', 'decay', 0.3, 6, 2, 'log', 's'), K('spring', 'tone', 'tone', 0, 1, 0.5), K('spring', 'mix', 'mix', 0, 1, 0.22)] },
  { id: 'hall', name: 'hall', cat: 'reverb', blurb: 'feedback delay network · shimmer', accent: '#b99bff', stereo: true, knobs: [
    K('hall', 'decay', 'decay', 0.5, 10, 2.5, 'log', 's'), K('hall', 'size', 'size', 0, 1, 0.6), K('hall', 'tone', 'tone', 0, 1, 0.5),
    K('hall', 'shimmer', 'shimmer', 0, 1, 0), K('hall', 'mix', 'mix', 0, 1, 0.22)] },
  // appended: the index is the saved `sNtype` value
  drive('muff', 'muff', 'sustaining fuzz · two clipping stages · scooped tone', '#ff9f5a', 'sustain'),
  drive('boost', 'boost', 'treble booster · one germanium stage pushing the amp', '#f4e27a', 'boost', 'focus'),
  { id: 'amp2', hidden: true, name: 'specialty amp', cat: 'amp', blurb: 'tweed · hi-watt · boutique: three more voicings, two more cabinets', accent: '#ffd27a', stereo: false, knobs: [
    K('amp2', 'channel', 'channel', 0, 2, 1, 'enum', undefined, AMP2_CHANNELS),
    K('amp2', 'gain', 'gain', 0, 1, 0.5), K('amp2', 'bass', 'bass', 0, 1, 0.5), K('amp2', 'mid', 'middle', 0, 1, 0.5),
    K('amp2', 'treble', 'treble', 0, 1, 0.5), K('amp2', 'presence', 'presence', 0, 1, 0.4), K('amp2', 'master', 'master', 0, 1, 0.4),
    K('amp2', 'sag', 'sag', 0, 1, 0.35), K('amp2', 'cab', 'cabinet', 0, 6, 3, 'enum', undefined, CAB2_TYPES), K('amp2', 'mic', 'mic', 0, 1, 0.3)] },
  { id: 'flanger', name: 'flanger', cat: 'modulation', blurb: 'bucket-brigade jet sweep · stereo', accent: '#7fd7ff', stereo: true, knobs: [
    K('flanger', 'rate', 'rate', 0.05, 5, 0.25, 'log', 'Hz'), K('flanger', 'depth', 'depth', 0, 1, 0.6), K('flanger', 'manual', 'manual', 0, 1, 0.4),
    K('flanger', 'regen', 'regen', 0, 0.9, 0.45), K('flanger', 'mix', 'mix', 0, 1, 0.5)] },
  drive('transparent', 'transparent', 'overdrive · a clean blend under soft germanium clipping', '#e8c46a', 'drive', 'treble'),
  drive('metal', 'metal', 'distortion · tight, three cascaded clippers, scooped mids', '#ff4d4d'),
  { id: 'amp3', hidden: true, name: 'high-gain amp', cat: 'amp', blurb: 'brit 800 · rectified · modern: four-stage preamps, tight and loud', accent: '#ff7a3a', stereo: false, knobs: [
    K('amp3', 'channel', 'channel', 0, 2, 0, 'enum', undefined, AMP3_CHANNELS),
    K('amp3', 'gain', 'gain', 0, 1, 0.5), K('amp3', 'bass', 'bass', 0, 1, 0.5), K('amp3', 'mid', 'middle', 0, 1, 0.5),
    K('amp3', 'treble', 'treble', 0, 1, 0.5), K('amp3', 'presence', 'presence', 0, 1, 0.4), K('amp3', 'master', 'master', 0, 1, 0.4),
    K('amp3', 'sag', 'sag', 0, 1, 0.35), K('amp3', 'cab', 'cabinet', 0, 7, 3, 'enum', undefined, CAB3_TYPES), K('amp3', 'mic', 'mic', 0, 1, 0.3)] },
  { id: 'plate', name: 'plate', cat: 'reverb', blurb: 'dense, bright, no early reflections', accent: '#a6d8ff', stereo: true, knobs: [
    K('plate', 'decay', 'decay', 0.4, 6, 1.8, 'log', 's'), K('plate', 'tone', 'tone', 0, 1, 0.7), K('plate', 'mix', 'mix', 0, 1, 0.2)] },
  { id: 'room', name: 'room', cat: 'reverb', blurb: 'a small space around the amp', accent: '#c9b08a', stereo: true, knobs: [
    K('room', 'size', 'size', 0, 1, 0.4), K('room', 'decay', 'decay', 0.15, 1.5, 0.5, 'log', 's'),
    K('room', 'tone', 'tone', 0, 1, 0.45), K('room', 'mix', 'mix', 0, 1, 0.18)] },
  { id: 'wah', name: 'wah', cat: 'filter', blurb: 'resonant sweep · set it by hand or let the pick play it', accent: '#ff9ad0', stereo: false, knobs: [
    K('wah', 'pos', 'pedal', 0, 1, 0.5), K('wah', 'auto', 'auto', 0, 1, 0), K('wah', 'reson', 'resonance', 0, 1, 0.6),
    K('wah', 'level', 'level', -12, 12, 0, 'lin', 'dB')] },
  { id: 'vibe', name: 'vibe', cat: 'modulation', blurb: 'four-stage photocell phaser · chorus or vibrato', accent: '#ff8a5c', stereo: false, knobs: [
    K('vibe', 'rate', 'rate', 0.2, 10, 1.2, 'log', 'Hz'), K('vibe', 'depth', 'intensity', 0, 1, 0.75),
    K('vibe', 'mode', 'mode', 0, 1, 0, 'enum', undefined, VIBE_MODES)] },
  { id: 'rotary', name: 'rotary', cat: 'modulation', blurb: 'rotating horn and drum · doppler and swirl · stereo', accent: '#c9a0ff', stereo: true, knobs: [
    K('rotary', 'speed', 'speed', 0, 1, 0.3), K('rotary', 'depth', 'depth', 0, 1, 0.7), K('rotary', 'mix', 'mix', 0, 1, 1)] },
  drive('octave', 'octave', 'full-wave rectifier · octave-up fuzz · best high up the neck', '#9be86a', 'fuzz', 'tone'),
  { id: 'amp4', hidden: true, name: 'vintage amp', cat: 'amp', blurb: 'blackface · champ · orange · brown: a Fender twin, a 5-watt, a fat British, a plexi on a variac', accent: '#e8a05a', stereo: false, knobs: [
    K('amp4', 'channel', 'channel', 0, 3, 0, 'enum', undefined, AMP4_CHANNELS),
    K('amp4', 'gain', 'gain', 0, 1, 0.5), K('amp4', 'bass', 'bass', 0, 1, 0.5), K('amp4', 'mid', 'middle', 0, 1, 0.5),
    K('amp4', 'treble', 'treble', 0, 1, 0.5), K('amp4', 'presence', 'presence', 0, 1, 0.4), K('amp4', 'master', 'master', 0, 1, 0.4),
    K('amp4', 'sag', 'sag', 0, 1, 0.35), K('amp4', 'cab', 'cabinet', 0, 9, 3, 'enum', undefined, CAB4_TYPES), K('amp4', 'mic', 'mic', 0, 1, 0.3)] },
  { id: 'gtone', name: 'guitar tone', cat: 'guitar', blurb: 'the tone and volume knobs on the guitar: roll the highs off, or clean it up', accent: '#d9c5a0', stereo: false, knobs: [
    K('gtone', 'tone', 'tone', 0, 1, 1), K('gtone', 'volume', 'volume', 0, 1, 1)] },
  ...AMP_MODELS.map(ampModule),
  { id: 'sdelay', name: 'stereo delay', cat: 'delay', blurb: 'a different delay on each side · cross-feed to ping-pong', accent: '#6ee0c8', stereo: true, knobs: [
    K('sdelay', 'timeL', 'left time', 0.01, 1.5, 0.375, 'log', 's'), K('sdelay', 'timeR', 'right time', 0.01, 1.5, 0.5, 'log', 's'),
    K('sdelay', 'fbL', 'left repeats', 0, 0.95, 0.35), K('sdelay', 'fbR', 'right repeats', 0, 0.95, 0.35),
    K('sdelay', 'cross', 'cross', 0, 1, 0.3), K('sdelay', 'tone', 'tone', 0, 1, 0.5), K('sdelay', 'mod', 'modulation', 0, 1, 0.15),
    K('sdelay', 'levelL', 'left level', 0, 1, 1), K('sdelay', 'levelR', 'right level', 0, 1, 1),
    K('sdelay', 'mix', 'mix', 0, 1, 0.25), K('sdelay', 'drive', 'drive', 0, 1, 0)] },
];

export const MODULE_BY_ID: Record<string, number> = Object.fromEntries(MODULES.map((m, i) => [m.id, i]));
/** Library order. */
export const CATEGORIES = ['guitar', 'dynamics', 'drive', 'amp', 'eq', 'filter', 'modulation', 'delay', 'reverb'];

// ---- the flat parameter list -------------------------------------------------

export const P_INGAIN = 0, P_HEAT = 1, P_VOLUME = 2;
export const SLOT_BASE = 3;
export const SLOT_STRIDE = 2 + MAX_KNOBS;     // type, on, knobs

export const slotTypeId = (s: number) => `s${s + 1}type`;
export const slotOnId = (s: number) => `s${s + 1}on`;
export const slotKnobId = (s: number, k: number) => `s${s + 1}k${k + 1}`;
/** Index into PARAMS of slot s's type (+1 on, +2+k knob k). */
export const slotIndex = (s: number) => SLOT_BASE + s * SLOT_STRIDE;

const MODULE_LABELS = MODULES.map((m) => m.name);

export const PARAMS: ParamDef[] = [
  P('inGain', 'input', 'rig', -12, 24, 0, 'lin', 'dB'),
  P('heat', 'heat', 'rig', 0, 1, 0.5),
  P('volume', 'volume', 'rig', 0, 1, 0.7),
];
for (let s = 0; s < NSLOTS; s++) {
  const g = `slot${s + 1}`;
  PARAMS.push(P(slotTypeId(s), 'module', g, 0, NMODULES - 1, 0, 'enum', undefined, MODULE_LABELS));
  PARAMS.push(P(slotOnId(s), 'on', g, 0, 1, 1, 'bool'));
  for (let k = 0; k < MAX_KNOBS; k++) PARAMS.push(P(slotKnobId(s, k), `knob ${k + 1}`, g, 0, 1, 0.5));
}
export const NPARAMS = PARAMS.length;

export type ParamId = string;
export type ParamValues = Record<ParamId, number>;

export const PARAM_BY_ID: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((p) => [p.id, p]));
export const PARAM_INDEX: Record<string, number> = Object.fromEntries(PARAMS.map((p, i) => [p.id, i]));

/** Not part of a rig: the volume stays where you left it when you change rigs. */
export const NOT_IN_RIG = ['volume'];

export function defaults(): ParamValues {
  const v: ParamValues = {};
  for (const p of PARAMS) v[p.id] = p.def;
  return v;
}

export function fromNorm(p: ParamDef, t: number): number {
  t = Math.min(1, Math.max(0, t));
  let v = p.scale === 'log' ? p.min * Math.pow(p.max / p.min, t) : p.min + (p.max - p.min) * t;
  if (p.scale === 'int' || p.scale === 'enum' || p.scale === 'bool') v = Math.round(v);
  return v;
}

export function toNorm(p: ParamDef, v: number): number {
  v = Math.min(p.max, Math.max(p.min, v));
  if (p.scale === 'log') return Math.log(v / p.min) / Math.log(p.max / p.min);
  return (v - p.min) / (p.max - p.min);
}

export function format(p: ParamDef, v: number): string {
  if (p.labels) return p.labels[Math.round(v)] ?? String(v);
  if (p.scale === 'bool') return v >= 0.5 ? 'on' : 'off';
  if (p.scale === 'int') return `${Math.round(v)}${p.unit ? ' ' + p.unit : ''}`;
  if (p.unit === 'dB') return `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)} dB`;
  if (p.unit === 's') return v >= 1 ? `${v.toFixed(2)} s` : v >= 0.01 ? `${(v * 1000).toFixed(0)} ms` : `${(v * 1000).toFixed(1)} ms`;
  if (p.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : v >= 100 ? `${v.toFixed(0)} Hz` : v >= 10 ? `${v.toFixed(1)} Hz` : `${v.toFixed(2)} Hz`;
  // knobs read like the ones on real gear: 0 to 10
  return (v * 10).toFixed(1);
}

// ---- rigs ------------------------------------------------------------------

export const RIG_TAGS = ['clean', 'crunch', 'lead', 'heavy', 'fuzz', 'ambient'];

/** One unit in a rig: the module id, and the knobs that differ from its defaults, in real units. */
export interface Unit { m: string; off?: boolean; v?: Record<string, number> }

export interface Rig {
  name: string;
  tag: string;
  inGain?: number;
  heat?: number;
  rack: Unit[];
}

/** Write a module into slot `s` of `values` with its default knobs (or `real`, by knob id). */
export function placeModule(values: ParamValues, s: number, type: number, real: Record<string, number> = {}, on = true): void {
  values[slotTypeId(s)] = type;
  values[slotOnId(s)] = on ? 1 : 0;
  const knobs = MODULES[type].knobs;
  for (let k = 0; k < MAX_KNOBS; k++) values[slotKnobId(s, k)] = k < knobs.length ? toNorm(knobs[k], real[knobs[k].id] ?? knobs[k].def) : 0.5;
}

/** A rig as flat parameter values (every slot; knobs 0..1). Throws on a module or knob that doesn't exist. */
export function rigValues(rig: Rig): ParamValues {
  const v = defaults();
  if (rig.inGain !== undefined) v.inGain = rig.inGain;
  if (rig.heat !== undefined) v.heat = rig.heat;
  rig.rack.slice(0, NSLOTS).forEach((u, s) => {
    const type = MODULE_BY_ID[u.m];
    if (type === undefined) throw new Error(`rig "${rig.name}": no module "${u.m}"`);
    for (const id in u.v ?? {}) if (!MODULES[type].knobs.some((d) => d.id === id)) throw new Error(`rig "${rig.name}": ${u.m} has no knob "${id}"`);
    placeModule(v, s, type, u.v, !u.off);
  });
  return v;
}

/** Only the values that differ from the defaults (what a preset stores). */
export function diffValues(values: ParamValues): Partial<ParamValues> {
  const d = defaults(), out: Partial<ParamValues> = {};
  for (const p of PARAMS) if (!NOT_IN_RIG.includes(p.id) && Math.abs(values[p.id] - d[p.id]) > 1e-9) out[p.id] = values[p.id];
  return out;
}

const gate = (thr = -62, rel?: number): Unit => ({ m: 'gate', v: rel === undefined ? { thr } : { thr, rel } });
/** The amp helpers take the older `channel` and return the named amp unit with the same knobs. */
const ampUnit = (base: number) => (v: Record<string, number>): Unit => { const { channel, ...rest } = v; return { m: AMP_IDS[base + channel], v: rest }; };
const amp = ampUnit(0);
const amp2 = ampUnit(4), amp3 = ampUnit(7), amp4 = ampUnit(10);

export const RIGS: Rig[] = [
  // ---------------------------------------------------------------- clean
  { name: 'Glass Porch', tag: 'clean', rack: [gate(),
    amp({ channel: 0, gain: 0.38, bass: 0.45, mid: 0.55, treble: 0.62, presence: 0.5, master: 0.3, sag: 0.2, cab: 1, mic: 0.25 }),
    { m: 'spring', v: { decay: 2.2, mix: 0.24 } }] },
  { name: 'Sunday Set', tag: 'clean', rack: [gate(), { m: 'comp', v: { sustain: 0.35, blend: 0.7 } },
    amp({ channel: 0, gain: 0.42, bass: 0.5, mid: 0.6, treble: 0.5, presence: 0.35, master: 0.35, cab: 2, mic: 0.45 }),
    { m: 'hall', v: { decay: 1.6, size: 0.4, mix: 0.16 } }] },
  { name: 'Chime Line', tag: 'clean', rack: [gate(),
    amp({ channel: 3, gain: 0.4, bass: 0.38, mid: 0.45, treble: 0.68, presence: 0.55, master: 0.4, sag: 0.3, cab: 4, mic: 0.15 }),
    { m: 'echo', v: { time: 0.33, fb: 0.22, mix: 0.18, tone: 0.6 } }, { m: 'spring', v: { mix: 0.18 } }] },
  { name: 'Surf Drip', tag: 'clean', rack: [gate(), { m: 'spring', v: { decay: 3.2, mix: 0.42, tone: 0.65 } },
    amp({ channel: 0, gain: 0.48, bass: 0.4, mid: 0.45, treble: 0.7, presence: 0.55, master: 0.45, cab: 1, mic: 0.2 }),
    { m: 'trem', off: true, v: { rate: 5.5, depth: 0.55 } }] },
  { name: 'Velvet Room', tag: 'clean', rack: [gate(),
    amp({ channel: 0, gain: 0.55, bass: 0.62, mid: 0.5, treble: 0.3, presence: 0.15, master: 0.3, cab: 3, mic: 0.8 }),
    { m: 'hall', v: { decay: 1.2, size: 0.35, mix: 0.14, tone: 0.3 } }] },
  { name: 'Eighties Wash', tag: 'clean', rack: [gate(), { m: 'comp', v: { sustain: 0.6, attack: 0.004 } },
    amp({ channel: 0, gain: 0.35, bass: 0.42, mid: 0.4, treble: 0.65, presence: 0.6, master: 0.3, cab: 2, mic: 0.2 }),
    { m: 'chorus', v: { rate: 0.8, depth: 0.55, mix: 0.5, tone: 0.65 } }, { m: 'echo', v: { time: 0.42, fb: 0.3, mix: 0.2, ping: 1, wow: 0.1 } },
    { m: 'hall', v: { decay: 3, mix: 0.2 } }] },
  { name: 'Country Snap', tag: 'clean', rack: [gate(), { m: 'comp', v: { sustain: 0.7, attack: 0.002, release: 0.15, level: -4 } },
    amp({ channel: 0, gain: 0.45, bass: 0.4, mid: 0.38, treble: 0.72, presence: 0.6, master: 0.4, sag: 0.15, cab: 2, mic: 0.1 }),
    { m: 'echo', v: { time: 0.12, fb: 0.12, mix: 0.2, tone: 0.7, wow: 0.05 } }, { m: 'spring', v: { mix: 0.12 } }] },
  { name: 'Wobble Porch', tag: 'clean', rack: [gate(),
    amp({ channel: 0, gain: 0.5, bass: 0.45, mid: 0.5, treble: 0.58, presence: 0.45, master: 0.4, cab: 1, mic: 0.3 }),
    { m: 'trem', v: { rate: 4.2, depth: 0.6, shape: 0.25 } }, { m: 'spring', v: { decay: 2.6, mix: 0.25 } }] },
  // ---------------------------------------------------------------- crunch
  { name: 'Edge of Breakup', tag: 'crunch', rack: [gate(),
    amp({ channel: 0, gain: 0.78, bass: 0.45, mid: 0.6, treble: 0.55, presence: 0.45, master: 0.62, sag: 0.55, cab: 2, mic: 0.35 }),
    { m: 'spring', v: { mix: 0.15 } }] },
  { name: 'Back Room Blues', tag: 'crunch', rack: [gate(), { m: 'glow', v: { gain: 0.3, tone: 0.5, level: 2 } },
    amp({ channel: 0, gain: 0.5, bass: 0.45, mid: 0.65, treble: 0.5, master: 0.5, sag: 0.5, cab: 2, mic: 0.4 }),
    { m: 'spring', v: { decay: 1.8, mix: 0.16 } }] },
  { name: 'Plexi Afternoon', tag: 'crunch', rack: [gate(),
    amp({ channel: 1, gain: 0.55, bass: 0.5, mid: 0.7, treble: 0.62, presence: 0.5, master: 0.55, sag: 0.45, cab: 3, mic: 0.3 }),
    { m: 'hall', v: { decay: 1.4, size: 0.4, mix: 0.12 } }] },
  { name: 'Garage Door', tag: 'crunch', rack: [gate(), { m: 'rasp', v: { gain: 0.35, tone: 0.55 } },
    amp({ channel: 1, gain: 0.4, bass: 0.55, mid: 0.62, treble: 0.55, master: 0.5, cab: 3, mic: 0.45 })] },
  { name: 'Gaffer Tape', tag: 'crunch', rack: [gate(), { m: 'glow', v: { gain: 0.15, tone: 0.6, level: 9 } },
    amp({ channel: 1, gain: 0.48, bass: 0.45, mid: 0.75, treble: 0.6, presence: 0.55, master: 0.5, cab: 2, mic: 0.3 }),
    { m: 'echo', v: { time: 0.12, fb: 0.1, mix: 0.2, tone: 0.4 } }] },
  { name: 'Top Boost', tag: 'crunch', rack: [gate(),
    amp({ channel: 3, gain: 0.7, bass: 0.4, mid: 0.5, treble: 0.62, presence: 0.45, master: 0.6, sag: 0.5, cab: 4, mic: 0.3 }),
    { m: 'spring', v: { mix: 0.14 } }] },
  // ---------------------------------------------------------------- lead
  { name: 'Solo Ridge', tag: 'lead', rack: [gate(), { m: 'glow', v: { gain: 0.35, tone: 0.55, level: 6 } },
    amp({ channel: 1, gain: 0.72, bass: 0.45, mid: 0.78, treble: 0.55, presence: 0.5, master: 0.55, sag: 0.5, cab: 3, mic: 0.35 }),
    { m: 'echo', v: { time: 0.42, fb: 0.32, mix: 0.22 } }, { m: 'hall', v: { decay: 2.4, mix: 0.18 } }] },
  { name: 'Singing Sustain', tag: 'lead', rack: [gate(),
    amp({ channel: 2, gain: 0.62, bass: 0.42, mid: 0.7, treble: 0.5, presence: 0.45, master: 0.5, sag: 0.6, cab: 3, mic: 0.4 }),
    { m: 'echo', v: { time: 0.48, fb: 0.38, mix: 0.24, tone: 0.35 } }, { m: 'hall', v: { decay: 3, mix: 0.2 } }] },
  { name: 'Night Drive', tag: 'lead', rack: [gate(), { m: 'glow', v: { gain: 0.55, tone: 0.4, level: 3 } },
    amp({ channel: 1, gain: 0.6, bass: 0.5, mid: 0.65, treble: 0.45, master: 0.5, cab: 2, mic: 0.55 }),
    { m: 'echo', v: { time: 0.56, fb: 0.45, mix: 0.28, wow: 0.55, ping: 1 } }, { m: 'hall', v: { decay: 4, mix: 0.22 } }] },
  { name: 'Violin Swell', tag: 'lead', rack: [gate(-70),
    amp({ channel: 2, gain: 0.5, bass: 0.35, mid: 0.6, treble: 0.38, presence: 0.3, master: 0.45, cab: 2, mic: 0.7 }),
    { m: 'echo', v: { time: 0.6, fb: 0.5, mix: 0.3, tone: 0.3 } }, { m: 'hall', v: { decay: 5, mix: 0.3 } }] },
  { name: 'Phase Lead', tag: 'lead', rack: [gate(), { m: 'phaser', v: { rate: 0.3, depth: 0.75, fb: 0.5, mix: 0.5 } },
    amp({ channel: 1, gain: 0.68, bass: 0.48, mid: 0.7, treble: 0.55, presence: 0.5, master: 0.55, sag: 0.5, cab: 3, mic: 0.35 }),
    { m: 'echo', v: { time: 0.38, fb: 0.3, mix: 0.2 } }] },
  // ---------------------------------------------------------------- heavy
  { name: 'Riff Engine', tag: 'heavy', rack: [gate(-55), { m: 'glow', v: { gain: 0.05, tone: 0.6, level: 10 } },
    amp({ channel: 2, gain: 0.72, bass: 0.6, mid: 0.45, treble: 0.6, presence: 0.55, master: 0.5, sag: 0.3, cab: 3, mic: 0.3 })] },
  { name: 'Tight Chug', tag: 'heavy', rack: [gate(-50, 0.04), { m: 'glow', v: { gain: 0, tone: 0.65, level: 12 } },
    amp({ channel: 2, gain: 0.82, bass: 0.55, mid: 0.35, treble: 0.62, presence: 0.6, master: 0.45, sag: 0.2, cab: 3, mic: 0.2 }),
    { m: 'eq', v: { lomid: -3, himid: 2 } }] },
  { name: 'Wall of Stacks', tag: 'heavy', rack: [gate(-56), { m: 'rasp', v: { gain: 0.45, tone: 0.45, level: -2 } },
    amp({ channel: 2, gain: 0.6, bass: 0.65, mid: 0.5, treble: 0.55, master: 0.45, sag: 0.45, cab: 3, mic: 0.45 }),
    { m: 'hall', v: { decay: 1.2, size: 0.4, mix: 0.1 } }] },
  { name: 'Doom Hall', tag: 'heavy', rack: [gate(-58),
    amp({ channel: 2, gain: 0.9, bass: 0.75, mid: 0.4, treble: 0.4, presence: 0.35, master: 0.45, sag: 0.7, cab: 3, mic: 0.6 }),
    { m: 'hall', v: { decay: 4.5, mix: 0.2, tone: 0.3 } }] },
  // ---------------------------------------------------------------- fuzz
  { name: 'Sputter', tag: 'fuzz', rack: [{ m: 'fuzz', v: { gain: 0.6, tone: 0.55, level: -11 } },
    amp({ channel: 0, gain: 0.5, bass: 0.5, mid: 0.55, treble: 0.5, master: 0.5, cab: 2, mic: 0.35 })] },
  { name: 'Wool Coat', tag: 'fuzz', rack: [{ m: 'fuzz', v: { gain: 0.9, tone: 0.3, level: -8 } },
    amp({ channel: 1, gain: 0.3, bass: 0.6, mid: 0.45, treble: 0.45, master: 0.5, sag: 0.6, cab: 3, mic: 0.5 }),
    { m: 'hall', v: { decay: 2, mix: 0.14 } }] },
  { name: 'Velcro', tag: 'fuzz', rack: [
    amp({ channel: 0, gain: 0.35, master: 0.4, cab: 0 }), { m: 'fuzz', v: { gain: 1, tone: 0.75, level: -3 } },
    { m: 'eq', v: { bass: -4, mid: 3, treble: -6 } }] },
  { name: 'Fuzz Wobble', tag: 'fuzz', rack: [{ m: 'fuzz', v: { gain: 0.75, tone: 0.5, level: -10 } },
    amp({ channel: 0, gain: 0.45, bass: 0.5, mid: 0.5, treble: 0.5, master: 0.5, cab: 1, mic: 0.4 }),
    { m: 'trem', v: { rate: 6.5, depth: 0.7, shape: 0.8 } }, { m: 'spring', v: { mix: 0.18 } }] },
  // ---------------------------------------------------------------- ambient
  { name: 'Tape Ghosts', tag: 'ambient', rack: [gate(),
    amp({ channel: 0, gain: 0.5, treble: 0.45, master: 0.35, cab: 2, mic: 0.55 }),
    { m: 'echo', v: { time: 0.7, fb: 0.62, tone: 0.3, wow: 0.8, mix: 0.4, ping: 1 } }, { m: 'hall', v: { decay: 6, mix: 0.38, tone: 0.4 } }] },
  { name: 'Cathedral Clean', tag: 'ambient', rack: [gate(),
    amp({ channel: 0, gain: 0.32, bass: 0.42, treble: 0.58, master: 0.3, cab: 2, mic: 0.3 }),
    { m: 'echo', v: { time: 0.45, fb: 0.4, mix: 0.22, ping: 1 } }, { m: 'hall', v: { decay: 8, size: 1, mix: 0.5, tone: 0.55, shimmer: 0.35 } }] },
  { name: 'Wet Wire', tag: 'ambient', rack: [gate(), { m: 'glow', v: { gain: 0.4, tone: 0.45, level: 3 } },
    { m: 'echo', v: { time: 0.3, fb: 0.7, tone: 0.5, wow: 0.4, mix: 0.35 } },
    amp({ channel: 1, gain: 0.35, mid: 0.6, master: 0.45, cab: 2, mic: 0.4 }), { m: 'spring', v: { decay: 2.6, mix: 0.25 } }] },
  { name: 'Slow Orbit', tag: 'ambient', rack: [gate(), { m: 'comp', v: { sustain: 0.55, level: 3 } },
    amp({ channel: 3, gain: 0.35, bass: 0.45, treble: 0.55, master: 0.35, cab: 4, mic: 0.4 }),
    { m: 'phaser', v: { rate: 0.12, depth: 0.8, fb: 0.3, stages: 2, spread: 1, mix: 0.5 } },
    { m: 'chorus', v: { rate: 0.25, depth: 0.7, mix: 0.4 } }, { m: 'echo', v: { time: 0.62, fb: 0.5, mix: 0.3, ping: 1, wow: 0.5 } },
    { m: 'hall', v: { decay: 7, size: 0.9, mix: 0.4, shimmer: 0.5 } }] },
  // ---------------------------------------------------------------- pickup-matched rigs
  // The first three are voiced for a single coil (a strat): a little more input than the demo guitar's humbucker needs, and the guitar tone module first, rolled back like the tone knob. With a humbucker, take the input knob to 0.
  // a singing, smooth lead on a pushed plexi: the tape echo goes in front of the drive (fast playing squashes the repeats, held notes let them bloom), a tube overdrive with its tone low, the brown channel (a plexi on a variac, so it sags and compresses) with the treble and presence nearly off, the compressor after the amp, an EQ rounding the top, a light chorus and a small plate. Play the bridge pickup with the guitar's tone at 6 or 7.
  { name: 'Copper Kite', tag: 'lead', inGain: 2, rack: [{ m: 'gtone', v: { tone: 0.65 } }, gate(),
    { m: 'echo', v: { time: 0.4, fb: 0.22, mix: 0.3, tone: 0.5, wow: 0.15 } },
    { m: 'glow', v: { gain: 0.35, tone: 0.25, level: 5 } },
    amp4({ channel: 3, gain: 0.42, bass: 0.5, mid: 0.55, treble: 0.3, presence: 0.2, master: 0.5, sag: 0.6, cab: 3, mic: 0.35 }),
    { m: 'comp', v: { sustain: 0.5, attack: 0.01, release: 0.3, blend: 0.9 } },
    { m: 'eq', v: { bass: 2, lomid: 2.5, mid: 1, treble: -3, level: 0 } },
    { m: 'chorus', v: { rate: 0.45, depth: 0.3, mix: 0.2, tone: 0.6 } },
    { m: 'plate', v: { decay: 1.4, tone: 0.55, mix: 0.12 } }] },
  // a long, sustained, creamy lead: a compressor into a fat muff into a big, tight amp that does the compressing, the mids put back with an EQ, a slow echo and a big hall (flanger waiting, bypassed)
  { name: 'Slow Ember', tag: 'lead', inGain: 2, rack: [{ m: 'gtone', v: { tone: 0.65 } }, gate(-58), { m: 'comp', v: { sustain: 0.55, attack: 0.006, release: 0.3, level: 2 } },
    { m: 'muff', v: { gain: 0.4, tone: 0.45, level: -13 } },
    amp2({ channel: 1, gain: 0.45, bass: 0.5, mid: 0.7, treble: 0.42, presence: 0.4, master: 0.5, sag: 0.45, cab: 5, mic: 0.4 }),
    { m: 'eq', v: { lomid: 2, mid: 3, treble: -1 } },
    { m: 'flanger', off: true, v: { rate: 0.2, depth: 0.6, manual: 0.4, regen: 0.5, mix: 0.45 } },
    { m: 'echo', v: { time: 0.42, fb: 0.28, mix: 0.22, tone: 0.4, wow: 0.2 } }, { m: 'hall', v: { decay: 3.5, size: 0.7, mix: 0.2, tone: 0.45 } }] },
  // a tight, dry, compressed clean for funky rhythm: slow attack so the pick cluck gets through, a hi-watt on the edge, a hint of room
  { name: 'Chalk Line', tag: 'clean', inGain: 2, rack: [{ m: 'gtone', v: { tone: 0.65 } }, gate(-60, 0.05), { m: 'comp', v: { sustain: 0.6, attack: 0.012, release: 0.12, level: -4.5 } },
    amp2({ channel: 1, gain: 0.36, bass: 0.4, mid: 0.5, treble: 0.45, presence: 0.4, master: 0.45, sag: 0.2, cab: 3, mic: 0.3 }),
    { m: 'flanger', off: true, v: { rate: 0.3, depth: 0.5, manual: 0.35, regen: 0.4, mix: 0.4 } },
    { m: 'hall', v: { decay: 0.8, size: 0.3, mix: 0.08 } }] },
  // ---------------------------------------------------------------- built from the newer components
  // a gritty blues: an overdrive that keeps the clean signal under it into a class A tweed that compresses, in a small room
  { name: 'Brass Rail', tag: 'crunch', rack: [{ m: 'gtone', v: { tone: 0.65 } }, gate(), { m: 'transparent', v: { gain: 0.3, tone: 0.45, level: 2 } },
    amp2({ channel: 0, gain: 0.45, bass: 0.5, mid: 0.55, treble: 0.45, presence: 0.35, master: 0.5, sag: 0.6, cab: 6, mic: 0.4 }),
    { m: 'room', v: { size: 0.35, decay: 0.45, mix: 0.16 } }] },
  // a tight modern chug: a distortion used as a booster in front of a four-stage amp and a v30 cabinet
  { name: 'Iron Orchard', tag: 'heavy', rack: [gate(-52, 0.04), { m: 'metal', v: { gain: 0.3, tone: 0.45, level: -4 } },
    amp3({ channel: 2, gain: 0.45, bass: 0.45, mid: 0.4, treble: 0.48, presence: 0.42, master: 0.5, sag: 0.35, cab: 7, mic: 0.3 }),
    { m: 'room', v: { size: 0.25, decay: 0.35, mix: 0.1 } }] },
  // funk: a compressor, then a wah that the pick plays, into a clean hi-watt and a short plate
  { name: 'Pocket Wah', tag: 'clean', rack: [gate(-60, 0.05), { m: 'comp', v: { sustain: 0.5, attack: 0.012, release: 0.15, level: -2 } },
    { m: 'wah', v: { pos: 0.5, auto: 0.8, reson: 0.55 } },
    amp2({ channel: 1, gain: 0.4, bass: 0.4, mid: 0.55, treble: 0.55, presence: 0.5, master: 0.45, sag: 0.2, cab: 3, mic: 0.3 }),
    { m: 'plate', v: { decay: 0.9, tone: 0.6, mix: 0.1 } }] },
  // classic rock lead: an overdrive pushing a brit 800, a slapback-ish echo and a plate
  { name: 'Slate Roof', tag: 'lead', rack: [{ m: 'gtone', v: { tone: 0.65 } }, gate(), { m: 'transparent', v: { gain: 0.2, tone: 0.45, level: 3 } },
    amp3({ channel: 0, gain: 0.42, bass: 0.45, mid: 0.6, treble: 0.45, presence: 0.38, master: 0.5, sag: 0.4, cab: 5, mic: 0.35 }),
    { m: 'echo', v: { time: 0.38, fb: 0.25, mix: 0.16 } }, { m: 'plate', v: { decay: 1.6, tone: 0.65, mix: 0.16 } }] },
  // a slow flanger and a ping-pong echo into a long plate
  { name: 'Glass Tide', tag: 'ambient', rack: [gate(), { m: 'transparent', v: { gain: 0.15, tone: 0.5 } },
    amp2({ channel: 2, gain: 0.35, bass: 0.4, mid: 0.5, treble: 0.5, master: 0.4, cab: 5, mic: 0.3 }),
    { m: 'flanger', v: { rate: 0.12, depth: 0.7, manual: 0.5, regen: 0.55, mix: 0.4 } },
    { m: 'echo', v: { time: 0.52, fb: 0.5, mix: 0.3, ping: 1, wow: 0.4 } }, { m: 'plate', v: { decay: 4, tone: 0.6, mix: 0.35 } }] },
  // wah into a fuzz into a tweed: the classic order
  { name: 'Dust Bowl', tag: 'fuzz', rack: [{ m: 'wah', v: { pos: 0.4, auto: 0.6, reson: 0.6 } }, { m: 'boost', v: { gain: 0.2, tone: 0.3 } },
    { m: 'muff', v: { gain: 0.45, tone: 0.5, level: -13 } },
    amp2({ channel: 0, gain: 0.5, bass: 0.5, mid: 0.5, treble: 0.4, master: 0.55, sag: 0.55, cab: 6, mic: 0.4 }),
    { m: 'room', v: { size: 0.5, decay: 0.6, mix: 0.22 } }] },
  // a blackface with the headroom of a twin, a rotating speaker and a short plate
  { name: 'Spin Cycle', tag: 'clean', rack: [gate(-62), { m: 'comp', v: { sustain: 0.35, attack: 0.012, release: 0.2, blend: 0.7, level: 1 } },
    amp4({ channel: 0, gain: 0.45, bass: 0.45, mid: 0.5, treble: 0.4, presence: 0.3, master: 0.45, sag: 0.15, cab: 8, mic: 0.3 }),
    { m: 'rotary', v: { speed: 0.3, depth: 0.7, mix: 0.85 } }, { m: 'plate', v: { decay: 1.2, tone: 0.65, mix: 0.14 } }] },
  // an octave fuzz into a variac plexi with a vibe: swirl and bark
  { name: 'Purple Lens', tag: 'fuzz', rack: [{ m: 'gtone', v: { tone: 0.65 } }, { m: 'octave', v: { gain: 0.4, tone: 0.4, level: 2 } },
    amp4({ channel: 3, gain: 0.45, bass: 0.5, mid: 0.55, treble: 0.4, presence: 0.3, master: 0.5, sag: 0.6, cab: 3, mic: 0.35 }),
    { m: 'vibe', v: { rate: 0.9, depth: 0.8, mode: 0 } }, { m: 'spring', v: { decay: 2.2, mix: 0.2 } }] },
  // a different delay on each side (375 ms left, 500 ms right, three to four) with a little cross-feed, into a long plate
  { name: 'Two Clocks', tag: 'ambient', rack: [gate(-62), { m: 'comp', v: { sustain: 0.3, attack: 0.012, release: 0.25, level: 1 } },
    amp4({ channel: 0, gain: 0.4, bass: 0.45, mid: 0.5, treble: 0.4, presence: 0.3, master: 0.45, sag: 0.15, cab: 8, mic: 0.3 }),
    { m: 'sdelay', v: { timeL: 0.375, timeR: 0.5, fbL: 0.35, fbR: 0.4, cross: 0.35, tone: 0.5, mod: 0.2, mix: 0.3 } },
    { m: 'plate', v: { decay: 2.6, tone: 0.6, mix: 0.22 } }] },
];
