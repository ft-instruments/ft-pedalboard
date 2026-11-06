# ft-pedalboard
PEDALBOARD: a free guitar rack in the browser and as a VST3/AU/standalone plugin: pick components from a library (gate, compressor, eight drives (glow, rasp, fuzz, muff, boost, transparent, metal, octave), fourteen named tube amps (clean stack, plexi, hot plexi, chime combo, tweed combo, hi-watt, boutique combo, brit 800, rectified, modern high-gain, blackface combo, tweed champ, orange stack, brown plexi) with cabinets, a guitar tone/volume module, EQ, wah, chorus, phaser, vibe, flanger, rotary, tremolo, tape echo, spring, hall, plate, room), stack up to eight in any order, with the signal drawn as a live cable down the rack.

- Type: FT-Instrument
- Kind: web
- Status: active
- Version: package.json + `project(... VERSION x.y.z)` in plugin/CMakeLists.txt
- Build: `npm run build`   Test: `npm run render -- test` (DSP + rack checks), `npm run render` (every rig: levels, NaNs, CPU), `npm run check` and `npm run check:plugin` (headless Chrome, after build), `npm run null-test` (C++ vs TS)   Run: `npm run dev`
- Ships to: browser (Vite dev server); VST3/AU/standalone via `plugin/` (`plugin/build.sh` installs for this user; GitHub Actions builds macOS, Windows, Linux)

First slice of proposal 04 (`~/Documents/GitHub/.claude/proposals/04-ft-pedalboard-guitar-amps-effects.md`): a small library done properly, laid out like a Guitar Rig rack.

