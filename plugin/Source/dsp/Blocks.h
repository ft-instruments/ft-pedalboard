// The mono modules: gate, compressor, the three drives, the tone stack, the
// amp, the cabinet and the EQ. C++ ports of src/dsp/gate.ts, comp.ts,
// drive.ts, tonestack.ts, amp.ts, cab.ts and eq.ts.
//
// Porting convention (as in Util.h): a TS number is a double, a
// Float32Array element is a float; stores round to float exactly where the
// TS stores into a Float32Array.
#pragma once

#include <vector>
#include "Util.h"

namespace pedalboard {

constexpr int MAX_BLOCK = 512;

// ---- gate.ts ---------------------------------------------------------------

class Gate {
public:
  double level = 0, reduction = 0;
  explicit Gate(double sampleRate) : fs(sampleRate) {}
  void reset() { env = 0; gain = 0; open = false; hold = 0; }
  void process(float* x, int n, double thrDb, double release) {
    const double thrOpen = dbToGain(thrDb), thrClose = thrOpen * 0.5;
    const double envRel = std::exp(-1 / (0.03 * fs));
    const double gAtk = 1 - std::exp(-1 / (0.0005 * fs));
    const double gRel = 1 - std::exp(-1 / (release * fs));
    const int holdN = (int)jsRound(0.02 * fs);
    double e = env, g = gain; bool o = open; int h = hold;
    for (int i = 0; i < n; i++) {
      const double a = std::abs((double)x[i]);
      e = a > e ? a : e * envRel;
      if (e > thrOpen) { o = true; h = holdN; }
      else if (e < thrClose) { if (h > 0) h--; else o = false; }
      g += ((o ? 1 : 0) - g) * (o ? gAtk : gRel);
      x[i] = (float)(x[i] * g);
    }
    env = e; gain = g; open = o; hold = h;
    level = e; reduction = 1 - g;
  }
private:
  double env = 0, gain = 0; bool open = false; int hold = 0;
  double fs;
};

// ---- comp.ts ---------------------------------------------------------------

class Comp {
public:
  double reduction = 0;
  explicit Comp(double sampleRate) : fs(sampleRate) {}
  void reset() { env = 0; reduction = 0; }
  void process(float* x, int n, double sustain, double attack, double release, double levelDb, double blend) {
    constexpr double DI_PEAK_DB = -14, MAX_MAKEUP_DB = 18;
    const double thrDb = -12 - 30 * sustain;
    const double ratio = 2 + 8 * sustain;
    const double slope = 1 / ratio - 1;
    const double thr = dbToGain(thrDb);
    const double makeupDb = std::min(MAX_MAKEUP_DB, std::max(0.0, -thrDb + DI_PEAK_DB) * (1 - 1 / ratio));
    const double wet = dbToGain(makeupDb + levelDb) * blend;
    const double dry = (1 - blend) * dbToGain(levelDb);
    const double atk = 1 - std::exp(-1 / (attack * fs));
    const double rel = 1 - std::exp(-1 / (release * fs));
    double e = env, minG = 1;
    for (int i = 0; i < n; i++) {
      const double v = x[i];
      const double a = std::abs(v);
      e += (a - e) * (a > e ? atk : rel);
      const double g = e > thr ? std::exp(slope * std::log(e / thr)) : 1;
      if (g < minG) minG = g;
      x[i] = (float)(v * (g * wet + dry));
    }
    env = e;
    reduction = -20 * std::log10(minG);
  }
private:
  double env = 0;
  double fs;
};

// ---- drive.ts --------------------------------------------------------------

constexpr int DRIVE_GLOW = 0, DRIVE_RASP = 1, DRIVE_FUZZ = 2, DRIVE_MUFF = 3, DRIVE_BOOST = 4, DRIVE_TRANSPARENT = 5, DRIVE_METAL = 6, DRIVE_OCTAVE = 7;

inline double diodeFeedback(double u) { return u / std::sqrt(1 + u * u * 2.78); }
inline double diodeGround(double u) { const double a = std::abs(u) * 1.82; return u / std::pow(1 + a * a * std::sqrt(a), 0.4); }
inline double germanium(double v) { return v >= 0 ? tanhf_(v) : 0.62 * tanhf_(v * 1.9); }
inline double glowGain(double g) { return (51e3 + 500e3 * g * g) / 4.7e3; }
inline double raspPot(double g) { return 100 + 100e3 * g * g * std::sqrt(g); }
inline double fuzzGain(double g) { return 6 + 260 * g * g; }
inline double muffGain1(double g) { return 6 + 60 * g * g; }
inline double muffGain2(double g) { return 3 + 9 * g; }
inline double boostGain(double g) { return 1.5 + 16 * g; }
inline double clearGain(double g) { return 3 + 40 * g * g; }
inline double metalGain(double g) { return 8 + 70 * std::pow(g, 1.3); }
inline double octaveGain(double g) { return 4 + 60 * g * g; }
inline double muffSoft(double u) { return u / std::sqrt(1 + (u * u) / 0.36); }
inline double muffHard(double u) { return 0.6 * tanhf_(u / 0.6); }

class Drive {
public:
  double push = 0, peakIn = 0;

