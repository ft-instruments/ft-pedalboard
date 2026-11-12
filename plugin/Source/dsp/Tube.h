// The tubes as tables built once from circuit equations. C++ port of
// src/dsp/tube.ts (see there for the model: the Dempwolf-Zolzer 12AX7 on
// its load line, and the power stage with its feedback solved around it).
#pragma once

#include <vector>
#include "Util.h"

namespace pedalboard {

struct StageKind { double vb, rp, rk; bool bypassed; double rs, mu, g; };

inline const StageKind STAGE_KINDS[] = {
  { 300, 100e3, 1.5e3, true, 68e3, 103.2, 2.242e-3 },
  { 300, 100e3, 1.5e3, false, 68e3, 103.2, 2.242e-3 },
  { 300, 100e3, 2.7e3, true, 68e3, 103.2, 2.242e-3 },
  { 300, 100e3, 10e3, false, 100e3, 103.2, 2.242e-3 },
  { 300, 100e3, 39e3, false, 220e3, 103.2, 2.242e-3 },
  { 300, 220e3, 1.8e3, true, 68e3, 103.2, 2.242e-3 },
  { 300, 100e3, 1.8e3, true, 68e3, 103.2, 2.242e-3 },
  { 300, 220e3, 1.8e3, true, 470e3, 103.2, 2.242e-3 },
  { 300, 100e3, 820, true, 68e3, 103.2, 2.242e-3 },
  { 300, 220e3, 1.5e3, true, 68e3, 103.2, 2.242e-3 },
  { 300, 100e3, 1.5e3, true, 68e3, 44, 1.56e-3 },   // 12AY7 (tube.ts kind 10)
};
constexpr int NKINDS = 11;

constexpr double TMU = 103.2;

namespace tube {
constexpr double TG = 2.242e-3, TC = 3.40, TGAMMA = 1.26, TGG = 6.177e-4, TCG = 9.901, TXI = 1.314, TIG0 = 8.025e-8;

inline double softplus(double x, double c) { const double t = c * x; return t > 40 ? x : std::log(1 + std::exp(t)) / c; }
inline double cathodeCurrent(double vpk, double vgk, double mu = TMU, double g = TG) { return g * std::pow(softplus(vpk / mu + vgk, TC), TGAMMA); }
inline double gridCurrent(double vgk) { return TGG * std::pow(softplus(vgk, TCG), TXI) + TIG0; }

template <class F> inline double newton(F r, double x) {
  for (int k = 0; k < 8; k++) { const double f = r(x); x -= f * 1e-10 / (r(x + 1e-10) - f); }
  return x;
}
} // namespace tube

constexpr double TUBE_LO = -16, TUBE_HI = 64;
constexpr int TUBE_N = 8192;
constexpr double TUBE_INV = (TUBE_N - 1) / (TUBE_HI - TUBE_LO);
constexpr int TUBE_SWEEP = 8192;

/** tube.ts tableAt / tableInt / antiderivative: a table's curve, its antiderivative (zero at x = 0), for first-order ADAA. */
inline double tableAt(const double* y, int N, double lo, double inv, double x, double hiSlope) {
  const double p = (x - lo) * inv;
  if (p <= 0) return y[0];
  if (p >= N - 1) return y[N - 1] + (x - lo - (N - 1) / inv) * hiSlope;
  const int j = (int)p; const double f = p - j;
  return y[j] + f * (y[j + 1] - y[j]);
}
inline double tableInt(const double* y, const double* F, int N, double lo, double inv, double x, double hiSlope) {
  const double p = (x - lo) * inv;
  if (p <= 0) return F[0] + y[0] * (x - lo);
  if (p >= N - 1) { const double d = x - lo - (N - 1) / inv; return F[N - 1] + d * (y[N - 1] + 0.5 * hiSlope * d); }
  const int j = (int)p; const double f = p - j;
  return F[j] + (y[j] + 0.5 * (y[j + 1] - y[j]) * f) * f / inv;
}
inline std::vector<double> antiderivative(const std::vector<double>& y, double lo, double inv, double hiSlope) {
  const int N = (int)y.size();
  std::vector<double> F((size_t)N, 0.0);
  for (int j = 1; j < N; j++) F[j] = F[j - 1] + 0.5 * (y[j - 1] + y[j]) / inv;
  const double F0 = tableInt(y.data(), F.data(), N, lo, inv, 0, hiSlope);
  for (int j = 0; j < N; j++) F[j] -= F0;
  return F;
}
constexpr double ADAA_EPS = 1e-6;

class StageTable {
public:
  std::vector<double> vp, ig, Fvp, Fig;
  double rs, knee = 1, gain = 0, mu = 103.2;

