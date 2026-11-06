# PEDALBOARD

A free guitar rack that runs in the browser, and as a VST3 / AU plugin and a
standalone app. Plug a guitar into your audio interface, or play the built-in
demo guitar. Pick components from the library and stack up to sixteen of them
in any order, the way you would in Guitar Rig: a rack of faceplates, each with
its own knobs and a live picture of what it's doing.

**The library**

| | |
|---|---|
| dynamics | **gate** (hysteresis and hold), **squeeze** (compressor with blend) |
| drive | **glow** (diodes in the op-amp's feedback loop), **rasp** (op-amp into hard diodes, with its bandwidth and slew limits), **fuzz** (two starved germanium transistors) |
| amp | triode stages whose bias shifts when the grids conduct, the real bass/middle/treble tone-stack circuit, push-pull or class A power with supply sag, and a speaker cabinet with a movable mic. Channels: *clean*, *crunch*, *lead*, *chime* |
| eq | five bands |
| modulation | **chorus** (stereo), **phaser** (4/6/8 stages, stereo spread), **tremolo** |
| delay | **tape echo** with wow, flutter, a saturating loop and ping-pong |
| reverb | **spring** (the dispersive drip), **hall** (with shimmer) |

Drag a component into the rack, or click it to add it at the end. Drag a unit
by its handle (or use ▲▼) to move it. A spring in front of the amp and a fuzz
after it both work. Click the lamp to switch a unit on or off. 43 rigs to start
from, and you can save your own.

**The spine.** A cable runs down the left of the rack from *in* to *out*. Each
stretch lights up with the level leaving the unit above it, and it runs from
cold steel through amber to white as the drives and amps work harder. You can
see your gain staging. Click a socket to switch its unit.

Also: a tuner in the header (click it to mute while you tune), a **heat**
knob that pushes every drive and amp together, and a file you can drop in to
loop as the input.

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

## License

AGPL-3.0-only. See [THIRD-PARTY.md](THIRD-PARTY.md).
