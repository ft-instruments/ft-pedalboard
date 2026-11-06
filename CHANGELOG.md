# Changelog

## Unreleased

### Changed
- Copper Kite, Slow Ember, Chalk Line, Brass Rail, Iron Orchard, Slate Roof, Dust Bowl, Purple Lens and Spin Cycle: less gain, less treble and presence (the factory leads sit near 0 dB at 2-4 kHz against 0.5-2 kHz, these 2-5 dB under it). The first three lead with a rolled-back guitar tone and 2 dB of input.
- Classic amp, lead channel: the first stage's gain floor is 2 (was 6), so the gain knob changes how it breaks up and not only how loud it is. The first stages of the newer boutique, brit 800, rectified and modern voicings were set the same way.

### Added
- Input meter target zone: the input meter shows a green band (peaks of 0.1 to 0.4 V, where a passive pickup and the demo guitar sit), a held peak marker, and a hint under it (quiet, a little low, good level, hot, too hot) that says which way to turn the input knob.
- *stereo delay*: a different delay on each side (time, repeats and level for left and right), a cross-feed from independent delays to a ping-pong, tone, modulation and drive; its picture draws where the repeats really land on each side. One rig (Two Clocks).
- Low cut and high cut on every named amp's cabinet (a second-order high-pass from 20 to 300 Hz and a fourth-order low-pass from 12 kHz down to 2.5 kHz; off at the ends, so nothing changes until you turn them). Units now have up to 12 knobs.
- Tone doctor: a button in the rack bar with *too bright / dark / dirty / clean / thin / muddy*. Each press moves the right knobs on whatever is in the rack a little (treble, presence, mic, high cut, drive gain, bass, low cut, EQ bands...) and says what moved; undo puts the rack back.
- Sixteen slots (was eight).
- *guitar tone*: the tone and volume knobs of the guitar as a rack unit (a passive low-pass that rolls off from 7 kHz to 500 Hz, and a volume that cleans up and keeps its highs), for putting first in the rack.
- The amps are now fourteen units with their own names (clean stack, plexi, hot plexi, chime combo, tweed combo, hi-watt, boutique combo, brit 800, rectified, modern high-gain, blackface combo, tweed champ, orange stack, brown plexi), each with a cabinet list of nine. The four earlier amp units (with a channel knob) stay for saved rigs but are hidden from the library.
- Modelled on what Logic Pro's Pedalboard and Amp Designer cover: *vibe* (Uni-Vibe type: four-stage photocell phaser, chorus or vibrato), *rotary* (rotating-speaker cabinet: horn and drum with doppler, swirl and inertia), *octave* (Octavia-type rectifier fuzz) and *vintage amp* (blackface, champ, orange and brown, a plexi on a variac) with two more cabinets (4x10 blackface, 1x8 small). Two more rigs (Spin Cycle, Purple Lens).
- Six more components: *transparent* (Klon-style overdrive that keeps the clean signal underneath), *metal* (tight three-stage distortion with a mid scoop), *high-gain amp* (brit 800, rectified, modern channels; a 4x12 v30 cabinet), *plate* and *room* reverbs (voicings of the hall's feedback network), and *wah* (band-pass swept by hand or by the pick's envelope). Appended to the library; a new `filter` category holds the wah.
- Four new components: *muff* (sustaining fuzz: two clipping stages and the scooping passive tone control), *boost* (treble booster with a focus control), *flanger* (bucket-brigade jet sweep, stereo), and *specialty amp* (the existing amp is now labelled *classic amp*; ids unchanged), a second amp unit with three more voicings (tweed, hi-watt, boutique) and two more cabinets (4x12 greenback, 1x12 tweed). Appended to the library, so saved rigs and host sessions are unaffected.
- Six rigs built around the newer components: Brass Rail (tweed blues), Iron Orchard (tight modern chug), Pocket Wah (funk), Slate Roof (brit 800 lead), Glass Tide (flanger, ping-pong echo, long plate) and Dust Bowl (wah into a fuzz into a tweed).
- Three rigs voiced for a single coil: a compressed singing lead (Copper Kite), a sustained fuzz lead (Slow Ember) and a tight, dry funk clean (Chalk Line).
- The rack: a library of 13 components and eight slots in any order, laid out as faceplates; add by drag or click, move by drag or ▲▼, fold, remove. The spine (the signal's cable) runs down the rack.
- New components: compressor ("squeeze"), five-band EQ, chorus, phaser, tremolo, and a *chime* amp channel (top-boost stack, class A power) with a 2x12 alnico cabinet; the hall gains size and shimmer knobs.
- 31 rigs (7 new) using the new components.
- VST3 / AU / standalone plugin (`plugin/`): a line-for-line C++ port of the engine that nulls against the web version, the web UI as its editor, factory rigs as host programs, three-platform CI.
- First playable rig: gate, drive (glow / rasp / fuzz), three-channel tube amp with the exact tone-stack circuit and sag, cabinets with a movable mic, tape echo, spring and hall reverb, all at 8x oversampling where nonlinear.
- The wire: the chain drawn as a live patch cable; drag to reorder, click to switch (since replaced by the rack and the spine).
- Tuner, heat macro, input from an interface, a built-in demo guitar or a dropped file.
- 24 rigs in six categories; save, copy and delete your own.