  explicit StageTable(const StageKind& k) : vp(TUBE_N), ig(TUBE_N), rs(k.rs) {
    using namespace tube;
    const double vb = k.vb, rp = k.rp, rk = k.rk, rsk = k.rs;
    const double mu_ = k.mu, G = k.g;
    mu = mu_;
    const double ik0 = newton([&](double i) { return i - cathodeCurrent(vb - (rp + rk) * i, -rk * i, mu_, G); }, 1e-3);
    const double vk0 = rk * ik0;
    std::vector<double> vn(TUBE_SWEEP), vpa(TUBE_SWEEP), iga(TUBE_SWEEP);
    double kn = 0, cur = 0;
    for (int s = 0; s < TUBE_SWEEP; s++) {
      const double vgk = -30 + 33.5 * s / (TUBE_SWEEP - 1);
      const double g = gridCurrent(vgk);
      double ip, vk;
      if (k.bypassed) {
        vk = vk0;
        ip = cur = newton([&](double i) { return i - (cathodeCurrent(vb - rp * i - vk0, vgk, mu_, G) - g); }, cur);
      } else {
        const double ik = cur = newton([&](double i) { return i - cathodeCurrent(vb - rp * (i - g) - rk * i, vgk, mu_, G); }, cur);
        ip = ik - g; vk = rk * ik;
      }
      vn[s] = vgk + vk + rsk * g;
      vpa[s] = vb - rp * ip;
      iga[s] = g;
      if (vgk <= 0) kn = vn[s];
    }
    knee = kn;
    int m = 0;
    for (int j = 0; j < TUBE_N; j++) {
      const double x = TUBE_LO + j / TUBE_INV;
      while (m < TUBE_SWEEP - 2 && vn[m + 1] < x) m++;
      const double f = std::min(1.0, std::max(0.0, (x - vn[m]) / (vn[m + 1] - vn[m])));
      vp[j] = vpa[m] + f * (vpa[m + 1] - vpa[m]);
      ig[j] = iga[m] + f * (iga[m + 1] - iga[m]);
    }
    const double p0 = -TUBE_LO * TUBE_INV;
    const int i0 = (int)std::floor(p0);
    const double f0 = p0 - i0;
    const double vp0 = vp[i0] + f0 * (vp[i0 + 1] - vp[i0]);
    const double ig0 = ig[i0] + f0 * (ig[i0 + 1] - ig[i0]);
    for (int j = 0; j < TUBE_N; j++) { vp[j] -= vp0; ig[j] -= ig0; }
    gain = (vp[i0 + 4] - vp[i0 - 4]) * TUBE_INV / 8;
    Fvp = antiderivative(vp, TUBE_LO, TUBE_INV, 0);
    Fig = antiderivative(ig, TUBE_LO, TUBE_INV, 1 / rs);
  }
};

constexpr double CF_LO = -260, CF_HI = 260;
constexpr int CF_N = 4096;
constexpr double CF_INV = (CF_N - 1) / (CF_HI - CF_LO);

/** The DC-coupled cathode follower before the tone stack (tube.ts FollowerTable). */
class FollowerTable {
public:
  std::vector<double> y, F;
  double gain = 0;
  explicit FollowerTable(double vb = 300, double rk = 100e3, double rdrive = 100e3, double vg0 = 180) : y(CF_N) {
    using namespace tube;
    std::vector<double> vo(TUBE_SWEEP), vk(TUBE_SWEEP);
    double cur = 1e-3;
    for (int s = 0; s < TUBE_SWEEP; s++) {
      const double vgk = -60 + 63.0 * s / (TUBE_SWEEP - 1);
      const double ik = cur = newton([&](double i) { return i - cathodeCurrent(vb - rk * i, vgk); }, cur);
      vk[s] = rk * ik;
      vo[s] = vk[s] + vgk + rdrive * gridCurrent(vgk);
    }
    int m = 0;
    auto at = [&](double x) {
      while (m < TUBE_SWEEP - 2 && vo[m + 1] < x) m++;
      while (m > 0 && vo[m] > x) m--;
      const double f = std::min(1.0, std::max(0.0, (x - vo[m]) / (vo[m + 1] - vo[m])));
      return vk[m] + f * (vk[m + 1] - vk[m]);
    };
    const double k0 = at(vg0);
    m = 0;
    for (int j = 0; j < CF_N; j++) y[j] = at(vg0 + CF_LO + j / CF_INV) - k0;
    const int c = (int)jsRound(-CF_LO * CF_INV);
    gain = (y[c + 2] - y[c - 2]) * CF_INV / 4;
    F = antiderivative(y, CF_LO, CF_INV, 0);
  }
};

struct PowerParts { bool se; double cut, nfb, imb, pi, knee, zp; };

constexpr double PA_R = 12;
constexpr int PA_N = 2048;
constexpr double PA_INV = (PA_N - 1) / (2 * PA_R);

class PowerTable {
public:
  std::vector<double> y, F;
  double scale = 1;

