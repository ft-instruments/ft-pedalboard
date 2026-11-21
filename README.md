# PEDALBOARD

A free guitar rack that runs in the browser, and as a VST3 / AU plugin and a
standalone app. Plug a guitar into your audio interface, or play the built-in
demo guitar. Pick components from the library and stack up to sixteen of them
in any order: a rack of faceplates, each with its own knobs and a live picture
of what it's doing. Drives, amps and cabinets are solved from their circuits,
not drawn as curves.

**The library** (50 components)

| | |
|---|---|
| dynamics | **gate** (hysteresis and hold), **squeeze** (soft-knee compressor with blend), **compressor** (studio: threshold, ratio, knee, RMS detector) |
| drive | **glow** (diodes in the op-amp's feedback loop), **rasp** (op-amp into hard diodes, with its bandwidth and slew limits), **fuzz** (two starved germanium transistors), **muff** (two clipping stages and a scooped tone stack), **boost** (treble booster), **transparent** (a clean blend under soft germanium clipping), **metal** (tight, three cascaded clippers), **octave** (full-wave rectifier) |
| amp | a classic amp with four channels (*clean*, *crunch*, *lead*, *chime*), three more amps that each hold several voicings, and fourteen single-voicing amps: triode stages whose bias shifts when the grids conduct, real tone-stack circuits, push-pull or class A power with supply sag, and a speaker cabinet with a movable mic |
| capture | **NAM capture** (plugin only): load a Neural Amp Modeler `.nam` file of a real amp or pedal; **cab IR**: load your own cabinet impulse response (a WAV) |
| eq | five-band and seven-band |
| filter | **wah** (set by hand or played by your pick), **envelope filter** (an auto-wah) |
| modulation | **chorus** (bucket brigade, stereo), **phaser** (4/6/8 stages), **tremolo**, **flanger**, **vibe** (photocell phaser, chorus or vibrato), **rotary** (horn and drum), **pitch shifter** (±12 semitones) |
| delay | **tape echo** (wow, flutter, a saturating loop, ping-pong), **stereo delay** (a different delay on each side) |
| reverb | **spring** (the dispersive drip), **hall** (with shimmer), **plate**, **room** |
| guitar | **guitar tone**: the tone and volume knobs on the guitar itself |

Drag a component into the rack, or click it to add it at the end. Drag a unit
by its handle (or use ▲▼) to move it. A spring in front of the amp and a fuzz
after it both work. Click the lamp to switch a unit on or off. 55 rigs to start
from, and you can save your own. **Share** copies a link with the whole rig in
the address (browser only); **export** and **import** use a `.ftrig.json` file.

**The spine.** A cable runs down the left of the rack from *in* to *out*. Each
stretch lights up with the level leaving the unit above it, and it runs from
cold steel through amber to white as the drives and amps work harder. You can
see your gain staging. Click a socket to switch its unit.

Also: a tuner in the header (click it to mute while you tune), a **heat**
knob that pushes every drive and amp together, and a file you can drop in to
loop as the input.

**Levels.** The *interface reference* setting says how loud your interface
reads a guitar (the default is 1 V peak = −13 dBFS, what most interfaces show
at minimum gain); the rack works in volts, so the amps and pedals see the
level they were built for. The input meter shows volts, with a green target
band.

## Run it

```
npm install
npm run dev
```

Press **switch on** (or the power button), and the demo guitar plays through
the first rig. To play your own guitar, choose **guitar in** and allow the
microphone when your browser asks. Pick your interface and the input the guitar is in.
Use headphones if you play through a laptop's built-in mic.

Browser latency depends on your browser, OS and interface. The header shows
the round trip the browser reports.

## Plugin

`plugin/build.sh` builds the VST3, the AU (macOS) and a standalone app, and
installs them for your user (it needs CMake and a C++17 compiler; JUCE is
fetched, or taken from `~/SDKs/JUCE-<tag>`). GitHub Actions builds all three
for macOS, Windows and Linux. In a DAW it is an audio effect: put it on your
guitar track. The input menu also has the demo guitar. Every slot's module,
switch and knobs are host parameters, so any of them can be automated.

## Download

Builds of the VST3, the AU (macOS only) and the standalone app for macOS,
Windows and Linux are attached to each
[release](https://github.com/ft-instruments/ft-pedalboard/releases).

| | Standalone | VST3 | AU |
|---|---|---|---|
| macOS (Apple silicon + Intel) | yes | yes | yes |
| Windows | yes | yes | no |
| Linux | yes | yes | no |

Unzip and copy the plugin to your plugin folder (macOS
`~/Library/Audio/Plug-Ins/{VST3,Components}`, Windows
`C:\Program Files\Common Files\VST3`, Linux `~/.vst3`). The builds are not
signed or notarized: on macOS run `xattr -dr com.apple.quarantine` on the
files you copied (or right-click the app and choose Open the first time); on
Windows SmartScreen asks once. The Windows editor needs the WebView2 runtime
(included in Windows 11); on Linux it needs WebKitGTK.

## Privacy

PEDALBOARD makes no network connections: no telemetry, no update check, no
analytics, no accounts. The fonts are bundled, and the plugin serves its UI
from memory. Your rigs stay in your browser (or in the plugin's session); the
share link carries the rig in the address and goes nowhere on its own.

## NAM and impulse responses

The NAM capture unit runs [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore)
(MIT). No models or impulse responses are included: you load your own files,
and they stay on your machine. Check the terms of any capture or IR you
download. PEDALBOARD is not affiliated with Neural Amp Modeler.

## License

Copyright (C) 2026 Filipe F. Thomaz.

PEDALBOARD is free software under the [GNU AGPL v3](LICENSE). The plugin is
built on [JUCE](https://juce.com), which is itself AGPLv3 (or commercial), so
the whole thing is distributed under the AGPL (the bundled fonts keep their
own [SIL OFL](src/fonts/), and the NAM core and its libraries keep their MIT
and MPL-2.0 licenses; see [THIRD-PARTY.md](THIRD-PARTY.md)): you can use it
for anything, including music you sell, and change it and share it, as long as
a modified version you distribute comes with its source under the same
license.