  explicit Drive(double sampleRate)
    : os(sampleRate), fs(sampleRate), fsOs(sampleRate * OS),
      gHp(fsOs, 720), gLp(fsOs, 6000), rHpLo(fsOs, 60), rHpHi(fsOs, 1540), rGbw(fsOs, 20000), fLp(fsOs, 7000),
      mHp(fsOs, 90), mLp1(fsOs, 6500), mLp2(fsOs, 5200), mToneLp(sampleRate, 400), mToneHp(sampleRate, 1800), bHp(fsOs, 250),
      kHp(fsOs, 220), kLp(fsOs, 4500), kTilt(sampleRate, 1500), oHp(fsOs, 140), oDc(fsOs, 90), oLp(fsOs, 6000), xHp(fsOs, 150), xCouple(fsOs, 120), xLp(fsOs, 6500),
      tone(sampleRate, 3000), tone2(sampleRate, 9000), inHp(sampleRate, 25) {
    up.assign((size_t)MAX_BLOCK * OS, 0.f);
    xScoop.peak(sampleRate, 700, 0.8, -7);
  }

  void reset() {
    os.reset(); rLast = 0; fBias = 0;
    gHp.reset(); gLp.z = 0; rHpLo.reset(); rHpHi.reset(); rGbw.z = 0;
    fLp.z = 0; mHp.reset(); mLp1.z = 0; mLp2.z = 0; mToneLp.z = 0; mToneHp.reset(); bHp.reset(); oHp.reset(); oDc.reset(); oLp.z = 0; kHp.reset(); kLp.z = 0; kTilt.reset(); xHp.reset(); xCouple.reset(); xLp.z = 0; xScoop.reset(); tone.z = 0; tone2.z = 0; inHp.reset();
  }