  explicit PowerTable(const PowerParts& p) : y(PA_N) {
    using namespace tube;
    const double im = 0.85 * std::pow(1 + p.cut, 1.5);
    auto outputTube = [&](double v) {
      const double g = v - 0.92 * softplus(v - 1, 12);
      const double i = std::pow(softplus(g + p.cut, 14), 1.5);
      return i / std::pow(1 + std::pow(i / im, p.knee), 1 / p.knee);
    };
    const double idle = outputTube(0);
    auto open = [&](double x) {
      const double v = p.pi * std::tanh(x / p.pi);
      if (p.se) return outputTube(v) - idle;
      return (1 + p.imb) * outputTube(v) - (1 - p.imb) * outputTube(-v) - 2 * p.imb * idle;
    };
    const double h = 1e-4;
    const double a0 = (open(h) - open(-h)) / (2 * h);
    const double top = open(50);
    const double beta = p.nfb / a0;
    const double scale = top * (1 + p.nfb) / a0;
    this->scale = scale;
    const double E = PA_R * scale;
    std::vector<double> xs(TUBE_SWEEP), ys(TUBE_SWEEP);
    for (int s = 0; s < TUBE_SWEEP; s++) { const double e = E * (2.0 * s / (TUBE_SWEEP - 1) - 1); ys[s] = open(e); xs[s] = e + beta * ys[s]; }
    int m = 0;
    for (int j = 0; j < PA_N; j++) {
      const double x = PA_R * (2.0 * j / (PA_N - 1) - 1) * scale;
      while (m < TUBE_SWEEP - 2 && xs[m + 1] < x) m++;
      const double f = std::min(1.0, std::max(0.0, (x - xs[m]) / (xs[m + 1] - xs[m])));
      y[j] = (ys[m] + f * (ys[m + 1] - ys[m])) / top;
    }
    F = antiderivative(y, -PA_R, PA_INV, 0);
  }
};

} // namespace pedalboard
