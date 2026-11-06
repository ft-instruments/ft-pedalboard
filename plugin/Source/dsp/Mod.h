// Chorus, phaser, flanger and tremolo. C++ port of src/dsp/mod.ts.
#pragma once

#include <vector>
#include "Util.h"

namespace pedalboard {

constexpr double TWO_PI = 2 * PI;

class Chorus {
public:
  double phase = 0;
  explicit Chorus(double sampleRate) : fs(sampleRate) {
    const size_t len = (size_t)std::ceil(0.03 * sampleRate);
    bufL.assign(len, 0.f); bufR.assign(len, 0.f);
  }
  void reset() { std::fill(bufL.begin(), bufL.end(), 0.f); std::fill(bufR.begin(), bufR.end(), 0.f); lpL = lpR = 0; }
  void process(float* L, float* R, int n, double rate, double depth, double tone, double mix) {
    const int len = (int)bufL.size();
    const double base = 0.0075 * fs, swing = depth * 0.0048 * fs;
    const double inc = rate / fs;
    const double lpA = 1 - std::exp(-TWO_PI * (2500 + tone * 9500) / fs);
    const double dry = 1 - mix;
    int i0 = idx; double ph = phase, l = lpL, r = lpR;
    for (int i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const double xl = L[i], xr = R[i];
      const double wl = readDelay(bufL.data(), len, i0, base + swing * std::sin(TWO_PI * ph));
      const double wr = readDelay(bufR.data(), len, i0, base + swing * std::sin(TWO_PI * (ph + 0.25)));
      bufL[i0] = (float)xl; bufR[i0] = (float)xr;
      if (++i0 >= len) i0 = 0;
      l += (wl - l) * lpA; r += (wr - r) * lpA;
      L[i] = (float)(xl * dry + l * mix);
      R[i] = (float)(xr * dry + r * mix);
    }
    idx = i0; phase = ph; lpL = l; lpR = r;
  }
private:
  std::vector<float> bufL, bufR;
  int idx = 0;
  double lpL = 0, lpR = 0;
  double fs;
};

class Flanger {
public:
  double phase = 0;
  explicit Flanger(double sampleRate) : fs(sampleRate) {
    const size_t len = (size_t)std::ceil(0.012 * sampleRate);
    bufL.assign(len, 0.f); bufR.assign(len, 0.f);
  }
  void reset() { std::fill(bufL.begin(), bufL.end(), 0.f); std::fill(bufR.begin(), bufR.end(), 0.f); fbL = fbR = 0; }
  void process(float* L, float* R, int n, double rate, double depth, double manual, double regen, double mix) {
    const int len = (int)bufL.size();
    const double base = (0.0006 + manual * 0.0044) * fs, swing = depth * 0.85 * base;
    const double inc = rate / fs;
    const double lpA = 1 - std::exp(-TWO_PI * 6500 / fs);
    const double dry = 1 - mix;
    int i0 = idx; double ph = phase, fl = fbL, fr = fbR;
    for (int i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const double xl = L[i], xr = R[i];
      const double wl = readDelay(bufL.data(), len, i0, base + swing * std::sin(TWO_PI * ph));
      const double wr = readDelay(bufR.data(), len, i0, base + swing * std::sin(TWO_PI * (ph + 0.25)));
      bufL[i0] = (float)(xl + fl * regen); bufR[i0] = (float)(xr + fr * regen);
      if (++i0 >= len) i0 = 0;
      fl += (wl - fl) * lpA; fr += (wr - fr) * lpA;
      L[i] = (float)(xl * dry + wl * mix);
      R[i] = (float)(xr * dry + wr * mix);
    }
    idx = i0; phase = ph; fbL = fl; fbR = fr;
  }
private:
  std::vector<float> bufL, bufR;
  int idx = 0;
  double fbL = 0, fbR = 0;
  double fs;
};

class Phaser {
public:
  static constexpr int MAX_STAGES = 8;
  double phase = 0;
  explicit Phaser(double sampleRate) : fs(sampleRate) {}
  void reset() { std::fill(apL, apL + MAX_STAGES, 0.0); std::fill(apR, apR + MAX_STAGES, 0.0); fbL = fbR = 0; }
  void process(float* L, float* R, int n, double rate, double depth, double fb, int stages, double spread, double mix) {
    constexpr double FMIN = 180;
    const int st = 4 + 2 * stages;
    const double logSpan = std::log(2.0) * depth * 4.5;
    const double inc = rate / fs, lag = spread * 0.5;
    const double w = PI / fs, dry = 1 - mix;
    double ph = phase, fl = fbL, fr = fbR;
    for (int i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const double ul = 0.5 - 0.5 * std::cos(TWO_PI * ph), ur = 0.5 - 0.5 * std::cos(TWO_PI * (ph + lag));
      const double tl = std::tan(w * FMIN * std::exp(logSpan * ul)), tr = std::tan(w * FMIN * std::exp(logSpan * ur));
      const double al = (tl - 1) / (tl + 1), ar = (tr - 1) / (tr + 1);
      const double xl = L[i], xr = R[i];
      double vl = xl + fl * fb, vr = xr + fr * fb;
      for (int s = 0; s < st; s++) {
        const double yl = al * vl + apL[s]; apL[s] = vl - al * yl; vl = yl;
        const double yr = ar * vr + apR[s]; apR[s] = vr - ar * yr; vr = yr;
      }
      fl = vl; fr = vr;
      L[i] = (float)(xl * dry + vl * mix);
      R[i] = (float)(xr * dry + vr * mix);
    }
    phase = ph; fbL = fl; fbR = fr;
  }
private:
  double apL[MAX_STAGES] = {}, apR[MAX_STAGES] = {};
  double fbL = 0, fbR = 0;
  double fs;
};

class Vibe {
public:
  double phase = 0;
  explicit Vibe(double sampleRate) : fs(sampleRate) {}
  void reset() { std::fill(ap, ap + 4, 0.0); }
  void process(float* x, int n, double rate, double depth, double mode) {
    static constexpr double RATIOS[4] = { 1, 2.3, 4.7, 9.6 };
    const double w = PI / fs, inc = rate / fs;
    const bool vib = mode >= 0.5;
    double ph = phase;
    for (int i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const double s = 0.5 + 0.5 * std::sin(TWO_PI * ph);
      const double f0 = 140 * std::pow(2.0, 3.2 * depth * std::pow(s, 1.4));
      const double v0 = x[i];
      double v = v0;
      for (int k = 0; k < 4; k++) {
        const double t = std::tan(w * f0 * RATIOS[k]), a = (t - 1) / (t + 1);
        const double y = a * v + ap[k]; ap[k] = v - a * y; v = y;
      }
      x[i] = (float)(vib ? v : (v0 + v) * 0.7);
    }
    phase = ph;
  }
private:
  double ap[4] = {};
  double fs;
};

class Rotary {
public:
  double phase = 0;
  explicit Rotary(double sampleRate) : lp1(sampleRate, 800), lp2(sampleRate, 800), fs(sampleRate) {
    const size_t len = (size_t)std::ceil(0.003 * sampleRate) + 16;
    horn.assign(len, 0.f); drum.assign(len, 0.f);
  }
  void reset() {
    std::fill(horn.begin(), horn.end(), 0.f); std::fill(drum.begin(), drum.end(), 0.f);
    lp1.z = 0; lp2.z = 0; hornRate = 0.67; drumRate = 0.5;
  }
  void process(float* L, float* R, int n, double speed, double depth, double mix) {
    const int len = (int)horn.size();
    const double hTarget = 0.67 + 6.0 * speed, dTarget = 0.5 + 5.2 * speed;
    const double hk = 1 - std::exp(-1 / (1.0 * fs)), dk = 1 - std::exp(-1 / (3.0 * fs));
    const double base = 0.0008 * fs + 4, swH = depth * 0.0008 * fs, swD = depth * 0.0004 * fs;
    const double dry = 1 - mix;
    int i0 = idx; double hr = hornRate, dr = drumRate, hp = hornPh, dp = drumPh;
    for (int i = 0; i < n; i++) {
      hr += (hTarget - hr) * hk; dr += (dTarget - dr) * dk;
      hp += hr / fs; if (hp >= 1) hp -= 1;
      dp += dr / fs; if (dp >= 1) dp -= 1;
      const double xl = L[i], xr = R[i], m = (xl + xr) * 0.5;
      const double lo = lp2.tick(lp1.tick(m)), hi = m - lo;
      horn[i0] = (float)hi; drum[i0] = (float)lo;
      const double th = TWO_PI * hp, td = TWO_PI * dp;
      const double hl = readDelay(horn.data(), len, i0, base - swH * std::sin(th)) * (1 - depth * 0.55 * (0.5 - 0.5 * std::cos(th)));
      const double hrr = readDelay(horn.data(), len, i0, base - swH * std::sin(th - PI / 2)) * (1 - depth * 0.55 * (0.5 - 0.5 * std::cos(th - PI / 2)));
      const double dl = readDelay(drum.data(), len, i0, base - swD * std::sin(td)) * (1 - depth * 0.3 * (0.5 - 0.5 * std::cos(td)));
      const double drr = readDelay(drum.data(), len, i0, base - swD * std::sin(td - PI / 2)) * (1 - depth * 0.3 * (0.5 - 0.5 * std::cos(td - PI / 2)));
      if (++i0 >= len) i0 = 0;
      L[i] = (float)(xl * dry + (hl + dl) * mix);
      R[i] = (float)(xr * dry + (hrr + drr) * mix);
    }
    idx = i0; hornRate = hr; drumRate = dr; hornPh = hp; drumPh = dp;
    phase = hp;
  }
private:
  std::vector<float> horn, drum;
  int idx = 0;
  OnePoleLP lp1, lp2;
  double hornRate = 0.67, drumRate = 0.5, hornPh = 0, drumPh = 0.3;
  double fs;
};

class Tremolo {
public:
  double phase = 0;
  explicit Tremolo(double sampleRate) : fs(sampleRate) {}
  void reset() {}
  void process(float* L, float* R, int n, bool stereo, double rate, double depth, double shape) {
    const double inc = rate / fs;
    const double k = 1 + shape * 14, norm = 1 / std::tanh(k);
    double ph = phase;
    for (int i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const double u = 0.5 + 0.5 * std::tanh(k * std::sin(TWO_PI * ph)) * norm;
      const double g = 1 - depth * (1 - u);
      L[i] = (float)(L[i] * g);
      if (stereo) R[i] = (float)(R[i] * g);
    }
    phase = ph;
  }
private:
  double fs;
};

} // namespace pedalboard