  void process(float* x, int n, int type, double gain, double toneKnob, double levelDb) {
    static constexpr double CEILING[8] = { 0.75, 0.55, 1, 0.6, 0.35, 0.6, 0.55, 1.2 };
    if (type != lastType) { reset(); lastType = type; }
    double pk = 0;
    for (int i = 0; i < n; i++) {
      x[i] = (float)inHp.tick(x[i]);
      const double a = std::abs((double)x[i]); if (a > pk) pk = a;
    }
    peakIn = pk;
    float* u0 = up.data();
    const int m = n * OS;
    os.upsample(x, u0, n);
    double p = 0;
    if (type == DRIVE_GLOW) {
      const double G = glowGain(gain);
      gLp.set(fsOs, std::min(60000.0, 1 / (2 * PI * (51e3 + 500e3 * gain * gain) * 51e-12)));
      for (int i = 0; i < m; i++) {
        const double v = u0[i];
        const double u = gLp.tick(G * gHp.tick(v));
        const double a = std::abs(u); if (a > p) p = a;
        u0[i] = (float)(v + diodeFeedback(u));
      }
      p /= 0.6;
    } else if (type == DRIVE_RASP) {
      const double R = raspPot(gain);
      const double gLo = R / 560, gHi = R / 47;
      rGbw.set(fsOs, std::min(40000.0, 1e6 / (1 + gLo + gHi)));
      const double slew = 0.3e6 / fsOs;
      double last = rLast;
      for (int i = 0; i < m; i++) {
        const double v = u0[i];
        double u = rGbw.tick(v + gLo * rHpLo.tick(v) + gHi * rHpHi.tick(v));
        u = 4.5 * tanhf_(u / 4.5);
        const double d = u - last;
        if (d > slew) u = last + slew; else if (d < -slew) u = last - slew;
        last = u;
        const double a = std::abs(u); if (a > p) p = a;
        u0[i] = (float)diodeGround(u);
      }
      rLast = last;
      p /= 0.55;
    } else if (type == DRIVE_MUFF) {
      const double G1 = muffGain1(gain), G2 = muffGain2(gain);
      for (int i = 0; i < m; i++) {
        const double u = G1 * u0[i];
        const double a = std::abs(u); if (a > p) p = a;
        const double s = mLp1.tick(mHp.tick(muffSoft(u)));
        u0[i] = (float)mLp2.tick(muffHard(G2 * s));
      }
      p /= 0.6;
    } else if (type == DRIVE_BOOST) {
      const double G = boostGain(gain), comp = std::pow(G, -0.3);
      bHp.set(fsOs, 70 * std::pow(10.0, toneKnob * 1.1));
      for (int i = 0; i < m; i++) {
        const double u = G * bHp.tick(u0[i]);
        const double a = std::abs(u); if (a > p) p = a;
        u0[i] = (float)(germanium(u) * comp);
      }
    } else if (type == DRIVE_TRANSPARENT) {
      const double G = clearGain(gain), keep = 1 - 0.4 * gain;
      for (int i = 0; i < m; i++) {
        const double v = u0[i];
        const double u = G * kLp.tick(kHp.tick(v));
        const double a = std::abs(u); if (a > p) p = a;
        u0[i] = (float)(v * keep + 0.54 * germanium(u));
      }
    } else if (type == DRIVE_OCTAVE) {
      const double G = octaveGain(gain);
      for (int i = 0; i < m; i++) {
        const double u = G * oHp.tick(u0[i]);
        const double a = std::abs(u); if (a > p) p = a;
        const double s = tanhf_(u);
        u0[i] = (float)oLp.tick(0.5 * s + 0.9 * oDc.tick(std::abs(s)));
      }
    } else if (type == DRIVE_METAL) {
      const double G1 = metalGain(gain);
      for (int i = 0; i < m; i++) {
        const double u = G1 * xHp.tick(u0[i]);
        const double a = std::abs(u); if (a > p) p = a;
        const double s1 = tanhf_(u);
        const double s2 = tanhf_(3 * xCouple.tick(s1));
        u0[i] = (float)xLp.tick(diodeGround(5 * s2));
      }
      p /= 2;
    } else {
      const double G = fuzzGain(gain);
      const double charge = 1 - std::exp(-1 / (0.002 * fsOs));
      const double relax = 1 - std::exp(-1 / (0.04 * fsOs));
      double bias = fBias;
      for (int i = 0; i < m; i++) {
        const double v = G * u0[i] + bias;
        const double a = std::abs(v); if (a > p) p = a;
        const double target = v > 1.2 ? std::max(-3.0, -0.4 * (v - 1.2)) : 0;
        bias += (target - bias) * (target < bias ? charge : relax);
        u0[i] = (float)fLp.tick(tanhf_(1.5 * germanium(v)));
      }
      fBias = bias;
    }
    push = p;
    os.downsample(u0, x, n);
    if (type == DRIVE_MUFF) {
      const double out = dbToGain(levelDb) / CEILING[type] * 0.35 * 2.2;
      const double lo = 1 - toneKnob, hi = toneKnob;
      for (int i = 0; i < n; i++) x[i] = (float)((lo * mToneLp.tick(x[i]) + hi * mToneHp.tick(x[i])) * out);
      return;
    }
    if (type == DRIVE_BOOST) {
      tone.set(fs, 9000);
      const double out = dbToGain(levelDb) / CEILING[type] * 0.35;
      for (int i = 0; i < n; i++) x[i] = (float)(tone.tick(x[i]) * out);
      return;
    }
    if (type == DRIVE_TRANSPARENT) {
      const double k = std::max(-0.7, (toneKnob * 2 - 1) * 1.5);
      const double out = dbToGain(levelDb) / CEILING[type] * 0.35;
      for (int i = 0; i < n; i++) { const double v = x[i]; x[i] = (float)((v + k * kTilt.tick(v)) * out); }
      return;
    }
    if (type == DRIVE_METAL) {
      tone.set(fs, 1500 * std::pow(6.0, toneKnob));
      const double out = dbToGain(levelDb) / CEILING[type] * 0.35;
      for (int i = 0; i < n; i++) x[i] = (float)(tone.tick(xScoop.tick(x[i])) * out);
      return;
    }
    const double fTone = type == DRIVE_GLOW ? 800 * std::pow(8.0, toneKnob) : type == DRIVE_RASP ? 600 * std::pow(25.0, toneKnob) : 700 * std::pow(12.0, toneKnob);
    tone.set(fs, fTone);
    tone2.set(fs, std::min(fTone * 2.5, fs * 0.45));
    const double out = dbToGain(levelDb) / CEILING[type] * 0.35;
    for (int i = 0; i < n; i++) x[i] = (float)(tone2.tick(tone.tick(x[i])) * out);
  }

private:
  Oversampler os;
  std::vector<float> up;
  double fs, fsOs;
  OnePoleHP gHp; OnePoleLP gLp;
  OnePoleHP rHpLo, rHpHi; OnePoleLP rGbw;
  double rLast = 0;
  double fBias = 0; OnePoleLP fLp;
  OnePoleHP mHp; OnePoleLP mLp1, mLp2; OnePoleLP mToneLp; OnePoleHP mToneHp;
  OnePoleHP bHp;
  OnePoleHP kHp; OnePoleLP kLp; OnePoleHP kTilt;
  OnePoleHP oHp, oDc; OnePoleLP oLp;
  OnePoleHP xHp, xCouple; OnePoleLP xLp; Biquad xScoop;
  OnePoleLP tone, tone2;
  OnePoleHP inHp;
  int lastType = -1;
};

// ---- tonestack.ts ----------------------------------------------------------

struct StackParts { double R1, R2, R3, R4, C1, C2, C3; };
inline constexpr StackParts STACK_FENDER { 250e3, 1e6, 25e3, 56e3, 250e-12, 20e-9, 20e-9 };
inline constexpr StackParts STACK_MARSHALL { 220e3, 1e6, 22e3, 33e3, 470e-12, 22e-9, 22e-9 };
inline constexpr StackParts STACK_TOPBOOST { 220e3, 1e6, 25e3, 15e3, 330e-12, 22e-9, 68e-9 };
inline constexpr StackParts STACK_TWEED { 250e3, 1e6, 25e3, 22e3, 120e-12, 22e-9, 22e-9 };
inline constexpr StackParts STACK_HIWATT { 250e3, 1e6, 50e3, 22e3, 500e-12, 10e-9, 10e-9 };
inline constexpr StackParts STACK_BOUTIQUE { 250e3, 500e3, 25e3, 22e3, 330e-12, 22e-9, 22e-9 };

class ToneStack {
public:
  void reset() { z1 = z2 = z3 = 0; }

