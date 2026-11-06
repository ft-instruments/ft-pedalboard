// The rack. C++ port of src/dsp/engine.ts: input gain and tuner, NSLOTS
// slots in order (each owning one instance of every module, built up front),
// then the volume. Switching a unit crossfades it with its input over 15 ms;
// swapping one module for another dips the slot to silence and back. Mono
// until the first stereo module. No allocation after construction.
#pragma once

#include <memory>
#include "Params.gen.h"
#include "Blocks.h"
#include "Mod.h"
#include "Space.h"
#include "Tuner.h"

namespace pedalboard {

inline double fromNorm(const ParamDef& p, double t) {
  t = std::min(1.0, std::max(0.0, t));
  double v = p.scale == Scale::Log ? p.min * std::pow(p.max / p.min, t) : p.min + (p.max - p.min) * t;
  if (p.scale == Scale::Int || p.scale == Scale::Enum || p.scale == Scale::Bool) v = jsRound(v);
  return v;
}

inline double toNorm(const ParamDef& p, double v) {
  v = std::min(p.max, std::max(p.min, v));
  if (p.scale == Scale::Log) return std::log(v / p.min) / std::log(p.max / p.min);
  return (v - p.min) / (p.max - p.min);
}

constexpr int STAGE_STRIDE = MAX_STAGES + 1;

/** Which circuit of the drive pedal a module runs (0 glow, 1 rasp, 2 fuzz, 3 muff, 4 boost), or -1. */
inline int driveKind(int m) {
  return m >= M_GLOW && m <= M_FUZZ ? m - M_GLOW : m == M_MUFF ? DRIVE_MUFF : m == M_BOOST ? DRIVE_BOOST
    : m == M_TRANSPARENT ? DRIVE_TRANSPARENT : m == M_METAL ? DRIVE_METAL : m == M_OCTAVE ? DRIVE_OCTAVE : -1;
}
/** Any amp unit: the four older ones and the fourteen named ones. */
inline bool isAmpModule(int m) { return m == M_AMP || m == M_AMP2 || m == M_AMP3 || m == M_AMP4 || (m >= M_AMP_CLEAN && m <= M_AMP_BROWN); }
/** The first voicing of an amp module's channels in VOICINGS. */
inline int ampVoicingBase(int m) { return m == M_AMP2 ? AMP_TWEED : m == M_AMP3 ? AMP_BRIT : m == M_AMP4 ? AMP_BLACKFACE : 0; }

class Slot {
public:
  int type = M_NONE;
  double fade = 0, level = 1;
  double real[MAX_KNOBS] = {};
  Gate gate[2]; Comp comp[2]; Drive drive[2]; Amp amp[2]; Cab cab[2]; CabCut cut[2]; Eq eq[2]; Wah wah[2]; Vibe vibe[2]; GuitarTone gtone[2];
  Chorus chorus; Phaser phaser; Flanger flanger; Rotary rotary; Tremolo trem; TapeEcho echo; StereoDelay sdelay; SpringTank spring; Hall hall;

  explicit Slot(double fs)
    : gate { Gate(fs), Gate(fs) }, comp { Comp(fs), Comp(fs) }, drive { Drive(fs), Drive(fs) }, amp { Amp(fs), Amp(fs) },
      cab { Cab(fs), Cab(fs) }, cut { CabCut(fs), CabCut(fs) }, eq { Eq(fs), Eq(fs) }, wah { Wah(fs), Wah(fs) }, vibe { Vibe(fs), Vibe(fs) }, gtone { GuitarTone(fs), GuitarTone(fs) }, chorus(fs), phaser(fs), flanger(fs), rotary(fs), trem(fs), echo(fs), sdelay(fs), spring(fs), hall(fs) {}

  void reset() {
    for (int c = 0; c < 2; c++) {
      if (isAmpModule(type)) { amp[c].reset(); cab[c].reset(); cut[c].reset(); continue; }
      switch (type) {
        case M_GATE: gate[c].reset(); break;
        case M_COMP: comp[c].reset(); break;
        case M_GLOW: case M_RASP: case M_FUZZ: case M_MUFF: case M_BOOST: case M_TRANSPARENT: case M_METAL: case M_OCTAVE: drive[c].reset(); break;
        case M_WAH: wah[c].reset(); break;
        case M_VIBE: vibe[c].reset(); break;
        case M_GTONE: gtone[c].reset(); break;
        case M_EQ: eq[c].reset(); break;
        default: break;
      }
    }
    switch (type) {
      case M_CHORUS: chorus.reset(); break;
      case M_PHASER: phaser.reset(); break;
      case M_FLANGER: flanger.reset(); break;
      case M_ROTARY: rotary.reset(); break;
      case M_ECHO: echo.reset(); break;
      case M_SDELAY: sdelay.reset(); break;
      case M_SPRING: spring.reset(); break;
      case M_HALL: case M_PLATE: case M_ROOM: hall.clear(); break;
      default: break;
    }
  }

