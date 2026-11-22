// Cabinet impulse response (port of src/dsp/cabir.ts): direct convolution with
// the user's IR cut to IR_MAX taps. One IR is shared by every unit; the
// message thread publishes it through an atomic pointer.
#pragma once
#include <cmath>
#include <vector>
#include <memory>
#include <atomic>
#include <algorithm>
#include "Util.h"

namespace pedalboard {

constexpr int IR_MAX = 2048;

struct IR { std::vector<double> h; };

/** Cut, fade the tail, normalise; nullptr for nothing usable. */
inline std::unique_ptr<IR> prepareIR(const float* data, int count) {
  const int n = std::min(count, IR_MAX);
  if (n < 2) return nullptr;
  auto ir = std::make_unique<IR>();
  ir->h.assign(n, 0.0);
  const int fade = std::max(1, n / 8);
  double e = 0;
  for (int i = 0; i < n; i++) {
    const double v = data[i];
    if (!std::isfinite(v)) return nullptr;
    const double w = i >= n - fade ? 0.5 + 0.5 * std::cos(PI * (i - (n - fade)) / fade) : 1.0;
    ir->h[i] = v * w; e += ir->h[i] * ir->h[i];
  }
  if (e < 1e-12) return nullptr;
  const double g = 1.0 / std::sqrt(e);
  for (auto& v : ir->h) v *= g;
  return ir;
}

class CabIR {
public:
  void reset() { std::fill(hist, hist + 2 * IR_MAX, 0.0); pos = 0; }

  void process(float* x, int n, const IR* ir, double level, double mix) {
    if (!ir) return;
    const int len = (int) ir->h.size();
    const double gain = dbToGain(level);
    const double* hh = ir->h.data();
    int p = pos;
    for (int i = 0; i < n; i++) {
      p = p == 0 ? IR_MAX - 1 : p - 1;
      const double dry = x[i];
      hist[p] = dry; hist[p + IR_MAX] = dry;
      double s = 0;
      for (int k = 0; k < len; k++) s += hh[k] * hist[p + k];
      x[i] = (float) (dry + (s * gain - dry) * mix);
    }
    pos = p;
  }

private:
  double hist[2 * IR_MAX] = {};
  int pos = 0;
};

} // namespace pedalboard