  void set(double fs, const StackParts* p, double treble, double mid, double bass) {
    if (fs == kFs && p == kParts && treble == kT && mid == kM && bass == kL) return;
    kFs = fs; kParts = p; kT = treble; kM = mid; kL = bass;
    const double R1 = p->R1, R2 = p->R2, R3 = p->R3, R4 = p->R4, C1 = p->C1, C2 = p->C2, C3 = p->C3;
    const double t = std::min(1.0, std::max(0.0, treble));
    const double m = std::min(1.0, std::max(0.0, mid));
    const double l = std::exp((std::min(1.0, std::max(0.0, bass)) - 1) * 3.4);

    const double b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);
    const double b2 = t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4)
      - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4)
      + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
      + (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);
    const double b3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
      - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + t * C1 * C2 * C3 * R1 * R3 * R4 - t * m * C1 * C2 * C3 * R1 * R3 * R4
      + t * l * C1 * C2 * C3 * R1 * R2 * R4;
    const double a0 = 1;
    const double a1 = (C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4) + m * C3 * R3 + l * (C1 * R2 + C2 * R2);
    const double a2 = m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
      - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4)
      + (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3 + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);
    const double a3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
      - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + m * (C1 * C2 * C3 * R3 * R3 * R4 + C1 * C2 * C3 * R1 * R3 * R3 - C1 * C2 * C3 * R1 * R3 * R4)
      + l * C1 * C2 * C3 * R1 * R2 * R4 + C1 * C2 * C3 * R1 * R3 * R4;

    const double c = 2 * fs, c2 = c * c, c3 = c2 * c;
    const double B0 = -b1 * c - b2 * c2 - b3 * c3;
    const double B1 = -b1 * c + b2 * c2 + 3 * b3 * c3;
    const double B2 = b1 * c + b2 * c2 - 3 * b3 * c3;
    const double B3 = b1 * c - b2 * c2 + b3 * c3;
    const double A0 = -a0 - a1 * c - a2 * c2 - a3 * c3;
    const double A1 = -3 * a0 - a1 * c + a2 * c2 + 3 * a3 * c3;
    const double A2 = -3 * a0 + a1 * c + a2 * c2 - 3 * a3 * c3;
    const double A3 = -a0 + a1 * c - a2 * c2 + a3 * c3;
    nb0 = B0 / A0; nb1 = B1 / A0; nb2 = B2 / A0; nb3 = B3 / A0;
    na1 = A1 / A0; na2 = A2 / A0; na3 = A3 / A0;
  }

  double tick(double x) {
    const double y = nb0 * x + z1;
    z1 = nb1 * x - na1 * y + z2;
    z2 = nb2 * x - na2 * y + z3;
    z3 = nb3 * x - na3 * y;
    return y;
  }

