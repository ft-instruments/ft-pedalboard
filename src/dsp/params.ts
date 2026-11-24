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
export const M_CABIR = 44;
export const M_NAM = 45;
export const M_EQ7 = 46, M_COMP2 = 47;
export const M_ENVFILTER = 48, M_PITCH = 49;
export const NMODULES = 50;
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
  /** Only the plugin has it: the web engine passes the signal through, and the web library leaves it out. */
  pluginOnly?: boolean;
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
export const TREM_TYPES = ['optical', 'bias', 'harmonic'];
export const ENV_TYPES = ['lowpass', 'bandpass', 'highpass'];
export const ENV_DIRS = ['up', 'down'];

const K = (m: string, id: string, name: string, min: number, max: number, def: number, scale: Scale = 'lin', unit?: string, labels?: string[]) =>
  P(id, name, m, min, max, def, scale, unit, labels);
const drive = (id: string, name: string, blurb: string, accent: string, gain = 'gain', tone = 'tone'): ModuleDef => ({
  id, name, cat: 'drive', blurb, accent, stereo: false,
  // level: the output pot, in dB under the circuit's own output (0 dB = full up).
  knobs: [K(id, 'gain', gain, 0, 1, 0.5), K(id, 'tone', tone, 0, 1, 0.5), K(id, 'level', 'level', -36, 0, -12, 'lin', 'dB')],
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
/** The amps that have a master volume (amp.ts `mv`); on the others the master knob starts at full, where the real amp is. */
const AMP_HAS_MASTER = ['amp_hot', 'amp_boutique', 'amp_brit800', 'amp_rectified', 'amp_modern', 'amp_orange'];
const ampModule = (a: (typeof AMP_MODELS)[number]): ModuleDef => ({
  id: a.id, name: a.name, cat: 'amp', blurb: a.blurb, accent: a.accent, stereo: false, knobs: [
    K(a.id, 'gain', 'gain', 0, 1, 0.5), K(a.id, 'bass', 'bass', 0, 1, 0.5), K(a.id, 'mid', 'middle', 0, 1, 0.5),
    K(a.id, 'treble', 'treble', 0, 1, 0.5), K(a.id, 'presence', 'presence', 0, 1, 0.4), K(a.id, 'master', 'master', 0, 1, AMP_HAS_MASTER.includes(a.id) ? 0.4 : 1),
    K(a.id, 'sag', 'sag', 0, 1, 0.35), K(a.id, 'cab', 'cabinet', 0, 9, a.cab, 'enum', undefined, CAB4_TYPES), K(a.id, 'mic', 'mic', 0, 1, 0.3),
    K(a.id, 'lowcut', 'low cut', 20, 300, 20, 'log', 'Hz'), K(a.id, 'highcut', 'high cut', 2500, 12000, 12000, 'log', 'Hz'),
    // appended: the level after the power stage and the cabinet (a load box's), so a rig sets its loudness without moving the drive
    K(a.id, 'level', 'output', -18, 18, 0, 'lin', 'dB')],
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
    K('trem', 'rate', 'rate', 0.5, 12, 4.5, 'log', 'Hz'), K('trem', 'depth', 'depth', 0, 1, 0.5), K('trem', 'shape', 'shape', 0, 1, 0.3),
    // appended; bias in the middle, so a rig saved before it existed (the knob's idle 0.5) keeps its sound
    K('trem', 'type', 'type', 0, 2, 1, 'enum', undefined, TREM_TYPES)] },
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
  { id: 'cabir', name: 'cab IR', cat: 'amp', blurb: 'your own cabinet impulse response (a WAV): load one, or it passes the signal through', accent: '#c9a36a', stereo: false, knobs: [
    K('cabir', 'level', 'level', -24, 12, 0, 'lin', 'dB'), K('cabir', 'mix', 'mix', 0, 1, 1)] },
  { id: 'nam', name: 'NAM capture', cat: 'amp', blurb: 'a Neural Amp Modeler capture (.nam) of a real amp or pedal · plugin only', accent: '#e07a5f', stereo: false, pluginOnly: true, knobs: [
    K('nam', 'input', 'input', -24, 24, 0, 'lin', 'dB'), K('nam', 'output', 'output', -24, 24, 0, 'lin', 'dB')] },
  { id: 'eq7', name: '7-band eq', cat: 'eq', blurb: 'graphic equaliser: seven octave bands, 100 Hz to 6.4 kHz', accent: '#b9c98a', stereo: false, knobs: [
    K('eq7', 'b100', '100', -15, 15, 0, 'lin', 'dB'), K('eq7', 'b200', '200', -15, 15, 0, 'lin', 'dB'),
    K('eq7', 'b400', '400', -15, 15, 0, 'lin', 'dB'), K('eq7', 'b800', '800', -15, 15, 0, 'lin', 'dB'),
    K('eq7', 'b1600', '1.6k', -15, 15, 0, 'lin', 'dB'), K('eq7', 'b3200', '3.2k', -15, 15, 0, 'lin', 'dB'),
    K('eq7', 'b6400', '6.4k', -15, 15, 0, 'lin', 'dB'), K('eq7', 'level', 'level', -12, 12, 0, 'lin', 'dB')] },
  { id: 'comp2', name: 'compressor', cat: 'dynamics', blurb: 'studio compressor: threshold, ratio, knee, RMS detector', accent: '#d9a441', stereo: false, knobs: [
    K('comp2', 'thr', 'threshold', -50, 0, -26, 'lin', 'dB'), K('comp2', 'ratio', 'ratio', 1.5, 20, 4, 'log'),
    K('comp2', 'attack', 'attack', 0.001, 0.1, 0.015, 'log', 's'), K('comp2', 'release', 'release', 0.02, 1.5, 0.25, 'log', 's'),
    K('comp2', 'knee', 'knee', 0, 18, 6, 'lin', 'dB'), K('comp2', 'makeup', 'make-up', 0, 24, 0, 'lin', 'dB'),
    K('comp2', 'mix', 'mix', 0, 1, 1)] },
  { id: 'envfilter', name: 'envelope filter', cat: 'filter', blurb: 'auto-wah: your picking sweeps a resonant filter', accent: '#e0a458', stereo: false, knobs: [
    K('envfilter', 'sens', 'sensitivity', 0, 1, 0.5), K('envfilter', 'freq', 'frequency', 60, 800, 150, 'log', 'Hz'),
    K('envfilter', 'range', 'range', 1, 6, 4, 'lin', 'oct'), K('envfilter', 'reson', 'resonance', 0, 1, 0.6),
    K('envfilter', 'decay', 'decay', 0.02, 0.8, 0.15, 'log', 's'), K('envfilter', 'type', 'type', 0, 2, 1, 'enum', undefined, ENV_TYPES),
    K('envfilter', 'dir', 'direction', 0, 1, 0, 'enum', undefined, ENV_DIRS), K('envfilter', 'level', 'level', -12, 12, 0, 'lin', 'dB')] },
  { id: 'pitch', name: 'pitch shifter', cat: 'modulation', blurb: 'octaves and harmonies, up or down · blend with your dry note', accent: '#9fd0c4', stereo: false, knobs: [
    K('pitch', 'shift', 'shift', -12, 12, 12, 'int', 'st'), K('pitch', 'fine', 'fine', -50, 50, 0, 'lin', 'ct'),
    K('pitch', 'mix', 'mix', 0, 1, 0.5), K('pitch', 'level', 'level', -12, 12, 0, 'lin', 'dB')] },
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
/**
 * The interface reference: the level (dBFS) at which the audio interface
 * reads a 1 V peak, so that an external input (the plugin's track, the
 * browser's interface or a recorded DI file) reaches the rack in volts, as a
 * pickup would put them on an amp's input. Most interfaces at their minimum
 * (calibrated) preamp gain read 1 V peak at about -13 dBFS (Neural DSP's
 * reference; measured -12.9 to -15.1 dBFS on Apollo, Scarlett, Clarett, Duet,
 * Quad Cortex). The demo guitar is already in volts and skips it. Appended
 * after the slots so every older parameter keeps its index; not part of a rig.
 */
PARAMS.push(P('iface', 'interface: 1 V peak reads', 'rig', -24, 0, -13, 'lin', 'dBFS'));
export const P_IFACE = PARAMS.length - 1;
export const NPARAMS = PARAMS.length;

export type ParamId = string;
export type ParamValues = Record<ParamId, number>;

export const PARAM_BY_ID: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((p) => [p.id, p]));
export const PARAM_INDEX: Record<string, number> = Object.fromEntries(PARAMS.map((p, i) => [p.id, i]));

/** Not part of a rig: the volume and the interface reference stay where you left them when you change rigs. */
export const NOT_IN_RIG = ['volume', 'iface'];

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
  if (p.unit === 'dBFS') return `${v < -0.05 ? '−' : ''}${Math.abs(v).toFixed(1)} dBFS`;
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
  { name: 'Glass Porch', tag: 'clean', inGain: 5, rack: [gate(),
    amp({ channel: 0, gain: 0.38, bass: 0.45, mid: 0.55, treble: 0.62, presence: 0.5, master: 0.3, sag: 0.2, cab: 1, mic: 0.25 }),
    { m: 'spring', v: { decay: 2.2, mix: 0.24 } }] },
  { name: 'Sunday Set', tag: 'clean', inGain: 7, rack: [gate(), { m: 'comp', v: { sustain: 0.35, blend: 0.7 } },
    amp({ channel: 0, gain: 0.42, bass: 0.5, mid: 0.6, treble: 0.5, presence: 0.35, master: 0.35, cab: 2, mic: 0.45 }),
    { m: 'hall', v: { decay: 1.6, size: 0.4, mix: 0.16 } }] },
  { name: 'Chime Line', tag: 'clean', rack: [gate(),
    amp({ channel: 3, gain: 0.4, bass: 0.38, mid: 0.45, treble: 0.68, presence: 0.55, master: 0.4, sag: 0.3, cab: 4, mic: 0.15 }),
    { m: 'echo', v: { time: 0.33, fb: 0.22, mix: 0.18, tone: 0.6 } }, { m: 'spring', v: { mix: 0.18 } }] },
  { name: 'Surf Drip', tag: 'clean', inGain: 3, rack: [gate(), { m: 'spring', v: { decay: 3.2, mix: 0.42, tone: 0.65 } },
    amp({ channel: 0, gain: 0.48, bass: 0.4, mid: 0.45, treble: 0.7, presence: 0.55, master: 0.45, cab: 1, mic: 0.2 }),
    { m: 'trem', off: true, v: { rate: 5.5, depth: 0.55 } }] },
  { name: 'Velvet Room', tag: 'clean', inGain: 11, rack: [gate(),
    amp({ channel: 0, gain: 0.7, bass: 0.62, mid: 0.5, treble: 0.3, presence: 0.15, master: 0.3, cab: 3, mic: 0.5 }),
    { m: 'hall', v: { decay: 1.2, size: 0.35, mix: 0.14, tone: 0.3 } }] },
  { name: 'Eighties Wash', tag: 'clean', rack: [gate(), { m: 'comp', v: { sustain: 0.6, attack: 0.004 } },
    amp({ channel: 0, gain: 0.35, bass: 0.42, mid: 0.4, treble: 0.65, presence: 0.6, master: 0.3, cab: 2, mic: 0.2 }),
    { m: 'chorus', v: { rate: 0.8, depth: 0.55, mix: 0.5, tone: 0.65 } }, { m: 'echo', v: { time: 0.42, fb: 0.3, mix: 0.2, ping: 1, wow: 0.1 } },
    { m: 'hall', v: { decay: 3, mix: 0.2 } }] },
  { name: 'Country Snap', tag: 'clean', rack: [gate(), { m: 'comp', v: { sustain: 0.7, attack: 0.002, release: 0.15, level: -4 } },
    amp({ channel: 0, gain: 0.3, bass: 0.4, mid: 0.38, treble: 0.72, presence: 0.6, master: 0.4, sag: 0.15, cab: 2, mic: 0.1 }),
    { m: 'echo', v: { time: 0.12, fb: 0.12, mix: 0.2, tone: 0.7, wow: 0.05 } }, { m: 'spring', v: { mix: 0.12 } }] },
  { name: 'Wobble Porch', tag: 'clean', inGain: 7, rack: [gate(),
    amp({ channel: 0, gain: 0.5, bass: 0.45, mid: 0.5, treble: 0.58, presence: 0.45, master: 0.4, cab: 1, mic: 0.3 }),
    { m: 'trem', v: { rate: 4.2, depth: 0.6, shape: 0.25 } }, { m: 'spring', v: { decay: 2.6, mix: 0.25 } }] },
  // ---------------------------------------------------------------- crunch
  { name: 'Edge of Breakup', tag: 'crunch', rack: [gate(),
    amp({ channel: 0, gain: 0.68, bass: 0.45, mid: 0.5, treble: 0.65, presence: 0.55, master: 0.85, sag: 0.55, cab: 2, mic: 0.35 }),
    { m: 'eq', v: { level: 10 } },
    { m: 'spring', v: { mix: 0.15 } }] },
  { name: 'Back Room Blues', tag: 'crunch', inGain: 6, rack: [gate(), { m: 'glow', v: { gain: 0.48, tone: 0.5, level: 0 } },
    amp({ channel: 0, gain: 0.29, bass: 0.45, mid: 0.45, treble: 0.6, master: 0.6, sag: 0.5, cab: 2, mic: 0.4, presence: 0.5 }),
    { m: 'spring', v: { decay: 1.8, mix: 0.16 } }] },
  { name: 'Plexi Afternoon', tag: 'crunch', inGain: 6, rack: [gate(),
    amp({ channel: 1, gain: 0.55, bass: 0.5, mid: 0.6, treble: 0.82, presence: 0.7, master: 0.55, sag: 0.45, cab: 3, mic: 0.3 }),
    { m: 'hall', v: { decay: 1.4, size: 0.4, mix: 0.12 } }] },
  { name: 'Garage Door', tag: 'crunch', rack: [gate(), { m: 'rasp', v: { gain: 0.35, tone: 0.55, level: -4.5 } },
    amp({ channel: 1, gain: 0.3, bass: 0.55, mid: 0.62, treble: 0.55, master: 0.5, cab: 3, mic: 0.45, presence: 0.4 })] },
  { name: 'Gaffer Tape', tag: 'crunch', rack: [gate(), { m: 'glow', v: { gain: 0.23, tone: 0.6, level: 0 } },
    amp({ channel: 1, gain: 0.47, bass: 0.45, mid: 0.75, treble: 0.8, presence: 0.65, master: 0.5, cab: 2, mic: 0.3 }),
    { m: 'echo', v: { time: 0.12, fb: 0.1, mix: 0.2, tone: 0.4 } }] },
  { name: 'Top Boost', tag: 'crunch', inGain: 6, rack: [gate(),
    amp({ channel: 3, gain: 0.4, bass: 0.4, mid: 0.4, treble: 0.82, presence: 0.45, master: 0.8, sag: 0.5, cab: 4, mic: 0.3 }),
    { m: 'eq', v: { level: 12 } },
    { m: 'spring', v: { mix: 0.14 } }] },
  // ---------------------------------------------------------------- lead
  { name: 'Solo Ridge', tag: 'lead', rack: [gate(), { m: 'glow', v: { gain: 0.54, tone: 0.55, level: 0 } },
    amp({ channel: 1, gain: 0.42, bass: 0.45, mid: 0.68, treble: 0.75, presence: 0.5, master: 0.55, sag: 0.5, cab: 3, mic: 0.35 }),
    { m: 'echo', v: { time: 0.42, fb: 0.32, mix: 0.22 } }, { m: 'hall', v: { decay: 2.4, mix: 0.18 } }] },
  { name: 'Singing Sustain', tag: 'lead', rack: [gate(),
    amp({ channel: 2, gain: 0.32, bass: 0.42, mid: 0.8, treble: 0.6, presence: 0.45, master: 0.6, sag: 0.6, cab: 3, mic: 0.4 }),
    { m: 'echo', v: { time: 0.48, fb: 0.38, mix: 0.24, tone: 0.35 } }, { m: 'hall', v: { decay: 3, mix: 0.2 } }] },
  { name: 'Night Drive', tag: 'lead', rack: [gate(), { m: 'glow', v: { gain: 0.73, tone: 0.4, level: 0 } },
    amp({ channel: 1, gain: 0.35, bass: 0.5, mid: 0.75, treble: 0.55, master: 0.5, cab: 2, mic: 0.55, presence: 0.5 }),
    { m: 'echo', v: { time: 0.56, fb: 0.45, mix: 0.28, wow: 0.55, ping: 1 } }, { m: 'hall', v: { decay: 4, mix: 0.22 } }] },
  { name: 'Violin Swell', tag: 'lead', rack: [gate(-70),
    amp({ channel: 2, gain: 0.3, bass: 0.35, mid: 0.6, treble: 0.48, presence: 0.4, master: 0.65, cab: 2, mic: 0.7 }),
    { m: 'echo', v: { time: 0.6, fb: 0.5, mix: 0.3, tone: 0.3 } }, { m: 'hall', v: { decay: 5, mix: 0.3 } }] },
  { name: 'Phase Lead', tag: 'lead', inGain: 6, rack: [gate(), { m: 'phaser', v: { rate: 0.3, depth: 0.75, fb: 0.5, mix: 0.5 } },
    amp({ channel: 1, gain: 0.9, bass: 0.48, mid: 0.5, treble: 0.75, presence: 0.7, master: 0.65, sag: 0.5, cab: 3, mic: 0.35 }),
    { m: 'eq', v: { level: 5.5 } },
    { m: 'echo', v: { time: 0.38, fb: 0.3, mix: 0.2 } }] },
  // ---------------------------------------------------------------- heavy
  { name: 'Riff Engine', tag: 'heavy', rack: [gate(-55), { m: 'glow', v: { gain: 0.04, tone: 0.6, level: 0 } },
    amp({ channel: 2, gain: 0.72, bass: 0.6, mid: 0.65, treble: 0.5, presence: 0.45, master: 0.5, sag: 0.3, cab: 3, mic: 0.3 })] },
  { name: 'Tight Chug', tag: 'heavy', rack: [gate(-50, 0.04), { m: 'glow', v: { gain: 0, tone: 0.65, level: 0 } },
    amp({ channel: 2, gain: 0.76, bass: 0.55, mid: 0.55, treble: 0.82, presence: 0.5, master: 0.55, sag: 0.2, cab: 3, mic: 0.2 }),
    { m: 'eq', v: { lomid: -3, himid: 2 } }] },
  { name: 'Wall of Stacks', tag: 'heavy', rack: [gate(-56), { m: 'rasp', v: { gain: 0.45, tone: 0.45, level: -6 } },
    amp({ channel: 2, gain: 0.3, bass: 0.65, mid: 0.7, treble: 0.75, master: 0.55, sag: 0.45, cab: 3, mic: 0.45, presence: 0.5 }),
    { m: 'hall', v: { decay: 1.2, size: 0.4, mix: 0.1 } }] },
  { name: 'Doom Hall', tag: 'heavy', rack: [gate(-58),
    amp({ channel: 2, gain: 0.6, bass: 0.75, mid: 0.6, treble: 0.6, presence: 0.25, master: 0.45, sag: 0.7, cab: 3, mic: 0.6 }),
    { m: 'hall', v: { decay: 4.5, mix: 0.2, tone: 0.3 } }] },
  // ---------------------------------------------------------------- fuzz
  { name: 'Sputter', tag: 'fuzz', rack: [{ m: 'fuzz', v: { gain: 0.6, tone: 0.55, level: -27 } },
    amp({ channel: 0, gain: 0.4, bass: 0.5, mid: 0.75, treble: 0.7, master: 0.3, cab: 2, mic: 0.35, presence: 0.6 })] },
  { name: 'Wool Coat', tag: 'fuzz', rack: [{ m: 'fuzz', v: { gain: 0.9, tone: 0.3, level: -21 } },
    amp({ channel: 1, gain: 0.3, bass: 0.6, mid: 0.65, treble: 0.65, master: 0.3, sag: 0.6, cab: 3, mic: 0.5, presence: 0.6 }),
    { m: 'hall', v: { decay: 2, mix: 0.14 } }] },
  { name: 'Velcro', tag: 'fuzz', rack: [
    amp({ channel: 0, gain: 0.15, master: 0.4, cab: 0, mid: 0.5, treble: 0.5, presence: 0.4 }), { m: 'fuzz', v: { gain: 1, tone: 0.75, level: -26 } },
    { m: 'eq', v: { bass: -4, mid: 3, treble: -6 } }] },
  { name: 'Fuzz Wobble', tag: 'fuzz', rack: [{ m: 'fuzz', v: { gain: 0.75, tone: 0.5, level: -23 } },
    amp({ channel: 0, gain: 0.3, bass: 0.5, mid: 0.7, treble: 0.7, master: 0.6, cab: 1, mic: 0.4, presence: 0.6 }),
    { m: 'trem', v: { rate: 6.5, depth: 0.7, shape: 0.8 } }, { m: 'spring', v: { mix: 0.18 } }] },
  // ---------------------------------------------------------------- ambient
  { name: 'Tape Ghosts', tag: 'ambient', inGain: 11, rack: [gate(),
    amp({ channel: 0, gain: 0.5, treble: 0.45, master: 0.35, cab: 2, mic: 0.55 }),
    { m: 'echo', v: { time: 0.7, fb: 0.62, tone: 0.3, wow: 0.8, mix: 0.4, ping: 1 } }, { m: 'hall', v: { decay: 6, mix: 0.38, tone: 0.4 } }] },
  { name: 'Cathedral Clean', tag: 'ambient', inGain: 5, rack: [gate(),
    amp({ channel: 0, gain: 0.32, bass: 0.42, treble: 0.58, master: 0.3, cab: 2, mic: 0.3 }),
    { m: 'echo', v: { time: 0.45, fb: 0.4, mix: 0.22, ping: 1 } }, { m: 'hall', v: { decay: 8, size: 1, mix: 0.5, tone: 0.55, shimmer: 0.35 } }] },
  { name: 'Wet Wire', tag: 'ambient', rack: [gate(), { m: 'glow', v: { gain: 0.6, tone: 0.45, level: 0 } },
    { m: 'echo', v: { time: 0.3, fb: 0.7, tone: 0.5, wow: 0.4, mix: 0.35 } },
    amp({ channel: 1, gain: 0.4, mid: 0.6, master: 0.45, cab: 2, mic: 0.4 }), { m: 'spring', v: { decay: 2.6, mix: 0.25 } }] },
  { name: 'Slow Orbit', tag: 'ambient', rack: [gate(), { m: 'comp', v: { sustain: 0.55, level: 3 } },
    amp({ channel: 3, gain: 0.35, bass: 0.45, treble: 0.55, master: 0.35, cab: 4, mic: 0.4 }),
    { m: 'phaser', v: { rate: 0.12, depth: 0.8, fb: 0.3, stages: 2, spread: 1, mix: 0.5 } },
    { m: 'chorus', v: { rate: 0.25, depth: 0.7, mix: 0.4 } }, { m: 'echo', v: { time: 0.62, fb: 0.5, mix: 0.3, ping: 1, wow: 0.5 } },
    { m: 'hall', v: { decay: 7, size: 0.9, mix: 0.4, shimmer: 0.5 } }] },
  // ---------------------------------------------------------------- pickup-matched rigs
  // The first three are voiced for a single coil (a strat): a little more input than the demo guitar's humbucker needs, and the guitar tone module first, rolled back like the tone knob. With a humbucker, take the input knob to 0.
  // a singing, smooth lead on a pushed plexi: the tape echo goes in front of the drive (fast playing squashes the repeats, held notes let them bloom), a tube overdrive with its tone low, the brown channel (a plexi on a variac, so it sags and compresses) with the treble and presence nearly off, the compressor after the amp, an EQ rounding the top, a light chorus and a small plate. Play the bridge pickup with the guitar's tone at 6 or 7.
  { name: 'Copper Kite', tag: 'lead', inGain: 2, rack: [{ m: 'gtone', v: { tone: 0.51 } }, gate(),
    { m: 'echo', v: { time: 0.4, fb: 0.22, mix: 0.3, tone: 0.5, wow: 0.15 } },
    { m: 'glow', v: { gain: 0.54, tone: 0.25, level: 0 } },
    amp4({ channel: 3, gain: 0.42, bass: 0.5, mid: 0.75, treble: 0.5, presence: 0.2, master: 0.3, sag: 0.6, cab: 3, mic: 0.35 }),
    { m: 'comp', v: { sustain: 0.5, attack: 0.01, release: 0.3, blend: 0.9 } },
    { m: 'eq', v: { bass: 2, lomid: 2.5, mid: 1, treble: -3, level: -2 } },
    { m: 'chorus', v: { rate: 0.45, depth: 0.3, mix: 0.2, tone: 0.6 } },
    { m: 'plate', v: { decay: 1.4, tone: 0.55, mix: 0.12 } }] },
  // a long, sustained, creamy lead: a compressor into a fat muff into a big, tight amp that does the compressing, the mids put back with an EQ, a slow echo and a big hall (flanger waiting, bypassed)
  { name: 'Slow Ember', tag: 'lead', inGain: 2, rack: [{ m: 'gtone', v: { tone: 0.51 } }, gate(-58), { m: 'comp', v: { sustain: 0.55, attack: 0.006, release: 0.3, level: 2 } },
    { m: 'muff', v: { gain: 0.4, tone: 0.38, level: -8 } },
    amp2({ channel: 1, gain: 0.3, bass: 0.5, mid: 0.8, treble: 0.62, presence: 0.6, master: 0.5, sag: 0.45, cab: 5, mic: 0.4 }),
    { m: 'eq', v: { lomid: 2, mid: 3, treble: -1 } },
    { m: 'flanger', off: true, v: { rate: 0.2, depth: 0.6, manual: 0.4, regen: 0.5, mix: 0.45 } },
    { m: 'echo', v: { time: 0.42, fb: 0.28, mix: 0.22, tone: 0.4, wow: 0.2 } }, { m: 'hall', v: { decay: 3.5, size: 0.7, mix: 0.2, tone: 0.45 } }] },
  // a tight, dry, compressed clean for funky rhythm: slow attack so the pick cluck gets through, a hi-watt on the edge, a hint of room
  { name: 'Chalk Line', tag: 'clean', inGain: 2, rack: [{ m: 'gtone', v: { tone: 0.51 } }, gate(-60, 0.05), { m: 'comp', v: { sustain: 0.6, attack: 0.012, release: 0.12, level: -2 } },
    amp2({ channel: 1, gain: 0.3, bass: 0.4, mid: 0.5, treble: 0.45, presence: 0.4, master: 0.45, sag: 0.2, cab: 3, mic: 0.3 }),
    { m: 'flanger', off: true, v: { rate: 0.3, depth: 0.5, manual: 0.35, regen: 0.4, mix: 0.4 } },
    { m: 'hall', v: { decay: 0.8, size: 0.3, mix: 0.08 } }] },
  // ---------------------------------------------------------------- built from the newer components
  // a gritty blues: an overdrive that keeps the clean signal under it into a class A tweed that compresses, in a small room
  { name: 'Brass Rail', tag: 'crunch', inGain: 2, rack: [{ m: 'gtone', v: { tone: 0.51 } }, gate(), { m: 'transparent', v: { gain: 0.3, tone: 0.6, level: -12 } },
    amp2({ channel: 0, gain: 0.38, bass: 0.5, mid: 0.75, treble: 0.65, presence: 0.55, master: 0.6, sag: 0.6, cab: 6, mic: 0.4 }),
    { m: 'room', v: { size: 0.35, decay: 0.45, mix: 0.16 } }] },
  // a tight modern chug: a distortion used as a booster in front of a four-stage amp and a v30 cabinet
  { name: 'Iron Orchard', tag: 'heavy', rack: [gate(-52, 0.04), { m: 'metal', v: { gain: 0.3, tone: 0.45, level: -7 } },
    amp3({ channel: 2, gain: 0.3, bass: 0.45, mid: 0.6, treble: 0.68, presence: 0.22, master: 0.6, sag: 0.35, cab: 7, mic: 0.3 }),
    { m: 'room', v: { size: 0.25, decay: 0.35, mix: 0.1 } }] },
  // funk: a compressor, then a wah that the pick plays, into a clean hi-watt and a short plate
  { name: 'Pocket Wah', tag: 'clean', rack: [gate(-60, 0.05), { m: 'comp', v: { sustain: 0.5, attack: 0.012, release: 0.15, level: 0 } },
    { m: 'wah', v: { pos: 0.5, auto: 0.8, reson: 0.55, level: -5 } },
    amp2({ channel: 1, gain: 0.4, bass: 0.4, mid: 0.55, treble: 0.55, presence: 0.5, master: 0.45, sag: 0.2, cab: 3, mic: 0.3 }),
    { m: 'plate', v: { decay: 0.9, tone: 0.6, mix: 0.1 } }] },
  // classic rock lead: an overdrive pushing a brit 800, a slapback-ish echo and a plate
  { name: 'Slate Roof', tag: 'lead', rack: [{ m: 'gtone', v: { tone: 0.51 } }, gate(), { m: 'transparent', v: { gain: 0.2, tone: 0.6, level: -9.5 } },
    amp3({ channel: 0, gain: 0.4, bass: 0.45, mid: 0.6, treble: 0.65, presence: 0.58, master: 0.5, sag: 0.4, cab: 5, mic: 0.35 }),
    { m: 'echo', v: { time: 0.38, fb: 0.25, mix: 0.16 } }, { m: 'plate', v: { decay: 1.6, tone: 0.65, mix: 0.16 } }] },
  // a slow flanger and a ping-pong echo into a long plate
  { name: 'Glass Tide', tag: 'ambient', rack: [gate(), { m: 'transparent', v: { gain: 0.15, tone: 0.5, level: -14 } },
    amp2({ channel: 2, gain: 0.3, bass: 0.4, mid: 0.5, treble: 0.5, master: 0.4, cab: 5, mic: 0.3 }),
    { m: 'flanger', v: { rate: 0.12, depth: 0.7, manual: 0.5, regen: 0.55, mix: 0.4 } },
    { m: 'echo', v: { time: 0.52, fb: 0.5, mix: 0.3, ping: 1, wow: 0.4 } }, { m: 'plate', v: { decay: 4, tone: 0.6, mix: 0.35 } }] },
  // wah into a fuzz into a tweed: the classic order
  { name: 'Dust Bowl', tag: 'fuzz', rack: [{ m: 'wah', v: { pos: 0.35, auto: 0.45, reson: 0.6 } }, { m: 'boost', v: { gain: 0.2, tone: 0.15, level: -5 } },
    { m: 'muff', v: { gain: 0.45, tone: 0.36, level: -8 } },
    amp2({ channel: 0, gain: 0.5, bass: 0.5, mid: 0.6, treble: 0.5, master: 0.55, sag: 0.55, cab: 6, mic: 0.4, presence: 0.5 }),
    { m: 'room', v: { size: 0.5, decay: 0.6, mix: 0.22 } }] },
  // a blackface with the headroom of a twin, a rotating speaker and a short plate
  { name: 'Spin Cycle', tag: 'clean', inGain: 10, rack: [gate(-62), { m: 'comp', v: { sustain: 0.35, attack: 0.012, release: 0.2, blend: 0.7, level: 1 } },
    amp4({ channel: 0, gain: 0.45, bass: 0.45, mid: 0.5, treble: 0.4, presence: 0.3, master: 0.45, sag: 0.15, cab: 8, mic: 0.3 }),
    { m: 'rotary', v: { speed: 0.3, depth: 0.7, mix: 0.85 } }, { m: 'plate', v: { decay: 1.2, tone: 0.65, mix: 0.14 } }] },
  // an octave fuzz into a variac plexi with a vibe: swirl and bark
  { name: 'Purple Lens', tag: 'fuzz', rack: [{ m: 'gtone', v: { tone: 0.51 } }, { m: 'octave', v: { gain: 0.4, tone: 0.4, level: 0 } },
    amp4({ channel: 3, gain: 0.65, bass: 0.5, mid: 0.35, treble: 0.5, presence: 0.5, master: 0.3, sag: 0.6, cab: 3, mic: 0.35 }),
    { m: 'vibe', v: { rate: 0.9, depth: 0.8, mode: 0 } }, { m: 'spring', v: { decay: 2.2, mix: 0.2 } }] },
  // a different delay on each side (375 ms left, 500 ms right, three to four) with a little cross-feed, into a long plate
  { name: 'Two Clocks', tag: 'ambient', inGain: 9, rack: [gate(-62), { m: 'comp', v: { sustain: 0.3, attack: 0.012, release: 0.25, level: 1 } },
    amp4({ channel: 0, gain: 0.4, bass: 0.45, mid: 0.5, treble: 0.4, presence: 0.3, master: 0.45, sag: 0.15, cab: 8, mic: 0.3 }),
    { m: 'sdelay', v: { timeL: 0.375, timeR: 0.5, fbL: 0.35, fbR: 0.4, cross: 0.35, tone: 0.5, mod: 0.2, mix: 0.3 } },
    { m: 'plate', v: { decay: 2.6, tone: 0.6, mix: 0.22 } }] },
  // fitted to a recording of a strat's neck pickup through a favourite Logic preset: a dark, mid-forward, sustained tone (little above 4 kHz). A hi-watt, the gain up, the treble and presence nearly off and a 3.6 kHz high cut; the low cut at 80 Hz (it was 220 Hz, which left 82-110 Hz 14-19 dB down: thin by design) with the bass up, and the master set so the power stage works (sustain). No compressor, so the pick attack stays open. The stereo delay and the room are on top of the dry tone
  { name: 'Neck Glow', tag: 'lead', inGain: 6, rack: [{ m: 'gtone', v: { tone: 0.44 } }, gate(),
    amp2({ channel: 1, gain: 1, bass: 0.55, mid: 0.65, treble: 0.1, presence: 0.1, master: 0.35, sag: 0.45, cab: 6, mic: 0.3, lowcut: 80, highcut: 3600 }),
    { m: 'sdelay', v: { timeL: 0.375, timeR: 0.5, fbL: 0.3, fbR: 0.3, cross: 0.3, tone: 0.4, mod: 0.15, mix: 0.2 } },
    { m: 'room', v: { size: 0.4, decay: 0.5, mix: 0.14 } }] },
  // ---------------------------------------------------------------- after famous tones (the pickup is a single coil unless the note says otherwise)
  // the neck pickup into a boosted Mesa Boogie, smooth and singing with lots of sustain, a slow echo and a big hall
  { name: 'Amber Sky', tag: 'lead', inGain: 1, rack: [{ m: 'gtone', v: { tone: 0.55 } }, gate(-60), { m: 'comp', v: { sustain: 0.35, attack: 0.012, release: 0.3 } },
    amp2({ channel: 2, gain: 0.69, bass: 0.42, mid: 0.65, treble: 0.5, presence: 0.5, master: 0.5, sag: 0.4, cab: 3, mic: 0.35 }),
    { m: 'echo', v: { time: 0.46, fb: 0.3, mix: 0.2, tone: 0.4, wow: 0.15 } }, { m: 'hall', v: { decay: 3, size: 0.7, mix: 0.2, tone: 0.5 } }] },
  // a Big Muff into a Hiwatt, the mids lifted, a dotted echo and a hall
  { name: 'Pewter Hymn', tag: 'lead', inGain: 1, rack: [{ m: 'gtone', v: { tone: 0.61 } }, gate(-58), { m: 'muff', v: { gain: 0.55, tone: 0.38, level: -8 } },
    amp2({ channel: 1, gain: 0.3, bass: 0.42, mid: 0.6, treble: 0.55, presence: 0.45, master: 0.5, sag: 0.3, cab: 3, mic: 0.3 }),
    { m: 'eq', v: { lomid: 1.5, mid: 2, himid: 1 } },
    { m: 'echo', v: { time: 0.44, fb: 0.35, mix: 0.22, tone: 0.45, wow: 0.2 } }, { m: 'hall', v: { decay: 3.5, size: 0.8, mix: 0.22, tone: 0.5 } }] },
  // a fuzz first in the rack so it loads the pickup, then a cranked plexi and a short spring (roll the guitar's volume back to clean it)
  { name: 'Violet Smoke', tag: 'fuzz', inGain: 1.2, rack: [{ m: 'fuzz', v: { gain: 0.65, tone: 0.55, level: -23 } }, { m: 'gtone', v: { tone: 0.66 } },
    amp({ channel: 1, gain: 0.3, bass: 0.42, mid: 0.65, treble: 0.7, presence: 0.55, master: 0.78, sag: 0.45, cab: 3, mic: 0.3 }),
    { m: 'eq', v: { level: 8.5 } },
    { m: 'spring', v: { decay: 1.8, mix: 0.14 } }] },
  // a Tube Screamer into a loud blackface, spring reverb
  { name: 'Low Water', tag: 'crunch', inGain: 3, rack: [{ m: 'gtone', v: { tone: 0.63 } }, gate(-62), { m: 'glow', v: { gain: 0.48, tone: 0.55, level: -4 } },
    amp4({ channel: 0, gain: 0.45, bass: 0.42, mid: 0.55, treble: 0.55, presence: 0.4, master: 0.55, sag: 0.4, cab: 8, mic: 0.3 }),
    { m: 'spring', v: { decay: 2, mix: 0.2 } }] },
  // Van Halen's brown sound: a plexi on a variac, a phaser and an echo (the flanger is waiting, bypassed)
  { name: 'Bronze Ladder', tag: 'lead', inGain: 6, rack: [gate(-56), { m: 'phaser', v: { rate: 0.5, depth: 0.7, fb: 0.35, mix: 0.4 } },
    amp4({ channel: 3, gain: 0.55, bass: 0.42, mid: 0.65, treble: 0.65, presence: 0.5, master: 0.65, sag: 0.5, cab: 3, mic: 0.3 }),
    { m: 'flanger', off: true, v: { rate: 0.2, depth: 0.7, manual: 0.35, regen: 0.55, mix: 0.45 } },
    { m: 'echo', v: { time: 0.32, fb: 0.28, mix: 0.18, tone: 0.5 } }, { m: 'plate', v: { decay: 1.8, tone: 0.65, mix: 0.16 } }] },
  // a chiming AC30 and a dotted-eighth delay on one side, a quarter on the other
  { name: 'Dotted Light', tag: 'clean', inGain: 1.2, rack: [{ m: 'gtone', v: { tone: 1 } }, gate(-62), { m: 'comp', v: { sustain: 0.35, attack: 0.01, release: 0.25, level: 1 } },
    amp({ channel: 3, gain: 0.3, bass: 0.42, mid: 0.5, treble: 0.65, presence: 0.55, master: 0.6, sag: 0.3, cab: 4, mic: 0.2 }),
    { m: 'sdelay', v: { timeL: 0.375, timeR: 0.5, fbL: 0.4, fbR: 0.3, cross: 0.15, tone: 0.6, mod: 0.15, mix: 0.3 } }, { m: 'plate', v: { decay: 1.8, tone: 0.65, mix: 0.12 } }] },
  // Knopfler: a clean, compressed blackface, a hint of spring
  { name: 'Soft Gravel', tag: 'clean', inGain: 1.2, rack: [{ m: 'gtone', v: { tone: 0.66 } }, gate(-64), { m: 'comp', v: { sustain: 0.45, attack: 0.012, release: 0.2, level: 1 } },
    amp4({ channel: 0, gain: 0.55, bass: 0.42, mid: 0.5, treble: 0.5, presence: 0.4, master: 0.5, sag: 0.25, cab: 8, mic: 0.3 }),
    { m: 'spring', v: { decay: 1.8, mix: 0.14 } }] },
  // the neck humbucker with the tone knob almost off into a hot plexi, thick and vocal
  { name: 'Rain Voice', tag: 'lead', inGain: 1, rack: [{ m: 'gtone', v: { tone: 0 } }, gate(-60), { m: 'comp', v: { sustain: 0.4, attack: 0.01, release: 0.3 } },
    amp({ channel: 2, gain: 0.3, bass: 0.42, mid: 0.75, treble: 0.7, presence: 0.6, master: 0.6, sag: 0.4, cab: 3, mic: 0.4 }),
    { m: 'spring', v: { decay: 1.8, mix: 0.12 } }] },
  // a lead for a single coil (a strat): the classic boost-into-a-Marshall recipe. The overdrive keeps the lows tight and puts a mid hump in front; the 800 sits at moderate gain so soft notes still sing and hard ones don't fizz; the EQ adds body at 200-400 Hz; echo and hall behind. Chosen by search for saturation at both a weak and a strong note, body under 300 Hz, a lift near 3 kHz and little at 5 kHz
  { name: 'Quicksilver', tag: 'lead', inGain: 4, rack: [gate(-60), { m: 'glow', v: { gain: 0.48, tone: 0.5, level: 0 } },
    amp3({ channel: 0, gain: 0.34, bass: 0.5, mid: 0.6, treble: 0.5, presence: 0.5, master: 0.55, sag: 0.4, cab: 5, mic: 0.35 }),
    { m: 'eq', v: { lomid: 2 } },
    { m: 'echo', v: { time: 0.38, fb: 0.3, mix: 0.2, tone: 0.45, wow: 0.15 } }, { m: 'hall', v: { decay: 2.4, size: 0.6, mix: 0.16, tone: 0.5 } }] },
  // funk: the envelope filter in front of a clean amp, so the quack follows the pick
  { name: 'Quack Shop', tag: 'clean', inGain: 14, rack: [gate(), { m: 'comp', v: { sustain: 0.5, attack: 0.004 } },
    { m: 'envfilter', v: { sens: 0.5, freq: 140, range: 4, reson: 0.65, decay: 0.12, type: 1, dir: 0, level: 8 } },
    amp({ channel: 0, gain: 0.3, bass: 0.45, mid: 0.45, treble: 0.6, presence: 0.5, master: 0.4, cab: 2, mic: 0.3 })] },
  // a dry note and the octave above it, into a clean amp and a hall
  { name: 'Twelve Strings', tag: 'ambient', inGain: 7, rack: [gate(), { m: 'pitch', v: { shift: 12, mix: 0.4, level: 0 } },
    amp({ channel: 0, gain: 0.3, bass: 0.42, mid: 0.4, treble: 0.62, presence: 0.55, master: 0.35, cab: 2, mic: 0.25 }),
    { m: 'hall', v: { decay: 2.8, size: 0.6, mix: 0.25, tone: 0.5 } }] },
];

