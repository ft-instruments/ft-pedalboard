# Changelog

## Unreleased

## [0.1.0] - 2026-11-21

First public release.

### Added
- A guitar rack: up to sixteen of 50 components in any order, each a faceplate with its own knobs and a live picture, with the signal drawn as a cable down the left that runs from cold steel to white as the level rises. 55 rigs to start from, and you can save your own.
- Drives built from their circuits: *glow*, *rasp*, *fuzz*, *muff*, *boost*, *transparent*, *metal*, *octave*, each with its own bandwidth limits inside the gain stages, exact solves of the clipping stages and measured aliasing.
- Amps built stage by stage: triode preamps on their load lines with grid current, real tone-stack circuits, push-pull or class A power stages with supply sag, output-transformer saturation, and speaker cabinets as minimum-phase filters with a movable mic. A four-channel classic amp, three amps that hold several voicings each, and fourteen single-voicing amps.
- *cab IR*: your own cabinet impulse response (a WAV, cut to 2048 taps) convolved directly, with level and mix.
- *NAM capture* (plugin only): loads a Neural Amp Modeler `.nam` file through the MIT-licensed NAM core, with input and output trims and resampling when the model's rate differs from the host's.
- Dynamics (*gate*, *squeeze*, a studio *compressor*), *eq* (five and seven bands), *wah*, *envelope filter*, *guitar tone* (the knobs on the guitar itself).
- Modulation: *chorus*, *phaser*, *tremolo*, *flanger*, *vibe*, *rotary*, *pitch shifter* (±12 semitones). Delay and reverb: *tape echo*, *stereo delay*, *spring*, *hall* with shimmer, *plate*, *room*. Moving delay lines read with 4-point Hermite interpolation.
- Input calibration: an *interface reference* setting (default 1 V peak = −13 dBFS) scales the track, interface or looped file into volts before the rack; the input meter reads volts with a green target band and a clip light.
- A tuner in the header, a *heat* knob that pushes every drive and amp together, and a file you can drop in to loop as the input.
- Rig sharing in the browser: *share* copies a link with the rig in the address, *export* saves a `.ftrig.json`, *import* opens one; a dropped file or a pasted link or JSON also imports. Everything that comes in is checked against the library and clamped.
- VST3, AU (macOS) and standalone builds for macOS (Apple silicon + Intel), Windows and Linux; every slot's module, switch and knobs are host parameters. The C++ engine is null-tested against the TypeScript engine.
- No network connections of any kind.

[Unreleased]: https://github.com/ft-instruments/ft-pedalboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ft-instruments/ft-pedalboard/releases/tag/v0.1.0