private:
  double nb0 = 1, nb1 = 0, nb2 = 0, nb3 = 0, na1 = 0, na2 = 0, na3 = 0;
  double z1 = 0, z2 = 0, z3 = 0;
  double kFs = -1; const StackParts* kParts = nullptr; double kT = -1, kM = -1, kL = -1;
};

// ---- amp.ts ----------------------------------------------------------------

constexpr int AMP_CLEAN = 0, AMP_CRUNCH = 1, AMP_LEAD = 2, AMP_CHIME = 3;
constexpr int AMP_TWEED = 4, AMP_HIWATT = 5, AMP_BOUTIQUE = 6;
constexpr int AMP_BRIT = 7, AMP_RECTIFIED = 8, AMP_MODERN = 9;
constexpr int AMP_BLACKFACE = 10, AMP_CHAMP = 11, AMP_ORANGE = 12, AMP_BROWN = 13;
constexpr int MAX_STAGES = 4;

struct Voicing {
  int stages;
  double gainLo, gainHi, inter, couple, miller;
  const StackParts* stack;
  double stackMakeup, inHp, trim, classA;
};

inline const Voicing VOICINGS[14] = {
  { 2, 1.2, 22, 1.6, 25, 14000, &STACK_FENDER, 9, 40, 5, 0 },
  { 3, 2.5, 70, 2.4, 60, 10000, &STACK_MARSHALL, 7, 70, 0, 0 },
  { 4, 2, 260, 3.2, 140, 7500, &STACK_MARSHALL, 7, 110, -0.5, 0 },
  { 2, 2, 60, 2.2, 45, 13000, &STACK_TOPBOOST, 7, 60, 2, 0.3 },
  { 2, 1.5, 50, 2.0, 35, 9500, &STACK_TWEED, 7, 60, 4, 0.45 },
  { 2, 1, 28, 1.8, 45, 12000, &STACK_HIWATT, 3, 60, 5, 0 },
  { 3, 1, 120, 2.3, 50, 9000, &STACK_BOUTIQUE, 5, 70, 0.5, 0.15 },
  { 3, 1.5, 140, 2.6, 90, 8500, &STACK_MARSHALL, 7, 90, 0.5, 0 },
  { 4, 0.8, 320, 3.4, 160, 6500, &STACK_FENDER, 9, 120, -1.5, 0 },
  { 4, 0.8, 240, 3.0, 200, 9000, &STACK_FENDER, 9, 150, -1, 0 },
  { 2, 0.8, 12, 1.5, 22, 15000, &STACK_FENDER, 9, 40, 9, 0 },
  { 2, 1.5, 40, 1.5, 30, 7000, &STACK_TWEED, 7, 80, 6, 0.5 },
  { 3, 0.8, 130, 2.5, 45, 7500, &STACK_HIWATT, 4, 60, 1, 0.1 },
  { 3, 1.5, 90, 2.4, 70, 10000, &STACK_MARSHALL, 7, 70, 0, 0.2 },
};
inline constexpr double RESONANCE[14] = { 1.5, 3, 3, 1.5, 2, 3.5, 2.5, 3, 4.5, 2.5, 1.5, 1.5, 3, 3 };

inline double triode(double v) { return v >= 0 ? tanhf_(v) : 1.6 * tanhf_(v * 0.625); }

class Amp {
public:
  float stageHeat[MAX_STAGES + 1] = {};
  double sagDepth = 0;

  explicit Amp(double sampleRate)
    : os(sampleRate), fs(sampleRate), fsOs(sampleRate * OS),
      couple { { fsOs, 30 }, { fsOs, 30 }, { fsOs, 30 }, { fsOs, 30 } },
      miller { { fsOs, 12000 }, { fsOs, 12000 }, { fsOs, 12000 }, { fsOs, 12000 } },
      xfmrLp(fsOs, 9000), xfmrHp(fsOs, 55) {
    up.assign((size_t)MAX_BLOCK * OS, 0.f);
  }

  void reset() {
    os.reset(); inHp.reset(); pre.reset(); stack.reset();
    for (int s = 0; s < MAX_STAGES; s++) { couple[s].reset(); miller[s].z = 0; bias[s] = 0; }
    xfmrLp.z = 0; xfmrHp.reset(); presence.reset(); resonance.reset(); sagEnv = 0;
  }