## Commands
- `npm run dev` / `build` / `typecheck`
- `npm run render -- test`: rigs resolve, rack edits (move/insert/remove/pack/copy-out), tuner accuracy (< 1 ct, 41 Hz to 1 kHz), tone-stack scoop, every module with every knob at both ends, a full rack maxed, module swaps while playing, silence stays silent.
- `npm run render`: every rig through the three demo loops; prints peak/RMS dBFS and CPU, fails on NaN or a peak over +3.5 dBFS. Use it to keep rigs within a few dB of each other.
- `npm run render -- wav "<rig>" [strum|riff|lick] [seconds]`: writes out/<rig>-<loop>.wav to listen to. Delete it afterwards.
- `npm run check`: power, demo audio, live input (Chrome's fake device), tuner, rack edits and drag-and-drop, footswitch keys, rig save/delete, phone width and the library drawer; writes out/screenshot-*.png (delete them).
- `npm run check:plugin` (after build): the page in plugin mode against a fake JUCE bridge; writes out/screenshot-plugin.png (delete it).
- `plugin/build.sh`: `npm run gen` (plugin/Source/dsp/Params.gen.h from params.ts), the web UI, the JUCE build, installed for this user. `npm run null-test`: renders every rig with the TS and the C++ engine and subtracts (< -80 dB or it is a porting bug; it currently nulls completely).

## Layout
- `src/dsp/`: the engine (no browser APIs, no allocation after construction, no enums or TS parameter properties: the scripts run under Node's type stripping).
  - `params.ts`: the module library (`MODULES`, each with its knob list), the flat host parameter list (inGain, heat, volume, then per slot `sNtype`, `sNon`, `sNk1..k10` stored 0..1 and mapped through the module's knob defs), and the rigs (`RIGS`, written as module ids + real knob values; `rigValues()` flattens them).
  - `engine.ts`: 16 slots in order (`NSLOTS`; the slot parameters are the last in the flat list, so raising it only appends host parameters; `MAX_KNOBS` is 12, and parameter ids `sNkM` never change, so adding knobs adds ids and leaves the old ones alone). Each slot owns one instance of every module (two of the mono ones), so changing a slot's module never allocates. On/off is a 15 ms crossfade with the dry signal; swapping one module for another dips the slot to silence and back (crossfading through dry let a maxed fuzz skip the amp). Mono until the first stereo module (chorus, phaser, flanger, echo, spring, hall). `snap()` settles every slot without fades (fresh start, offline renders).
  - modules: `gate.ts`, `comp.ts`, `drive.ts` (glow/rasp/fuzz/muff/boost/transparent/metal/octave: one class, `driveKind()` in params.ts maps a module to its circuit), `amp.ts` (a voicing table: clean/crunch/lead/chime for the `amp` module, then tweed/hi-watt/boutique, voicings 4..6, for `amp2`, then brit 800/rectified/modern, voicings 7..9, for `amp3`, then blackface/champ/orange/brown (a plexi on a variac), voicings 10..13, for `amp4`; each voicing is its own module, `M_AMP_FIRST`..`M_AMP_LAST` (`isAmp()`), and the four older `amp`..`amp4` modules stay, hidden from the library, so saved rigs load (the rig helpers `amp()`..`amp4()` in params.ts map a channel onto the named unit); triode stages with grid-current bias shift, `tonestack.ts` Yeh's closed-form stack, push-pull or class A power with sag), `cab.ts` (biquad speaker+mic, inside the amp unit, then `CabCut`: the named amps' low cut and high cut, bypassed at 20 Hz / 12 kHz; `amp2` and `amp3` have more cabinets than `amp`, so their cabinet knobs have their own lists), `eq.ts`, `wah.ts` (band-pass, by hand or by the pick's envelope), `mod.ts` (chorus, phaser, flanger, vibe, rotary, tremolo), `delay.ts` tape echo and the stereo delay (two lines with their own time, repeats and level; the cross-feed moves the repeats between sides, and the input enters the left alone at full cross), `spring.ts` dispersive spring tank, `reverb.ts` hall (from ft-mycelia; the plate and room modules are voicings of the same network and share the slot's hall instance), `tuner.ts` YIN, `demo.ts` synthetic DI guitar.
  - Drive and amp run at 8x oversampling (`OS` in util.ts); 4x left the fuzz aliasing at -32 dB on a 2.8 kHz tone.
- `src/rack.ts`: rack edits on parameter values (insert, remove, move, pack, toRig). The rack is kept packed; units are addressed by slot, positions by chain index.
- `src/worklet/`: `processor.ts` picks the input (interface / demo / file) and posts per-slot meters; `protocol.ts` holds the messages so the page doesn't bundle the worklet class.
- `src/ui/`: `spine.ts` the cable down the rack (click a socket to switch), `viz.ts` the faceplate pictures per module, `stage.ts` the living background, `controls.ts` the family's knob code.
- `src/main.ts`: header, library (rigs / components, drag or click to add), the rack; `src/plugin.ts` is the page's end of the plugin bridge (the host owns audio; the input is the track or the demo guitar). `src/settings.ts`: localStorage `ft-pedalboard.*`, sanitised on read (not used inside the plugin: the session and a user-rigs file keep everything).
- `plugin/Source/dsp/`: the C++ port (header-only: Util, Blocks, Mod, Space, Tuner, Demo, Engine; `Params.gen.h` generated). `plugin/Source/Plugin{Processor,Editor}.*`: an audio effect (mono or stereo in, stereo out), host parameters, factory rigs as programs, and the WebView editor (resizable; the page reflows and the rack scrolls). `plugin/Tools/render.cpp` is the C++ half of the null test.

## Conventions
- Levels are in volts: the demo DI peaks around 0.1-0.3, like a passive pickup. Keep the input path honest so the drive knobs mean the same with a real guitar.
- Judged by feel: no added latency (the chain has none beyond the oversampling filters); the browser's own round trip is shown in the header.
- Keep web and C++ DSP in parity: any change under src/dsp/ is ported to plugin/Source/dsp/ (and params.ts changes need `npm run gen`), and `npm run null-test` must still pass.
- A new module: add it to `MODULES` (append, never reorder: the index is the saved `sNtype` value), give it a case in both engines' `Slot.reset` and `module()`, a picture in viz.ts, and checks follow automatically (render test runs every module at its knob extremes).

- A voicing's gain range should sweep from clean-ish to saturated across the gain knob: check with the dynamic-range test (output at 0.2 V minus output at 0.02 V: ~20 dB is clean, ~0 is fully saturated). The classic lead channel's first stage was cut from 6 to 2 for this reason.
- `src/doctor.ts`: the tone doctor ("too bright", "too dirty", ...): complaints as lists of nudges on knobs by name and module category. A new knob that should respond to a complaint is one line in its table.
