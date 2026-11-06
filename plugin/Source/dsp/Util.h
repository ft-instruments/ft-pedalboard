// Small numeric helpers shared by the DSP. C++ port of src/dsp/util.ts (shared with ft-mycelia).
//
// Porting convention for the whole engine: a TS number is a double, a
// Float32Array element is a float. JS does all arithmetic in double, so a
// float read from a buffer is promoted before it is used; stores round back
// to float exactly where the TS stores into a Float32Array. That keeps the
// two engines within rounding of each other (see scripts/null-test.ts).
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>
#include <algorithm>

namespace pedalboard {

constexpr double PI = 3.141592653589793;

/** Rational tanh approximation, good to ~1e-3 over |x| < 3 and clamped beyond. */
inline double tanhf_(double x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const double x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

/** Soft clipper with unit slope at 0 and hard limit at ±1. */
inline double softClip(double x) {
  if (x > 1.5) return 1;
  if (x < -1.5) return -1;
  return x - (x * x * x) * 0.148148;
}

inline double clamp(double x, double lo, double hi) { return x < lo ? lo : x > hi ? hi : x; }

inline double midiToFreq(double note) { return 440 * std::pow(2.0, (note - 69) / 12); }

/** xorshift32; deterministic so offline renders are repeatable. */
class Rng {
public:
  explicit Rng(uint32_t seed = 0x9e3779b9u) : s(seed ? seed : 1) {}
  double next() {
    uint32_t x = s;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    s = x;
    return x / 4294967296.0;
  }
  /** -1..1 */
  double bi() { return next() * 2 - 1; }
private:
  uint32_t s;
};

/** Fractional-delay read with linear interpolation from a circular buffer. */
inline double readDelay(const float* buf, int len, int writeIdx, double delay) {
  double r = writeIdx - delay;
  while (r < 0) r += len;
  const int i0 = (int)r;
  const double frac = r - i0;
  int i1 = i0 + 1; if (i1 >= len) i1 -= len;
  const double a = buf[i0], b = buf[i1];
  return a + (b - a) * frac;
}

/** Math.round: halves go up (std::round takes them away from zero). */
inline double jsRound(double x) { return std::floor(x + 0.5); }

/** One-pole parameter smoother (exponential glide to target). */
class Smooth {
public:
  double value, target;
  Smooth(double initial, double sampleRate, double ms = 20)
    : value(initial), target(initial), coef(1 - std::exp(-1 / (ms * 1e-3 * sampleRate))) {}
  void set(double t) { target = t; }
  void jump(double t) { value = target = t; }
  double tick() { return (value += (target - value) * coef); }
private:
  double coef;
};

/** One-pole low-pass, coefficient from a cutoff in Hz. */
class OnePoleLP {
public:
  double z = 0, a = 0.1;
  OnePoleLP(double sampleRate, double hz) { set(sampleRate, hz); }
  void set(double sampleRate, double hz) { a = 1 - std::exp(-2 * PI * hz / sampleRate); }
  double tick(double x) { return (z += (x - z) * a); }
};

class OnePoleHP {
public:
  OnePoleHP(double sampleRate, double hz) : lp(sampleRate, hz) {}
  void set(double sampleRate, double hz) { lp.set(sampleRate, hz); }
  void reset() { lp.z = 0; }
  double tick(double x) { return x - lp.tick(x); }
private:
  OnePoleLP lp;
};

inline double dbToGain(double db) { return std::pow(10.0, db / 20); }

/** Biquad, transposed direct form II, coefficients from the RBJ cookbook; state in doubles. */
class Biquad {
public:
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;

  void reset() { z1 = z2 = 0; }

  double tick(double x) {
    const double y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }

  void bypass() { b0 = 1; b1 = b2 = a1 = a2 = 0; }

  void lowpass(double fs, double f, double q) {
    const double w = 2 * PI * std::min(f, fs * 0.49) / fs, c = std::cos(w), al = std::sin(w) / (2 * q);
    norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  void highpass(double fs, double f, double q) {
    const double w = 2 * PI * std::min(f, fs * 0.49) / fs, c = std::cos(w), al = std::sin(w) / (2 * q);
    norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  void bandpass(double fs, double f, double q) {
    const double w = 2 * PI * std::min(f, fs * 0.49) / fs, c = std::cos(w), al = std::sin(w) / (2 * q);
    norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  void peak(double fs, double f, double q, double db) {
    const double A = std::pow(10.0, db / 40), w = 2 * PI * std::min(f, fs * 0.49) / fs, c = std::cos(w), al = std::sin(w) / (2 * q);
    norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }

  void lowShelf(double fs, double f, double db) {
    const double A = std::pow(10.0, db / 40), w = 2 * PI * std::min(f, fs * 0.49) / fs, c = std::cos(w), s = std::sin(w);
    const double al = s / std::sqrt(2.0), k = 2 * std::sqrt(A) * al;
    norm(A * ((A + 1) - (A - 1) * c + k), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - k),
      (A + 1) + (A - 1) * c + k, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - k);
  }

  void highShelf(double fs, double f, double db) {
    const double A = std::pow(10.0, db / 40), w = 2 * PI * std::min(f, fs * 0.49) / fs, c = std::cos(w), s = std::sin(w);
    const double al = s / std::sqrt(2.0), k = 2 * std::sqrt(A) * al;
    norm(A * ((A + 1) + (A - 1) * c + k), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - k),
      (A + 1) - (A - 1) * c + k, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - k);
  }

private:
  void norm(double nb0, double nb1, double nb2, double a0, double na1, double na2) {
    b0 = nb0 / a0; b1 = nb1 / a0; b2 = nb2 / a0; a1 = na1 / a0; a2 = na2 / a0;
  }
  double z1 = 0, z2 = 0;
};

/** Rate of the nonlinear stages: drive and amp run at 8x. */
constexpr int OS = 8;
constexpr int OS_SECTIONS = 6;

/** OS-times up/down sampler: zero-stuffing and decimation through a 12th-order Butterworth at 0.45 of the base rate. */
class Oversampler {
public:
  explicit Oversampler(double sampleRate) {
    const double fsOs = sampleRate * OS, fc = std::min(20000.0, sampleRate * 0.45);
    for (int k = 0; k < OS_SECTIONS; k++) {
      const double q = 1 / (2 * std::cos(PI * (2 * k + 1) / (4 * OS_SECTIONS)));
      up[k].lowpass(fsOs, fc, q);
      down[k].lowpass(fsOs, fc, q);
    }
  }
  void reset() { for (auto& b : up) b.reset(); for (auto& b : down) b.reset(); }
  void upsample(const float* x, float* out, int n) {
    for (int i = 0; i < n; i++)
      for (int k = 0; k < OS; k++) {
        double v = k == 0 ? (double)x[i] * OS : 0;
        for (int s = 0; s < OS_SECTIONS; s++) v = up[s].tick(v);
        out[i * OS + k] = (float)v;
      }
  }
  void downsample(const float* x, float* out, int n) {
    for (int i = 0; i < n; i++)
      for (int k = 0; k < OS; k++) {
        double v = x[i * OS + k];
        for (int s = 0; s < OS_SECTIONS; s++) v = down[s].tick(v);
        if (k == OS - 1) out[i] = (float)v;
      }
  }
private:
  Biquad up[OS_SECTIONS], down[OS_SECTIONS];
};

} // namespace pedalboard
