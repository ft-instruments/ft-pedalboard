// The YIN tuner on the input, decimated by 4. C++ port of src/dsp/tuner.ts.
#pragma once

#include <vector>
#include "Util.h"

namespace pedalboard {

class Tuner {
public:
  double freq = 0, clarity = 0;

  explicit Tuner(double sampleRate)
    : fsDec(sampleRate / DEC), maxLag((int)std::floor(fsDec / 38)), lpA(1 - std::exp(-2 * PI * 1400 / sampleRate)) {
    buf.assign((size_t)(W + maxLag), 0.f);
    win.assign((size_t)(W + maxLag), 0.f);
    d.assign((size_t)maxLag + 1, 0.f);
    raw.assign((size_t)maxLag + 1, 0.f);
  }

  void push(const float* x, int n) {
    const int len = (int)buf.size();
    for (int i = 0; i < n; i++) {
      z1 += (x[i] - z1) * lpA; z2 += (z1 - z2) * lpA; z3 += (z2 - z3) * lpA;
      if (++dec < DEC) continue;
      dec = 0;
      buf[idx] = (float)z3;
      if (++idx >= len) idx = 0;
      if (++count >= HOP) { count = 0; analyse(); }
    }
  }

private:
  static constexpr int DEC = 4, W = 640, HOP = 256;
  static constexpr double THRESH = 0.12;

  void analyse() {
    const int len = (int)buf.size();
    double energy = 0;
    for (int i = 0; i < len; i++) { const double v = buf[(idx + i) % len]; win[i] = (float)v; energy += v * v; }
    if (energy / len < 1e-7) { freq = 0; clarity = 0; return; }
    d[0] = 1;
    double running = 0;
    int lag = -1;
    for (int tau = 1; tau <= maxLag; tau++) {
      double s = 0;
      for (int i = 0; i < W; i++) { const double v = (double)win[i] - win[i + tau]; s += v * v; }
      raw[tau] = (float)s;
      running += s;
      d[tau] = (float)(running > 0 ? s * tau / running : 1);
    }
    const int minLag = (int)std::floor(fsDec / 1400);
    for (int tau = std::max(2, minLag); tau < maxLag; tau++) {
      if (d[tau] < THRESH) {
        while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++;
        lag = tau; break;
      }
    }
    if (lag < 0) { freq = 0; clarity = 0; return; }
    const double a = raw[lag - 1], b = raw[lag], c = raw[lag + 1];
    const double den = a - 2 * b + c;
    const double shift = den != 0 ? 0.5 * (a - c) / den : 0;
    freq = fsDec / (lag + shift);
    clarity = 1 - (double)d[lag];
  }

  double fsDec;
  int maxLag;
  double lpA;
  std::vector<float> buf, win, d, raw;
  int idx = 0, count = 0, dec = 0;
  double z1 = 0, z2 = 0, z3 = 0;
};

} // namespace pedalboard