  void resetAll() {
    for (int c = 0; c < 2; c++) { gate[c].reset(); comp[c].reset(); drive[c].reset(); amp[c].reset(); cab[c].reset(); cut[c].reset(); eq[c].reset(); wah[c].reset(); vibe[c].reset(); gtone[c].reset(); }
    chorus.reset(); phaser.reset(); flanger.reset(); rotary.reset(); echo.reset(); sdelay.reset(); spring.reset(); hall.clear();
  }
};

class Engine {
public:
  static constexpr int SCOPE = 512;
  static constexpr double FADE_S = 0.015;

  double values[NUM_PARAMS];
  Tuner tuner;
  bool muted = false;

  double peakIn = 0, peakL = 0, peakR = 0;
  float slotPeak[NSLOTS] = {}, slotHeat[NSLOTS] = {}, slotLive[NSLOTS] = {};
  float stageHeat[NSLOTS * STAGE_STRIDE] = {};
  float scope[SCOPE] = {};

  explicit Engine(double sampleRate)
    : tuner(sampleRate), fs(sampleRate), inGain(1, sampleRate, 20), outGain(1, sampleRate, 20) {
    for (int s = 0; s < NSLOTS; s++) slots[s] = std::make_unique<Slot>(sampleRate);
    for (int i = 0; i < NUM_PARAMS; i++) values[i] = PARAMS[i].def;
    inGain.jump(dbToGain(values[P_INGAIN]));
    outGain.jump(volumeGain());
  }

  void setParam(int i, double value) {
    if (i < 0 || i >= NUM_PARAMS || !std::isfinite(value)) return;
    const ParamDef& p = PARAMS[i];
    values[i] = value < p.min ? p.min : value > p.max ? p.max : value;
  }

  /** A rig: the defaults plus its values; the volume stays where it is. */
  void loadPreset(const Preset& pr) {
    for (int i = 0; i < NUM_PARAMS; i++) if (i != P_VOLUME) values[i] = PARAMS[i].def;
    for (int k = 0; k < pr.count; k++) setParam(pr.values[k].id, pr.values[k].value);
  }

  void reset() { for (auto& s : slots) s->resetAll(); }

  /** Every slot straight into its settled state (no fades). */
  void snap() {
    for (int s = 0; s < NSLOTS; s++) {
      Slot& slot = *slots[s];
      const int base = SLOT_BASE + s * SLOT_STRIDE;
      int want = (int)jsRound(values[base]);
      if (want < 0 || want >= NMODULES) want = M_NONE;
      if (want != slot.type) { slot.type = want; slot.reset(); }
      slot.fade = want != M_NONE && values[base + 1] >= 0.5 ? 1 : 0;
      slot.level = 1;
    }
    inGain.jump(dbToGain(values[P_INGAIN]));
    outGain.jump(muted ? 0 : volumeGain());
  }

  /** `input` mono (volts), into stereo L/R. Any n. */
  void process(const float* input, float* L, float* R, int n) {
    for (int off = 0; off < n; off += MAX_BLOCK) {
      const int m = std::min(MAX_BLOCK, n - off);
      run(input + off, L + off, R + off, m);
    }
  }

private:
  double volumeGain() const { const double v = values[P_VOLUME]; return v * v * 2; }

  static void copy(const float* from, float* to, int n) { std::copy(from, from + n, to); }

