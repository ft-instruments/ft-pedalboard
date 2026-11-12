// Plain-language help for every knob, shown in the footer while the pointer
// (or the keyboard focus) is on it.

import type { ModuleDef } from '../dsp/params.ts';

/** By knob id. A module can override with `module.knob` (see below). */
const HINTS: Record<string, string> = {
  sens: 'how easily your playing opens the filter: more reacts to soft notes, less needs a hard pick',
  freq: 'where the filter sits when you are not playing (its closed position)',
  range: 'how far, in octaves, a hard note sweeps the filter up from there',
  type: 'the filter shape: low-pass is round, band-pass is the classic quack, high-pass is thin and sharp',
  dir: 'up opens the filter when you play harder; down closes it',
  shift: 'how far the note moves, in semitones: 12 is an octave up, -12 an octave down',
  fine: 'a small shift in cents on top; with the mix at half it thickens like a detune',
  gain: 'how hard it is pushed: more is crunchier and sings longer, less is cleaner and punchier',
  level: 'the volume coming out of this unit, so you can match it to the rest of the rack',
  tone: 'darker to the left, brighter to the right',
  bass: 'the low end: more is fatter, less is tighter',
  mid: 'the middle, where the guitar sits: more is forward and honky, less is scooped',
  treble: 'the top end: more is bite and sparkle, turn it down if it sounds harsh or fizzy',
  presence: 'the very top, after the power tubes: adds air and bite; turn it down for a smoother sound',
  master: 'how hard the power tubes work: higher is looser, more compressed and more distorted',
  sag: 'how much the power supply sags when you dig in: more is squishier and bloomier',
  cab: 'the speaker cabinet the amp plays through; "off" skips it',
  mic: 'where the microphone sits: left is on the cone (bright and forward), right is at the edge (darker, softer)',
  lowcut: 'rolls off the lows below this point: raise it to clear mud',
  highcut: 'rolls off the highs above this point: lower it to tame fizz and harshness',
  channel: 'which preamp voicing to use',
  thr: 'how quiet the signal must get before the gate closes: raise it to cut more noise, lower it if notes get chopped',
  rel: 'how fast the gate lets go after closing: shorter is tighter, longer is smoother',
  sustain: 'how much the compressor squeezes: more makes notes ring longer and evens out your picking',
  attack: 'how quickly it clamps down: slower lets the pick attack through',
  release: 'how quickly it lets go after a note',
  blend: 'mixes the squeezed sound with your dry sound: lower keeps more of your dynamics',
  mix: 'how much of the effect is blended in with your dry sound',
  rate: 'how fast it moves',
  depth: 'how far it moves',
  fb: 'how much of the effect is fed back in: more gives more repeats or a stronger, more resonant sweep',
  stages: 'more stages give a deeper, more complicated sweep',
  spread: 'how different the left and right sweeps are: wider swirl at the top',
  manual: 'where the sweep sits: low is a deep jet, high is a thin sizzle',
  regen: 'feeds the sound back into the flanger for a stronger, more metallic sweep',
  shape: 'from a smooth sine wobble to a hard on-and-off chop',
  time: 'the gap between repeats',
  wow: 'tape wobble: a little adds warmth and age, a lot is seasick',
  ping: 'bounces the repeats between left and right',
  decay: 'how long the space rings out',
  size: 'how big the space is',
  shimmer: 'adds a soft octave-up glow to the tail',
  pos: 'the heel-to-toe position of the pedal: low is dark and woofy, high is bright and nasal',
  auto: 'lets your picking move the wah: hit harder and it opens more',
  reson: 'how sharp and vocal the wah peak is',
  speed: 'from a slow, gentle swirl to a fast, choppy spin; it speeds up and slows down gradually like the real thing',
  mode: 'chorus mixes the swirl with your dry sound, vibrato is the wobble alone',
  volume: 'your guitar\'s volume knob: roll it back to clean up and keep the highs',
  timeL: 'the delay on the left side',
  timeR: 'the delay on the right side',
  fbL: 'repeats on the left side',
  fbR: 'repeats on the right side',
  cross: 'how much each side feeds the other: 0 keeps them separate, all the way up is a ping-pong',
  mod: 'a little wobble on the repeats, like a chorus',
  levelL: 'volume of the left repeats',
  levelR: 'volume of the right repeats',
  drive: 'a soft saturation in the repeats: warmer and grittier as it rises',
  inGain: 'match your guitar here: watch the meter and keep the peaks in the green band',
  heat: 'pushes every drive and amp harder or softer together, without touching their own knobs',
};

/** The hint for a knob; the same id can mean different things in different units. */
const OVERRIDES: Record<string, string> = {
  'eq.bass': 'boosts or cuts around 100 Hz: the weight of the sound',
  'eq.lomid': 'boosts or cuts around 400 Hz: cut it to clear mud',
  'eq.mid': 'boosts or cuts around 1 kHz: the body of the guitar',
  'eq.himid': 'boosts or cuts around 2.5 kHz: the bite and the harshness',
  'eq.treble': 'boosts or cuts around 6 kHz: the air and the fizz',
  'eq.level': 'the volume after the EQ',
  'echo.fb': 'how many repeats: higher goes on longer',
  'phaser.fb': 'feeds the sweep back in for a sharper, more resonant sound',
  'chorus.tone': 'darker to the left, brighter to the right: darker sounds older',
  'gate.level': 'the volume after the gate',
};

export function hintFor(moduleId: string, knobId: string): string {
  return OVERRIDES[`${moduleId}.${knobId}`] ?? HINTS[knobId] ?? '';
}