  void process(float* x, int n, int type, double gain, double bass, double mid, double treble,
               double pres, double master, double sag, double heat) {
    voice(type, gain);
    const Voicing& v = VOICINGS[type];
    if (pres != lastPres) { presence.highShelf(fs, 3200, pres * 9 - 1); lastPres = pres; }
    stack.set(fsOs, v.stack, treble, mid, bass);
    for (int i = 0; i < n; i++) x[i] = (float)pre.tick(inHp.tick(x[i]));

    float* u0 = up.data();
    const int m = n * OS;
    os.upsample(x, u0, n);
    const double G = v.gainLo * std::pow(v.gainHi / v.gainLo, gain) * heat;
    const int stages = v.stages;
    const double inter = v.inter;
    const double makeup = dbToGain(v.stackMakeup);
    const double ab = v.classA, abOff = ab > 0 ? tanhf_(ab) : 0;
    const double P = 0.25 * std::pow(24.0, master);
    const double charge = 1 - std::exp(-1 / (0.001 * fsOs));
    const double relax = 1 - std::exp(-1 / (0.03 * fsOs));
    const double sagAtk = 1 - std::exp(-1 / (0.012 * fsOs));
    const double sagRel = 1 - std::exp(-1 / (0.15 * fsOs));
    std::fill(stageHeat, stageHeat + MAX_STAGES + 1, 0.f);
    double env = sagEnv, sagMin = 1;
    for (int i = 0; i < m; i++) {
      double s = u0[i] * G;
      for (int k = 0; k < stages; k++) {
        const double vg = s + bias[k];
        const double a = std::abs(vg); if (a > stageHeat[k]) stageHeat[k] = (float)a;
        const double target = vg > 0.7 ? std::max(-1.2, -0.35 * (vg - 0.7)) : 0;
        bias[k] += (target - bias[k]) * (target < bias[k] ? charge : relax);
        s = -triode(vg);
        s = miller[k].tick(couple[k].tick(s));
        if (k < stages - 1) s *= inter;
      }
      double u = stack.tick(s) * makeup * P;
      const double supply = 1 - 0.45 * sag * env;
      if (supply < sagMin) sagMin = supply;
      const double a = std::abs(u) / supply; if (a > stageHeat[MAX_STAGES]) stageHeat[MAX_STAGES] = (float)a;
      u = supply * (tanhf_(u / supply + ab) - abOff);
      const double au = std::abs(u);
      env += (au - env) * (au > env ? sagAtk : sagRel);
      u0[i] = (float)xfmrHp.tick(xfmrLp.tick(u));
    }
    sagEnv = env;
    sagDepth = 1 - sagMin;
    os.downsample(u0, x, n);
    const double out = dbToGain(v.trim) * 0.16 / std::min(1.0, P * 0.6);
    for (int i = 0; i < n; i++) x[i] = (float)(resonance.tick(presence.tick(x[i])) * out);
  }

private:
  void voice(int type, double gain) {
    const Voicing& v = VOICINGS[type];
    if (type != lastType) {
      reset();
      inHp.highpass(fs, v.inHp, 0.707);
      for (int s = 0; s < MAX_STAGES; s++) { couple[s].set(fsOs, v.couple); miller[s].set(fsOs, v.miller); }
      resonance.lowShelf(fs, 110, RESONANCE[type]);
    }
    if (type != lastType || gain != lastGain) {
      if (type == AMP_CLEAN) pre.highShelf(fs, 2200, 6 * (1 - gain));
      else if (type == AMP_CRUNCH) pre.highShelf(fs, 2000, 3);
      else if (type == AMP_LEAD) pre.peak(fs, 750, 0.7, 5);
      else if (type == AMP_CHIME) pre.peak(fs, 2600, 0.8, 4);
      else if (type == AMP_TWEED) pre.peak(fs, 1700, 0.8, 3);
      else if (type == AMP_HIWATT) pre.highShelf(fs, 2500, 3);
      else if (type == AMP_BOUTIQUE) pre.peak(fs, 1000, 0.7, 5);
      else if (type == AMP_BRIT) pre.peak(fs, 1500, 0.8, 4);
      else if (type == AMP_RECTIFIED) pre.highShelf(fs, 3000, 2);
      else if (type == AMP_MODERN) pre.peak(fs, 2200, 0.7, 4);
      else if (type == AMP_BLACKFACE) pre.highShelf(fs, 2500, 1 + 4 * (1 - gain));
      else if (type == AMP_CHAMP) pre.peak(fs, 1500, 0.8, 3);
      else if (type == AMP_ORANGE) pre.peak(fs, 500, 0.7, 4);
      else pre.peak(fs, 1000, 0.7, 3);
    }
    lastType = type; lastGain = gain;
  }

  Oversampler os;
  std::vector<float> up;
  double fs, fsOs;
  Biquad inHp, pre;
  OnePoleHP couple[MAX_STAGES];
  OnePoleLP miller[MAX_STAGES];
  double bias[MAX_STAGES] = {};
  ToneStack stack;
  OnePoleLP xfmrLp;
  OnePoleHP xfmrHp;
  Biquad presence, resonance;
  double sagEnv = 0;
  int lastType = -1;
  double lastPres = -1, lastGain = -1;
};