  void run(const float* input, float* L, float* R, int n) {
    const double* vals = values;
    inGain.set(dbToGain(vals[P_INGAIN]));
    double pin = 0;
    for (int i = 0; i < n; i++) {
      const double v = input[i] * inGain.tick();
      inBuf[i] = (float)v; L[i] = (float)v;
      const double a = std::abs(v); if (a > pin) pin = a;
    }
    peakIn = pin;
    tuner.push(inBuf, n);

    const double heatMul = std::pow(2.0, (vals[P_HEAT] - 0.5) * 4);
    bool stereo = false;
    const double fadeStep = n / (FADE_S * fs);
    for (int s = 0; s < NSLOTS; s++) {
      Slot& slot = *slots[s];
      const int base = SLOT_BASE + s * SLOT_STRIDE;
      int want = (int)jsRound(vals[base]);
      if (want < 0 || want >= NMODULES) want = M_NONE;
      const bool on = vals[base + 1] >= 0.5;
      if (want != slot.type) {
        if (slot.fade <= 0 || slot.level <= 0) {
          const bool dipped = slot.level <= 0;
          slot.type = want; slot.reset();
          if (dipped) slot.fade = on && want != M_NONE ? 1 : 0;
        }
      }
      const bool settled = want == slot.type;
      const int type = slot.type;
      if (settled) {
        const ModuleDef& md = MODULES[type];
        for (int k = 0; k < md.numKnobs; k++) slot.real[k] = fromNorm(md.knobs[k], vals[base + 2 + k]);
      }
      const bool dip = !settled && want != M_NONE;
      const bool fadeIn = settled ? on && type != M_NONE : dip;
      const double f0 = slot.fade;
      const double f1 = fadeIn ? std::min(1.0, f0 + fadeStep) : std::max(0.0, f0 - fadeStep);
      slot.fade = f1;
      const double l0 = slot.level;
      const double l1 = dip ? std::max(0.0, l0 - fadeStep) : std::min(1.0, l0 + fadeStep);
      slot.level = l1;
      if (f0 == 0 && f1 == 0) {
        slotHeat[s] = (float)(slotHeat[s] * 0.9);
      } else {
        if (MODULES[type].stereo && !stereo) { copy(L, R, n); stereo = true; }
        const bool crossfade = f0 < 1 || f1 < 1;
        if (crossfade) { copy(L, dryL, n); if (stereo) copy(R, dryR, n); }
        module(s, slot, L, R, n, stereo, heatMul);
        if (crossfade) {
          for (int i = 0; i < n; i++) {
            const double g = f0 + (f1 - f0) * ((double)i / n);
            L[i] = (float)(dryL[i] + ((double)L[i] - dryL[i]) * g);
            if (stereo) R[i] = (float)(dryR[i] + ((double)R[i] - dryR[i]) * g);
          }
        }
      }
      if (l0 < 1 || l1 < 1) {
        for (int i = 0; i < n; i++) {
          const double g = l0 + (l1 - l0) * ((double)i / n);
          L[i] = (float)(L[i] * g);
          if (stereo) R[i] = (float)(R[i] * g);
        }
      }
      double pk = 0;
      for (int i = 0; i < n; i++) { const double a = std::abs((double)L[i]); if (a > pk) pk = a; }
      slotPeak[s] = (float)pk;
    }
    if (!stereo) copy(L, R, n);

    outGain.set(muted ? 0 : volumeGain());
    double pl = 0, pr = 0;
    int si = scopeIdx;
    for (int i = 0; i < n; i++) {
      const double g = outGain.tick();
      double l = L[i] * g, r = R[i] * g;
      if (!(l == l) || !(r == r)) { l = 0; r = 0; }
      L[i] = (float)l; R[i] = (float)r;
      const double al = std::abs(l), ar = std::abs(r);
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      scope[si] = (float)((l + r) * 0.5); si = (si + 1) % SCOPE;
    }
    scopeIdx = si;
    peakL = pl; peakR = pr;
  }

