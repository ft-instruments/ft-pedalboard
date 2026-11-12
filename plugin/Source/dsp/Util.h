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
#include <vector>

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

/** 4-point Hermite fractional-delay read for modulated lines (util.ts readDelayCubic); delay >= 3. */
inline double readDelayCubic(const float* buf, int len, int writeIdx, double delay) {
  double r = writeIdx - delay;
  while (r < 0) r += len;
  const int i0 = (int)r; const double f = r - i0;
  int im = i0 - 1; if (im < 0) im += len;
  int i1 = i0 + 1; if (i1 >= len) i1 -= len;
  int i2 = i1 + 1; if (i2 >= len) i2 -= len;
  const double xm = buf[im], x0 = buf[i0], x1 = buf[i1], x2 = buf[i2];
  const double c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
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
  void firstOrder(double fs, double b0_, double b1_, double a0_, double a1_) {
    const double c = 2 * fs;
    norm(b0_ + b1_ * c, b0_ - b1_ * c, 0, a0_ + a1_ * c, a0_ - a1_ * c, 0);
  }

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

/** First-order section from (b0 + b1 s) / (a0 + a1 s) through the bilinear transform (util.ts FirstOrder). */
class FirstOrder {
public:
  void reset() { z = 0; }
  void set(double fs, double b0, double b1, double a0, double a1) {
    const double c = 2 * fs, A0 = a0 + a1 * c;
    nb0 = (b0 + b1 * c) / A0; nb1 = (b0 - b1 * c) / A0; na1 = (a0 - a1 * c) / A0;
  }
  void gain(double g) { nb0 = g; nb1 = 0; na1 = 0; }
  double tick(double x) { const double y = nb0 * x + z; z = nb1 * x - na1 * y; return y; }
private:
  double nb0 = 1, nb1 = 0, na1 = 0, z = 0;
};

/** Third-order section from its analog prototype through the bilinear transform (util.ts Cubic). */
class Cubic {
public:
  void reset() { z1 = z2 = z3 = 0; }
  void bypass() { nb0 = 1; nb1 = nb2 = nb3 = na1 = na2 = na3 = 0; }
  void set(double fs, double b0, double b1, double b2, double b3, double a0, double a1, double a2, double a3) {
    const double c = 2 * fs, c2 = c * c, c3 = c2 * c;
    const double B0 = b0 + b1 * c + b2 * c2 + b3 * c3, B1 = 3 * b0 + b1 * c - b2 * c2 - 3 * b3 * c3;
    const double B2 = 3 * b0 - b1 * c - b2 * c2 + 3 * b3 * c3, B3 = b0 - b1 * c + b2 * c2 - b3 * c3;
    const double A0 = a0 + a1 * c + a2 * c2 + a3 * c3, A1 = 3 * a0 + a1 * c - a2 * c2 - 3 * a3 * c3;
    const double A2 = 3 * a0 - a1 * c - a2 * c2 + 3 * a3 * c3, A3 = a0 - a1 * c + a2 * c2 - a3 * c3;
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
  double nb0 = 1, nb1 = 0, nb2 = 0, nb3 = 0, na1 = 0, na2 = 0, na3 = 0, z1 = 0, z2 = 0, z3 = 0;
};

/** Rate of the nonlinear stages: drive and amp run at 8x. */
constexpr int OS = 8;
/** util.ts OS_MAX, DRIVE_RATE, osFactor. */
constexpr int OS_MAX = 32;
constexpr double DRIVE_RATE = 700e3, DRIVE_RATE_HARD = 1400e3, AMP_RATE = 700e3;
inline int osFactor(double fs, double rate, int min = 2) {
  int f = 1;
  while (f < OS_MAX && fs * f < rate * 0.99) f *= 2;
  return std::max(min, f);
}

/** Polyphase IIR halfband coefficients (util.ts halfbandCoefs). */
inline std::vector<double> halfbandCoefs(double attn, double tr) {
  double k = std::tan((1 - 2 * tr) * PI / 4); k *= k;
  const double kk = std::pow(1 - k * k, 0.25), e = 0.5 * (1 - kk) / (1 + kk), e4 = e * e * e * e;
  const double q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const double ap = std::pow(10.0, -attn / 10), a = ap / (1 - ap);
  int order = (int)std::ceil(std::log(a * a / 16) / std::log(q));
  if (order % 2 == 0) order++;
  if (order < 3) order = 3;
  std::vector<double> out;
  for (int c = 1; c <= (order - 1) / 2; c++) {
    double num = 0, den = 0;
    for (int i = 0; i < 30; i++) num += (i % 2 ? -1 : 1) * std::pow(q, i * (i + 1)) * std::sin((2 * i + 1) * c * PI / order);
    for (int i = 1; i < 30; i++) den += (i % 2 ? -1 : 1) * std::pow(q, i * i) * std::cos(2 * i * c * PI / order);
    const double ww = num * std::pow(q, 0.25) / (den + 0.5), w2 = ww * ww;
    const double x = std::sqrt((1 - w2 * k) * (1 - w2 / k)) / (1 + w2);
    out.push_back((1 - x) / (1 + x));
  }
  return out;
}

class Halfband {
public:
  void design(const std::vector<double>& c) {
    n0 = n1 = 0;
    for (size_t i = 0; i < c.size(); i++) { if (i % 2 == 0) c0[n0++] = c[i]; else c1[n1++] = c[i]; }
    reset();
  }
  void reset() { std::fill(x0, x0 + 16, 0.0); std::fill(y0, y0 + 16, 0.0); std::fill(x1, x1 + 16, 0.0); std::fill(y1, y1 + 16, 0.0); }
  double p0(double v) { for (int i = 0; i < n0; i++) { const double o = c0[i] * (v - y0[i]) + x0[i]; x0[i] = v; y0[i] = o; v = o; } return v; }
  double p1(double v) { for (int i = 0; i < n1; i++) { const double o = c1[i] * (v - y1[i]) + x1[i]; x1[i] = v; y1[i] = o; v = o; } return v; }
private:
  double c0[16] = {}, c1[16] = {}, x0[16] = {}, y0[16] = {}, x1[16] = {}, y1[16] = {};
  int n0 = 0, n1 = 0;
};

/** factor-times up/down sampler: cascaded 2x polyphase IIR halfband stages each way (util.ts Oversampler). */
class Oversampler {
public:
  explicit Oversampler(double sampleRate, int factor_ = OS) : factor(factor_) {
    const double fp = std::min(20000.0, sampleRate * 0.45);
    double r = 2 * sampleRate;
    ns = 0;
    for (int s = 0; (1 << s) < factor; s++, r *= 2) {
      const double tr = std::min(0.45, 2 * (r / 4 - fp) / r);
      const auto c = halfbandCoefs(100, tr);
      up[s].design(c); down[s].design(c); ns++;
    }
  }
  void reset() { for (int s = 0; s < ns; s++) { up[s].reset(); down[s].reset(); } }
  void upsample(const float* x, float* out, int n) {
    for (int i = 0; i < n; i++) {
      double* a = bufA; double* b = bufB; int len = 1;
      a[0] = x[i];
      for (int s = 0; s < ns; s++) {
        Halfband& h = up[s];
        for (int j = 0; j < len; j++) { const double v = a[j]; b[2 * j] = h.p0(v); b[2 * j + 1] = h.p1(v); }
        std::swap(a, b); len <<= 1;
      }
      const int o = i * factor;
      for (int j = 0; j < factor; j++) out[o + j] = (float)a[j];
    }
  }
  void downsample(const float* x, float* out, int n) {
    for (int i = 0; i < n; i++) {
      double* a = bufA; double* b = bufB; int len = factor >> 1;
      const int o = i * factor;
      Halfband& top = down[ns - 1];
      for (int j = 0; j < len; j++) a[j] = 0.5 * (top.p0(x[o + 2 * j + 1]) + top.p1(x[o + 2 * j]));
      for (int s = ns - 2; s >= 0; s--) {
        Halfband& h = down[s];
        len >>= 1;
        for (int j = 0; j < len; j++) b[j] = 0.5 * (h.p0(a[2 * j + 1]) + h.p1(a[2 * j]));
        std::swap(a, b);
      }
      out[i] = (float)a[0];
    }
  }
  int factor;
private:
  Halfband up[5], down[5];
  int ns = 0;
  double bufA[OS_MAX] = {}, bufB[OS_MAX] = {};
};

} // namespace pedalboard