// ---- cab.ts ----------------------------------------------------------------

struct CabSec { char t; double f, q, db; };
constexpr int CAB_SECS = 7, NCABS = 9;
inline constexpr CabSec CABS[NCABS][CAB_SECS] = {
  { { 'h', 85, 0.75, 0 }, { 'p', 140, 1.4, 2 }, { 'p', 650, 1.2, -2.5 }, { 'p', 1500, 1.4, 2.5 }, { 'p', 2800, 2.2, 4 }, { 'l', 5600, 0.9, 0 }, { 'l', 7200, 0.6, 0 } },
  { { 'h', 72, 1.0, 0 }, { 'p', 115, 1.5, 3.5 }, { 'p', 500, 1.0, -3 }, { 'p', 1900, 1.2, 2.5 }, { 'p', 3400, 2.4, 4.5 }, { 'l', 5000, 0.85, 0 }, { 'l', 6600, 0.6, 0 } },
  { { 'h', 62, 1.25, 0 }, { 'p', 100, 2.0, 6 }, { 'p', 420, 1.0, -4 }, { 'p', 1700, 1.4, 2 }, { 'p', 3000, 2.6, 5.5 }, { 'l', 4500, 0.9, 0 }, { 'l', 6000, 0.6, 0 } },
  { { 'h', 78, 0.9, 0 }, { 'p', 125, 1.3, 2.5 }, { 'p', 600, 1.1, -2 }, { 'p', 1600, 1.4, 1.5 }, { 'p', 3800, 2.0, 5 }, { 'l', 6200, 0.85, 0 }, { 'l', 7800, 0.6, 0 } },
  { { 'h', 70, 1.0, 0 }, { 'p', 110, 1.6, 4 }, { 'p', 450, 1.0, -3 }, { 'p', 1800, 1.3, 3 }, { 'p', 3000, 2.0, 3.5 }, { 'l', 4800, 0.85, 0 }, { 'l', 6200, 0.6, 0 } },
  { { 'h', 95, 0.8, 0 }, { 'p', 160, 1.4, 2.5 }, { 'p', 700, 1.0, 2 }, { 'p', 1400, 1.3, -1.5 }, { 'p', 2600, 1.8, 3 }, { 'l', 4800, 0.8, 0 }, { 'l', 6800, 0.6, 0 } },
  { { 'h', 75, 1.1, 0 }, { 'p', 105, 1.8, 4 }, { 'p', 380, 1.0, -4.5 }, { 'p', 1500, 1.3, 1.5 }, { 'p', 3400, 2.2, 6 }, { 'l', 5200, 0.9, 0 }, { 'l', 6800, 0.6, 0 } },
  { { 'h', 80, 0.9, 0 }, { 'p', 130, 1.3, 2.5 }, { 'p', 500, 1.0, -2.5 }, { 'p', 1200, 1.2, 1.5 }, { 'p', 3200, 1.8, 4 }, { 'l', 6500, 0.8, 0 }, { 'l', 8200, 0.6, 0 } },
  { { 'h', 130, 0.9, 0 }, { 'p', 190, 1.4, 3 }, { 'p', 900, 1.0, 2 }, { 'p', 1800, 1.4, -1 }, { 'p', 3000, 1.8, 3 }, { 'l', 4300, 0.8, 0 }, { 'l', 6000, 0.6, 0 } },
};

class Cab {
public:
  explicit Cab(double sampleRate) : fs(sampleRate) {}
  void reset() { for (auto& s : secs) s.reset(); }
  void set(int type, double mic) {
    if (type == curType && mic == curMic) return;
    curType = type; curMic = mic;
    const CabSec* cab = CABS[std::max(0, std::min(NCABS - 1, type))];
    const double dark = std::pow(0.6, mic);
    for (int i = 0; i < CAB_SECS; i++) {
      const CabSec& c = cab[i];
      Biquad& s = secs[i];
      if (c.t == 'h') s.highpass(fs, c.f, c.q);
      else if (c.t == 'l') s.lowpass(fs, c.f * (0.75 + 0.5 * dark), c.q);
      else if (c.f > 2000) s.peak(fs, c.f * (0.85 + 0.15 * dark), c.q, c.db * (1.3 - mic));
      else s.peak(fs, c.f, c.q, c.db);
    }
  }
  void process(float* x, int n, int type, double mic) {
    set(type, mic);
    for (int i = 0; i < n; i++) {
      double v = x[i];
      for (int k = 0; k < CAB_SECS; k++) v = secs[k].tick(v);
      x[i] = (float)v;
    }
  }
private:
  Biquad secs[CAB_SECS];
  int curType = -1; double curMic = -1;
  double fs;
};