  void module(int s, Slot& slot, float* L, float* R, int n, bool stereo, double heatMul) {
    const double* r = slot.real;
    const int chans = stereo ? 2 : 1;
    double heat = 0, live = 0;
    if (isAmpModule(slot.type)) {
      // the older amps have a channel knob in front (knob 0); the named ones don't
      const bool legacy = slot.type < M_AMP_CLEAN;
      const int o = legacy ? 1 : 0;
      const int voicing = legacy ? ampVoicingBase(slot.type) + (int)jsRound(r[0]) : slot.type - M_AMP_CLEAN;
      const int cab = (int)jsRound(r[o + 7]);
      for (int c = 0; c < chans; c++) {
        float* x = c ? R : L;
        slot.amp[c].process(x, n, voicing, r[o], r[o + 1], r[o + 2], r[o + 3], r[o + 4], r[o + 5], r[o + 6], heatMul);
        if (cab > 0) slot.cab[c].process(x, n, cab - 1, r[o + 8]);
        if (!legacy) slot.cut[c].process(x, n, r[9], r[10]);
      }
      const float* sh = slot.amp[0].stageHeat;
      double h = 0;
      for (int k = 0; k < STAGE_STRIDE; k++) { stageHeat[s * STAGE_STRIDE + k] = sh[k]; if (sh[k] > h) h = sh[k]; }
      slotHeat[s] = (float)std::min(1.0, std::log2(1 + h) / 6);
      slotLive[s] = (float)slot.amp[0].sagDepth;
      return;
    }
    switch (slot.type) {
      case M_GTONE:
        for (int c = 0; c < chans; c++) slot.gtone[c].process(c ? R : L, n, r[0], r[1]);
        break;
      case M_GATE:
        for (int c = 0; c < chans; c++) slot.gate[c].process(c ? R : L, n, r[0], r[1]);
        heat = slot.gate[0].reduction; live = slot.gate[0].level;
        break;
      case M_COMP:
        for (int c = 0; c < chans; c++) slot.comp[c].process(c ? R : L, n, r[0], r[1], r[2], r[3], r[4]);
        live = slot.comp[0].reduction; heat = std::min(1.0, live / 18);
        break;
      case M_GLOW: case M_RASP: case M_FUZZ: case M_MUFF: case M_BOOST: case M_TRANSPARENT: case M_METAL: case M_OCTAVE: {
        const double pre = std::sqrt(heatMul);
        for (int c = 0; c < chans; c++) {
          float* x = c ? R : L;
          for (int i = 0; i < n; i++) x[i] = (float)(x[i] * pre);
          slot.drive[c].process(x, n, driveKind(slot.type), r[0], r[1], r[2]);
        }
        heat = std::min(1.0, std::log2(1 + slot.drive[0].push) / 5); live = slot.drive[0].peakIn;
        break;
      }
      case M_EQ:
        for (int c = 0; c < chans; c++) {
          slot.eq[c].set(r[0], r[1], r[2], r[3], r[4]);
          slot.eq[c].process(c ? R : L, n, r[5]);
        }
        break;
      case M_CHORUS:
        slot.chorus.process(L, R, n, r[0], r[1], r[2], r[3]);
        live = slot.chorus.phase; heat = r[3] * r[1];
        break;
      case M_PHASER:
        slot.phaser.process(L, R, n, r[0], r[1], r[2], (int)jsRound(r[3]), r[4], r[5]);
        live = slot.phaser.phase; heat = r[5] * r[1];
        break;
      case M_FLANGER:
        slot.flanger.process(L, R, n, r[0], r[1], r[2], r[3], r[4]);
        live = slot.flanger.phase; heat = r[4] * r[1];
        break;
      case M_TREM:
        slot.trem.process(L, R, n, stereo, r[0], r[1], r[2]);
        live = slot.trem.phase; heat = r[1];
        break;
      case M_ECHO:
        slot.echo.process(L, R, n, r[0], r[1], r[2], r[3], r[4], r[5] >= 0.5);
        live = slot.echo.level; heat = std::min(1.0, live * 2);
        break;
      case M_SDELAY:
        slot.sdelay.process(L, R, n, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]);
        live = slot.sdelay.level; heat = std::min(1.0, live * 2);
        break;
      case M_SPRING:
        slot.spring.process(L, R, n, r[0], r[1], r[2]);
        live = slot.spring.level; heat = std::min(1.0, live * 3);
        break;
      case M_HALL:
        slot.hall.process(L, R, n, r[1], r[0], r[2], r[3], r[4]);
        heat = r[4];
        break;
      case M_PLATE:
        slot.hall.process(L, R, n, 0.02, r[0], r[1], 0, r[2]);
        heat = r[2];
        break;
      case M_ROOM:
        slot.hall.process(L, R, n, r[0] * 0.3, r[1], r[2], 0, r[3]);
        heat = r[3];
        break;
      case M_VIBE:
        for (int c = 0; c < chans; c++) slot.vibe[c].process(c ? R : L, n, r[0], r[1], r[2]);
        live = slot.vibe[0].phase; heat = r[1];
        break;
      case M_ROTARY:
        slot.rotary.process(L, R, n, r[0], r[1], r[2]);
        live = slot.rotary.phase; heat = r[1] * r[2];
        break;
      case M_WAH:
        for (int c = 0; c < chans; c++) slot.wah[c].process(c ? R : L, n, r[0], r[1], r[2], r[3]);
        live = slot.wah[0].pos; heat = r[1];
        break;
      default: break;
    }
    slotHeat[s] = (float)heat;
    slotLive[s] = (float)live;
  }

  double fs;
  std::unique_ptr<Slot> slots[NSLOTS];
  float dryL[MAX_BLOCK] = {}, dryR[MAX_BLOCK] = {}, inBuf[MAX_BLOCK] = {};
  Smooth inGain, outGain;
  int scopeIdx = 0;
};

} // namespace pedalboard