// ---- cab.ts: the low cut and high cut after the speaker ---------------------------

class CabCut {
public:
  explicit CabCut(double sampleRate) : fs(sampleRate) {}
  void reset() { hp.reset(); lp1.reset(); lp2.reset(); }
  void process(float* x, int n, double lo, double hi) {
    const bool useLo = lo > 21, useHi = hi < 11900;
    if (!useLo && !useHi) { active = false; return; }
    if (!active) { reset(); active = true; curLo = -1; curHi = -1; }
    if (lo != curLo) { curLo = lo; if (useLo) hp.highpass(fs, lo, 0.707); else hp.bypass(); }
    if (hi != curHi) {
      curHi = hi;
      if (useHi) { lp1.lowpass(fs, hi, 0.5412); lp2.lowpass(fs, hi, 1.3066); } else { lp1.bypass(); lp2.bypass(); }
    }
    for (int i = 0; i < n; i++) x[i] = (float)lp2.tick(lp1.tick(hp.tick(x[i])));
  }
private:
  Biquad hp, lp1, lp2;
  double curLo = -1, curHi = -1;
  bool active = false;
  double fs;
};

// ---- eq.ts -----------------------------------------------------------------

class Eq {
public:
  static constexpr int BANDS = 5;
  explicit Eq(double sampleRate) : fs(sampleRate) { for (auto& g : gains) g = std::nan(""); }
  void reset() { for (auto& b : bands) b.reset(); }
  void set(double g0, double g1, double g2, double g3, double g4) { band(0, g0); band(1, g1); band(2, g2); band(3, g3); band(4, g4); }
  void process(float* x, int n, double levelDb) {
    const double out = dbToGain(levelDb);
    for (int i = 0; i < n; i++) x[i] = (float)(bands[4].tick(bands[3].tick(bands[2].tick(bands[1].tick(bands[0].tick(x[i]))))) * out);
  }
private:
  void band(int b, double db) {
    static constexpr double FREQ[BANDS] = { 100, 400, 1000, 2500, 6000 };
    if (db == gains[b]) return;
    gains[b] = db;
    if (b == 0) bands[b].lowShelf(fs, FREQ[b], db);
    else if (b == BANDS - 1) bands[b].highShelf(fs, FREQ[b], db);
    else bands[b].peak(fs, FREQ[b], 0.9, db);
  }
  Biquad bands[BANDS];
  double gains[BANDS];
  double fs;
};

// ---- gtone.ts --------------------------------------------------------------

class GuitarTone {
public:
  explicit GuitarTone(double sampleRate) : fs(sampleRate), bleed(sampleRate, 2500) {}
  void reset() { lp.reset(); bleed.reset(); }
  void process(float* x, int n, double tone, double volume) {
    if (tone != lastTone) { lp.lowpass(fs, 500 * std::pow(14.0, tone), 0.5 + 0.5 * tone); lastTone = tone; }
    const double g = volume * volume, bl = (1 - g) * 0.3;
    for (int i = 0; i < n; i++) {
      const double v = lp.tick(x[i]);
      x[i] = (float)(v * g + bleed.tick(v) * bl);
    }
  }
private:
  double fs;
  Biquad lp;
  OnePoleHP bleed;
  double lastTone = -1;
};

// ---- wah.ts ----------------------------------------------------------------

class Wah {
public:
  double pos = 0.5;
  explicit Wah(double sampleRate) : fs(sampleRate) {}
  void reset() { bp.reset(); env = 0; }
  void process(float* x, int n, double posKnob, double autoAmt, double reson, double levelDb) {
    constexpr int STEP = 32;
    const double atk = 1 - std::exp(-1 / (0.004 * fs)), rel = 1 - std::exp(-1 / (0.12 * fs));
    const double q = 2 + 6 * reson, out = dbToGain(levelDb);
    double e = env, cur = pos;
    for (int i0 = 0; i0 < n; i0 += STEP) {
      const int m = std::min(STEP, n - i0);
      cur = std::min(1.0, std::max(0.0, posKnob + autoAmt * std::min(1.0, e * 5)));
      bp.bandpass(fs, 350 * std::pow(2300.0 / 350, cur), q);
      for (int i = i0; i < i0 + m; i++) {
        const double v = x[i];
        const double a = std::abs(v);
        e += (a - e) * (a > e ? atk : rel);
        x[i] = (float)((bp.tick(v) * 1.4 + v * 0.3) * out);
      }
    }
    env = e; pos = cur;
  }
private:
  Biquad bp;
  double env = 0;
  double fs;
};

} // namespace pedalboard
