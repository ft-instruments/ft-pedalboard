// The mono modules: gate, compressor, the drives, the tone stack, the
// amp, the cabinet and the EQ. C++ ports of src/dsp/gate.ts, comp.ts,
// drive.ts (its networks in Net.h), tonestack.ts, amp.ts (its tube tables in Tube.h), cab.ts and eq.ts.
//
// Porting convention (as in Util.h): a TS number is a double, a
// Float32Array element is a float; stores round to float exactly where the
// TS stores into a Float32Array.
#pragma once

#include <vector>
#include <memory>
#include <mutex>
#include "Util.h"
#include "Tube.h"
#include "Net.h"

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
  void reset() { peak = 0; gr = 0; memory = 0; hold = 0; reduction = 0; }
  void process(float* x, int n, double sustain, double attack, double release, double levelDb, double blend) {
    constexpr double DI_PEAK_DB = -14, MAX_MAKEUP_DB = 18, PEAK_DB = 6, KNEE_DB = 10, MEMORY_S = 1.5, HEAVY_DB = 10, HOLD_S = 0.025;
    const double thrDb = -12 - 30 * sustain;
    const double ratio = 2 + 8 * sustain;
    const double slope = 1 - 1 / ratio;
    const double makeupDb = std::min(MAX_MAKEUP_DB, std::max(0.0, -thrDb + DI_PEAK_DB) * (1 - 1 / ratio));
    const double wet = dbToGain(makeupDb + levelDb) * blend;
    const double dry = (1 - blend) * dbToGain(levelDb);
    const double aA = std::exp(-1 / (attack * fs));
    const double relK = -1 / (release * fs);
    const double memK = 1 - std::exp(-1 / (MEMORY_S * fs));
    const double half = KNEE_DB / 2, k2 = slope / (2 * KNEE_DB);
    const int holdN = (int)jsRound(HOLD_S * fs);
    double pk = peak, g = gr, mem = memory, maxGr = 0; int h = hold;
    for (int i = 0; i < n; i++) {
      const double v = x[i];
      const double over = 20 * std::log10(std::abs(v) + 1e-9) - thrDb - PEAK_DB;
      const double want = over <= -half ? 0 : over >= half ? slope * over : k2 * (over + half) * (over + half);
      if (want > pk - 0.5) h = holdN;
      if (want > pk) pk = want;
      else if (h > 0) h--;
      else { const double aR = std::exp(relK / (1 + 2 * mem)); pk = aR * pk + (1 - aR) * want; }
      g = aA * g + (1 - aA) * pk;
      mem += ((g > HEAVY_DB ? 1 : g / HEAVY_DB) - mem) * memK;
      if (g > maxGr) maxGr = g;
      x[i] = (float)(v * (dbToGain(-g) * wet + dry));
    }
    peak = pk; gr = g; memory = mem; hold = h;
    reduction = maxGr;
  }
private:
  double peak = 0, gr = 0, memory = 0; int hold = 0;
  double fs;
};

// ---- drive.ts --------------------------------------------------------------

/** (b2 s^2 + b1 s + b0) / (a2 s^2 + a1 s + a0) through the bilinear transform (gtone.ts bilinear2). */
inline void bilinear2(Biquad& q, double fs, double b2, double b1, double b0, double a2, double a1, double a0) {
  const double c = 2 * fs, c2 = c * c;
  const double A0 = a2 * c2 + a1 * c + a0;
  q.b0 = (b2 * c2 + b1 * c + b0) / A0; q.b1 = (2 * b0 - 2 * b2 * c2) / A0; q.b2 = (b2 * c2 - b1 * c + b0) / A0;
  q.a1 = (2 * a0 - 2 * a2 * c2) / A0; q.a2 = (a2 * c2 - a1 * c + a0) / A0;
}

constexpr int DRIVE_GLOW = 0, DRIVE_RASP = 1, DRIVE_FUZZ = 2, DRIVE_MUFF = 3, DRIVE_BOOST = 4, DRIVE_TRANSPARENT = 5, DRIVE_METAL = 6, DRIVE_OCTAVE = 7;

constexpr double DIODE_IS = 2.52e-9, DIODE_NVT = 1.752 * 0.02585;
/** Antiparallel diodes across R: the exact Shockley solution of v + 2 Is R sinh(v / nVt) = u (drive.ts). */
inline double diodePairOf(double u, double r, double is, double nvt) {
  const double a = std::abs(u), b = 2 * is * r;
  double w = std::min(a / nvt, std::asinh(a / b));
  for (int k = 0; k < 5; k++) { const double e = std::exp(w), ie = 1 / e; w -= (nvt * w + b * 0.5 * (e - ie) - a) / (nvt + b * 0.5 * (e + ie)); }
  return u < 0 ? -nvt * w : nvt * w;
}
inline double diodePair(double u, double r) { return diodePairOf(u, r, DIODE_IS, DIODE_NVT); }
/** Two diodes that differ (drive.ts diodeAsym). */
inline double diodeAsym(double u, double r, double is1, double is2, double nvt) {
  double v = diodePairOf(u, r, u >= 0 ? is1 : is2, nvt);
  for (int k = 0; k < 4; k++) {
    const double ep = std::exp(v / nvt), en = 1 / ep;
    v -= (v + r * (is1 * (ep - 1) - is2 * (en - 1)) - u) / (1 + r * (is1 * ep + is2 * en) / nvt);
  }
  return v;
}
/** 1N34A germanium: the Klon's clippers. */
constexpr double GE_IS = 2e-7, GE_NVT = 1.3 * 0.02585;

/** diodePair for one resistance as a table, with its antiderivative (drive.ts DiodeTable). */
constexpr int DT_N = 2048;
constexpr double DT_MAX = 8, DT_INV = (DT_N - 1) / DT_MAX;
class DiodeTable {
public:
  double b = 1, r = -1;
  double is, nvt;
  explicit DiodeTable(double rr, double is_ = DIODE_IS, double nvt_ = DIODE_NVT) : is(is_), nvt(nvt_), y(DT_N), F(DT_N) { build(rr); }
  void build(double rr) {
    if (rr == r) return;
    r = rr; b = 2 * is * rr;
    for (int j = 0; j < DT_N; j++) y[(size_t)j] = diodePairOf(j / DT_INV, rr, is, nvt);
    F[0] = 0;
    for (int j = 1; j < DT_N; j++) F[(size_t)j] = F[(size_t)(j - 1)] + 0.5 * (y[(size_t)(j - 1)] + y[(size_t)j]) / DT_INV;
  }
  double at(double u) const {
    const double a = std::abs(u), p = a * DT_INV;
    double v;
    if (p >= DT_N - 1) v = nvt * std::asinh((a - y[DT_N - 1]) / b);
    else { const int j = (int)p; const double f = p - j; v = y[(size_t)j] + f * (y[(size_t)(j + 1)] - y[(size_t)j]); }
    return u < 0 ? -v : v;
  }
  double integral(double u) const {
    const double a = std::abs(u), p = a * DT_INV;
    if (p >= DT_N - 1) return F[DT_N - 1] + (a - DT_MAX) * at(0.5 * (a + DT_MAX));
    const int j = (int)p; const double f = p - j, d = y[(size_t)(j + 1)] - y[(size_t)j];
    return F[(size_t)j] + (y[(size_t)j] * f + 0.5 * d * f * f) / DT_INV;
  }
  double adaa(double u, double u1) const {
    const double d = u - u1;
    if (d > 1e-5 || d < -1e-5) return (integral(u) - integral(u1)) / d;
    return at(0.5 * (u + u1));
  }
private:
  std::vector<double> y, F;
};
/** Tables whose resistance only depends on the sample rate, shared by every drive (drive.ts sharedTable). */
inline const DiodeTable* sharedTable(double r, double is = DIODE_IS, double nvt = DIODE_NVT) {
  static std::mutex lock;
  static std::vector<std::unique_ptr<DiodeTable>> tables;
  std::lock_guard<std::mutex> g(lock);
  for (auto& t : tables) if (t->r == r && t->is == is && t->nvt == nvt) return t.get();
  tables.push_back(std::make_unique<DiodeTable>(r, is, nvt));
  return tables.back().get();
}
inline const DiodeTable& sharedGround() { static const DiodeTable t(1e3); return t; }

/** diodeAsym as a table, for a resistance that moves with a knob (drive.ts AsymTable). */
constexpr int AT_N = 2 * DT_N - 1;
constexpr double AT_INV = (AT_N - 1) / (2 * DT_MAX);
class AsymTable {
public:
  double r = -1;
  AsymTable(double is1_, double is2_, double nvt_) : y(AT_N), is1(is1_), is2(is2_), nvt(nvt_) {}
  void build(double rr) {
    if (rr == r) return;
    r = rr;
    for (int j = 0; j < AT_N; j++) y[(size_t)j] = diodeAsym(j / AT_INV - DT_MAX, rr, is1, is2, nvt);
  }
  double at(double u) const {
    const double p = (u + DT_MAX) * AT_INV;
    if (p >= AT_N - 1) return nvt * std::asinh((u - y[AT_N - 1]) / (2 * is1 * r));
    if (p <= 0) return -nvt * std::asinh((y[0] - u) / (2 * is2 * r));
    const int j = (int)p; const double f = p - j;
    return y[(size_t)j] + f * (y[(size_t)(j + 1)] - y[(size_t)j]);
  }
private:
  std::vector<double> y;
  double is1, is2, nvt;
};
inline double quantR(double r) { return std::exp(jsRound(std::log(r) * 400) / 400); }

inline double germanium(double v) { return v >= 0 ? tanhf_(v) : 0.62 * tanhf_(v / 0.62); }
inline double rails(double v, double rail) { const double t = v / rail, t2 = t * t; return v / std::sqrt(std::sqrt(1 + t2 * t2)); }
inline double knee(double x, double k) { const double t = x / k; return t > 30 ? x : t < -30 ? 0 : k * std::log(1 + std::exp(t)); }
inline double audioTaper(double g) { return (std::pow(81.0, g) - 1) / 80; }

constexpr double TS_R1 = 4.7e3, TS_CZ = 47e-9, TS_CC = 51e-12, TS_ASYM = 2;
inline double glowR(double g) { return 51e3 + 500e3 * audioTaper(g); }
constexpr double TS_WARP = 3000;
/** The TS tone stage from its circuit (drive.ts tsTone). */
inline void tsTone(Biquad& q, double fs, double t) {
  const double Rs = 1e3, Cs = 0.22e-6, Ri = 10e3, Rf = 1e3, Rz = 220, Cz = 0.22e-6, Rp = 20e3;
  const double Rl = std::max(1.0, t * Rp), Rr = std::max(1.0, (1 - t) * Rp), P = Rl * Rr / (Rl + Rr);
  const double tau = Cz * (Rz + P), aL = Cz * Rr / (Rl + Rr), aR = Rf * Cz * Rl / (Rl + Rr), G0 = 1 / Rs + 1 / Ri;
  const double w0 = 2 * PI * TS_WARP, fw = w0 / (2 * std::tan(w0 / (2 * fs)));
  bilinear2(q, fw, 0, (tau + aR) / Rs, 1 / Rs, Cs * tau, G0 * tau + Cs + aL, G0);
}

constexpr double RAT_GBW = 2 * PI * 1e6, RAT_SR = 0.3e6, RAT_RAIL = 3.6, RAT_CF = 100e-12;
constexpr double RAT_RA = 47, RAT_CA = 2.2e-6, RAT_RB = 560, RAT_CB = 4.7e-6;
inline double raspPot(double g) { return 100 + 100e3 * g * g * std::sqrt(g); }
inline double d308(double x) { if (x > 3 || x < -3) return 0; const double x2 = x * x, d = 27 + 9 * x2, m = 9 - x2; return 9 * m * m / (d * d); }

constexpr double MUFF_RF = 470e3, MUFF_CF = 470e-12, MUFF_RG1 = 39e3, MUFF_RG = 10e3, MUFF_CC = 1e-6, MUFF_CD = 1e-6;
constexpr double MUFF_ROUT = 5e3, MUFF_GOUT = -4.5;
constexpr double MUFF_A_LF = 40, MUFF_A_HF = 730, MUFF_WC = 1 / (MUFF_RF * MUFF_CF), MUFF_UP = 4.9, MUFF_DOWN = 3.9;

// ---- drive.ts: the Fuzz Face ------------------------------------------------

constexpr double FF_VCC = 9, FF_RC1 = 33e3, FF_RC2 = 8.67e3, FF_RF = 100e3, FF_RE = 1e3, FF_CE = 20e-6, FF_C1 = 2.2e-6;
constexpr double FF_IS = 1e-6, FF_VT = 0.0259, FF_B1 = 70, FF_B2 = 110, FF_BR = 4;
constexpr double FF_CEB = 410e-12, FF_CCB = 20e-12, FF_ICBO = 0.3e-6;
constexpr int FF_STEPS = 6, FF_MAX_STEPS = 40;
constexpr double FF_ISF1 = FF_IS / FF_B1, FF_ISF2 = FF_IS / FF_B2, FF_ISR = FF_IS / FF_BR;
/** pickup.ts */
constexpr double PICKUP_R = 6.5e3, PICKUP_L = 2.6, PICKUP_CP = 120e-12, CABLE_C = 600e-12, PICKUP_C = PICKUP_CP + CABLE_C, PICKUP_EDDY = 150e3, DI_LOAD = 1e6;
constexpr double BUFFER_R = 1e3;
inline double jexp(double v) { return std::exp(v > 40 ? 40 : v); }
/** drive.ts FF_VCRIT and pnjlim: SPICE's junction limiting. */
inline const double FF_VCRIT = FF_VT * std::log(FF_VT / (std::sqrt(2.0) * FF_IS));
inline double pnjlim(double vnew, double vold) {
  if (vnew > FF_VCRIT && std::abs(vnew - vold) > 2 * FF_VT) {
    if (vold > 0) { const double arg = 1 + (vnew - vold) / FF_VT; return arg > 0 ? vold + FF_VT * std::log(arg) : FF_VCRIT; }
    return FF_VT * std::log(vnew / FF_VT);
  }
  return vnew;
}

/** J d = -F for a 4x4 (drive.ts solve4). */
inline void solve4(double* J, const double* F, double* d) {
  for (int i = 0; i < 4; i++) d[i] = -F[i];
  for (int c = 0; c < 4; c++) {
    int p = c;
    for (int r = c + 1; r < 4; r++) if (std::abs(J[r * 4 + c]) > std::abs(J[p * 4 + c])) p = r;
    if (p != c) { for (int k = 0; k < 4; k++) std::swap(J[c * 4 + k], J[p * 4 + k]); std::swap(d[c], d[p]); }
    const double inv = 1 / J[c * 4 + c];
    for (int r = c + 1; r < 4; r++) {
      const double f = J[r * 4 + c] * inv;
      if (f == 0) continue;
      for (int k = c; k < 4; k++) J[r * 4 + k] -= f * J[c * 4 + k];
      d[r] -= f * d[c];
    }
  }
  for (int r = 3; r >= 0; r--) {
    double s = d[r];
    for (int k = r + 1; k < 4; k++) s -= J[r * 4 + k] * d[k];
    d[r] = s / J[r * 4 + r];
  }
}

class FuzzFace {
public:
  double vb = 0.15, vc = 0.5, ve = 0.35, vk = 4.5;
  double vC1 = 0, iL = 0, vw = 0;
  double kdc = 4.5;
  int faults = 0;
  explicit FuzzFace(double fsOs) : T(1 / fsOs) { reset(); }
  void reset() {
    vb = 0.15; vc = 0.5; ve = 0.35; vk = 4.5;
    solve(0, 0, 1 / FF_RE, 0, 0, 80);
    kdc = vk;
    vC1 = -vb; iL = 0;
    vw = 0; fresh = true;
  }
  void solve(double vin, double gin, double geq, double jeq, double cs, int steps) {
    const double b0 = vb, c0 = vc, e0 = ve, k0 = vk;
    double b = b0, c = c0, e = e0, k = k0;
    const double gf = 1 / FF_RF, iv = 1 / FF_VT, gb = cs * FF_CEB / T, gm = cs * FF_CCB / T;
    double J[16], F[4], d[4];
    for (int it = 0; it < steps; it++) {
      const double ef1 = jexp(b * iv), er1 = jexp((b - c) * iv), ef2 = jexp((c - e) * iv), er2 = jexp((c - k) * iv);
      const double ic1 = FF_IS * (ef1 - er1) - FF_ISR * (er1 - 1), ib1 = FF_ISF1 * (ef1 - 1) + FF_ISR * (er1 - 1);
      const double ic2 = FF_IS * (ef2 - er2) - FF_ISR * (er2 - 1), ib2 = FF_ISF2 * (ef2 - 1) + FF_ISR * (er2 - 1);
      const double qb1 = gb * (b - b0), qm1 = gm * ((b - c) - (b0 - c0)), qe2 = gb * ((c - e) - (c0 - e0)), qm2 = gm * ((c - k) - (c0 - k0));
      F[0] = gin * (vin - b) + gf * (e - b) - ib1 + FF_ICBO - qb1 - qm1;
      F[1] = (FF_VCC - c) / FF_RC1 - ic1 - ib2 + qm1 - qe2 - qm2;
      F[2] = ic2 + ib2 - gf * (e - b) - (geq * e - jeq) + qe2;
      F[3] = (FF_VCC - k) / FF_RC2 - ic2 - FF_ICBO + qm2;
      const double df1 = ef1 * iv, dr1 = er1 * iv, df2 = ef2 * iv, dr2 = er2 * iv;
      const double ic1b = FF_IS * df1 - (FF_IS + FF_ISR) * dr1, ic1c = (FF_IS + FF_ISR) * dr1;
      const double ib1b = FF_ISF1 * df1 + FF_ISR * dr1, ib1c = -FF_ISR * dr1;
      const double ic2c = FF_IS * df2 - (FF_IS + FF_ISR) * dr2, ic2e = -FF_IS * df2, ic2k = (FF_IS + FF_ISR) * dr2;
      const double ib2c = FF_ISF2 * df2 + FF_ISR * dr2, ib2e = -FF_ISF2 * df2, ib2k = -FF_ISR * dr2;
      J[0] = -gin - gf - ib1b - gb - gm; J[1] = -ib1c + gm; J[2] = gf; J[3] = 0;
      J[4] = -ic1b + gm; J[5] = -1 / FF_RC1 - ic1c - ib2c - 2 * gm - gb; J[6] = -ib2e + gb; J[7] = -ib2k + gm;
      J[8] = gf; J[9] = ic2c + ib2c + gb; J[10] = ic2e + ib2e - gf - geq - gb; J[11] = ic2k + ib2k;
      J[12] = 0; J[13] = -ic2c + gm; J[14] = -ic2e; J[15] = -1 / FF_RC2 - ic2k - gm;
      solve4(J, F, d);
      const double nb = b + d[0], nc = c + d[1], ne = e + d[2], nk = k + d[3];
      const double j1 = pnjlim(nb, b), j2 = pnjlim(nb - nc, b - c), j3 = pnjlim(nc - ne, c - e), j4 = pnjlim(nc - nk, c - k);
      const double lb = j1, lc = lb - j2, le = lc - j3, lk = lc - j4;
      const double moved = std::abs(lb - b) + std::abs(lc - c) + std::abs(le - e) + std::abs(lk - k);
      const bool limited = j1 != nb || j2 != nb - nc || j3 != nc - ne || j4 != nc - nk;
      b = lb; c = lc; e = le; k = lk;
      if (moved < 1e-5 && !limited) break;
      if (it + 1 == steps && steps < FF_MAX_STEPS) steps = FF_MAX_STEPS;
    }
    if (std::isfinite(b) && std::isfinite(c) && std::isfinite(e) && std::isfinite(k)) { vb = b; vc = c; ve = e; vk = k; }
    else { vb = b0; vc = c0; ve = e0; vk = k0; faults++; }
  }
  double tick(double vs, double rs, double ls, double ra, double rb) {
    const double lt = ls / T, tc = T / FF_C1;
    const double gin = 1 / (rs + lt + tc);
    const double vin = vs - vC1 + lt * iL;
    if (fresh) { vw = ve * rb / (ra + rb); fresh = false; }
    const double ga = 1 / ra, gbb = 1 / rb, cg = FF_CE / T, D = ga + gbb + cg;
    const double geq = ga * (1 - ga / D), jeq = ga * cg * vw / D;
    solve(vin, gin, geq, jeq, 1, FF_STEPS);
    const double i = gin * (vin - vb);
    iL = i; vC1 += tc * i;
    vw = (ga * ve + cg * vw) / D;
    return vk - kdc;
  }
private:
  double T;
  bool fresh = true;
};

constexpr double RM_IE = 0.26e-3, RM_RC = 10e3, RM_VT = 0.0259, RM_SAT = 5.3, RM_BIAS = 59e3, RM_BETA = 100;
constexpr double KL_R20 = 392e3, KL_C13 = 820e-12, KL_R11 = 15e3, KL_R12 = 422e3, KL_C7 = 82e-9, KL_C8 = 390e-12;
constexpr double KL_RAIL_P = 11.7, KL_RAIL_N = 13.1;

class Drive {
public:
  double push = 0, peakIn = 0;

  explicit Drive(double sampleRate)
    : factor(osFactor(sampleRate, DRIVE_RATE)), factorHard(osFactor(sampleRate, DRIVE_RATE_HARD)),
      os(sampleRate, factor), os2(sampleRate, factor), osHard(sampleRate, factorHard), fs(sampleRate), fsOs(sampleRate * factor), fsHard(sampleRate * factorHard),
      gHp(fsOs, 1 / (2 * PI * TS_R1 * TS_CZ)), gTable(DIODE_IS, DIODE_IS * TS_ASYM, DIODE_NVT), inHp2(sampleRate, 15.6),
      rHp(fsHard, 1 / (2 * PI * 1e3 * 4.7e-6)), rLp(fsHard, 20000),
      ff(fsHard), fDc(sampleRate, 1 / (2 * PI * 500e3 * 10e-9)), fLp(sampleRate, 20000),
      mStack(4, sampleRate), kPre(3, sampleRate), kFf2(6, sampleRate), kClip(3, sampleRate * factor),
      oHp(fsHard, 140), oDc(fsHard, 60), oLp(fsHard, 6000),
      xHp1(fsHard, 1 / (2 * PI * 4.7e3 * 150e-9)), xLp1(fsHard, 5000), xHp2(fsHard, 1 / (2 * PI * 2.2e3 * 1e-6)),
      tone(sampleRate, 3000), tone2(sampleRate, 9000), inHp(sampleRate, 25) {
    const double T = 1 / fsOs, TH = 1 / fsHard;
    up.assign((size_t)MAX_BLOCK * factorHard, 0.f); aux.assign((size_t)MAX_BLOCK * factorHard, 0.f); aux2.assign((size_t)MAX_BLOCK * factorHard, 0.f); ff1.assign((size_t)MAX_BLOCK, 0.f);
    const double A = 1 / MUFF_RF + MUFF_CF / T, B = 1 + A * T / MUFF_CD;
    mTable = sharedTable(B / A);
    mStack.r(1, 2, MUFF_ROUT); mStack.r(2, 3, 39e3); mStack.c(3, 0, 10e-9); mStack.c(2, 4, 4e-9); mStack.r(4, 0, 22e3);
    mPotA = mStack.r(3, 5, 50e3); mPotB = mStack.r(5, 4, 50e3); mStack.r(5, 0, 100e3);
    kPre.c(1, 2, 0.1e-6); kPre.r(2, 3, 10e3); kPre.c(2, 3, 68e-9); kRg = kPre.r(3, 0, 50e3);
    kPre.r(2, 4, 1.5e3); kPre.r(4, 0, 15e3); kPre.c(4, 0, 1e-6);
    kFf2.r(1, 2, 5.1e3); kFf2.c(1, 2, 68e-9); kFf2.r(2, 0, 1.5e3); kFf2.c(2, 4, 390e-9); kFf2.r(4, 0, 1e3);
    kTop = kFf2.r(2, 3, 50e3); kBot = kFf2.r(3, 0, 50e3);
    kFf2.c(3, 5, 2.2e-9); kFf2.r(5, 6, 22e3); kFf2.r(6, 0, 47e3); kFf2.c(3, 7, 27e-9); kFf2.r(7, 0, 12e3); kFf2.r(3, 0, 27e3);
    kClip.c(1, 2, 1e-6); kClip.r(2, 3, 1e3); kClip.c(3, 4, 1e-6); kClip.r(4, 0, 47e3);
    kTable = sharedTable(kClip.rth(3), GE_IS, GE_NVT);
    kSum.set(sampleRate, KL_R20, 0, 1, KL_R20 * KL_C13);
    xMid.peak(fsHard, 1000, 0.7, 8);
    xTable2 = sharedTable(1 / (470e-12 / TH + 1 / 100e3));
    xTable3 = sharedTable(1 / (1 / 2.2e3 + 10e-9 / TH));
    xScoop.peak(sampleRate, 750, 0.8, -7);
    bOut.set(sampleRate, 1 / (2 * PI * 1e6 * 10e-9));
    const double rd = 1 / (1 / DI_LOAD + 1 / PICKUP_EDDY), LC = PICKUP_L * PICKUP_C, a0 = 1 + PICKUP_R / rd;
    bilinear2(diBq, sampleRate, LC, PICKUP_L / rd + PICKUP_R * PICKUP_C, a0, LC, std::sqrt(2.0) * std::sqrt(LC * a0), a0);
  }

  void reset() {
    os.reset(); os2.reset(); osHard.reset(); ff.reset(); fDc.reset(); fLp.z = 0; bI = 0; bVc = 0; bU = 0;
    gHp.reset(); gV = 0; gTone.reset(); inHp2.reset();
    rVo = 0; rVn = 0; rVa = 0; rVb = 0; rW = 0; rHp.reset(); rLp.z = 0;
    mI = 0; mC = 0; mV1 = 0; mC2 = 0; mV2 = 0; mD2 = 0; mC3 = 0; mV3 = 0; mD3 = 0; mStack.reset(); mK1.reset(); mK2.reset(); mK3.reset();
    kPre.reset(); kFf2.reset(); kAmp.reset(); kClip.reset(); kSum.reset(); kTone.reset();
    oHp.reset(); oDc.reset(); oLp.z = 0;
    xHp1.reset(); xLp1.z = 0; xMid.reset(); xHp2.reset(); xV2 = 0; xV3 = 0; xScoop.reset();
    tone.z = 0; tone2.z = 0; inHp.reset(); diBq.reset(); bOut.reset();
  }

  void process(float* x, int n, int type, double gain, double toneKnob, double levelDb, double srcR = BUFFER_R, double srcL = 0) {
    static constexpr double IN_HP[8] = { 15.9, 7.2, 3, 3, 3, 1.6, 20, 20 };
    static constexpr int HARD[8] = { 0, 1, 1, 0, 0, 0, 1, 1 };
    if (type != lastType) { reset(); lastType = type; }
    Oversampler& o = HARD[type] ? osHard : os;
    const double fo = fs * o.factor, T = 1 / fo;
    double pk = 0;
    inHp.set(fs, IN_HP[type]);
    const bool loads = srcL > 0 && (type == DRIVE_FUZZ || type == DRIVE_MUFF || type == DRIVE_BOOST);
    for (int i = 0; i < n; i++) {
      double v = inHp.tick(x[i]);
      if (type == DRIVE_GLOW) v = inHp2.tick(v);
      if (loads) v = diBq.tick(v);
      x[i] = (float)v;
      const double a = std::abs(v); if (a > pk) pk = a;
    }
    peakIn = pk;
    float* u0 = up.data();
    const int m = n * o.factor;
    const double out = dbToGain(levelDb - 12);
    double p = 0;
    if (type == DRIVE_TRANSPARENT) {
      if (gain != kGain) {
        kGain = gain;
        kPre.setR(kRg, std::max(1.0, gain * 100e3));
        kFf2.setR(kTop, std::max(1.0, gain * 100e3)); kFf2.setR(kBot, std::max(1.0, (1 - gain) * 100e3));
        const double r10 = (1 - gain) * 100e3 + 2e3, a2 = KL_C7 * KL_C8 * r10 * KL_R11 * KL_R12, a1 = KL_C7 * r10 * KL_R11 + KL_C8 * KL_R12 * (r10 + KL_R11), a0 = r10 + KL_R11;
        bilinear2(kAmp, fs, a2, KL_C7 * KL_R11 * KL_R12 + a1, KL_R12 + a0, a2, a1, a0);
      }
      for (int i = 0; i < n; i++) {
        const double v = x[i];
        kPre.tick(v);
        x[i] = (float)kAmp.tick(kPre.v[2]);
        kFf2.tick(v);
        ff1[(size_t)i] = (float)(kPre.v[4] / 15e3 + kFf2.v[6] / 47e3);
        const double a = std::abs((double)x[i]); if (a > p) p = a;
      }
      os2.upsample(ff1.data(), aux2.data(), n);
      p /= 0.3;
    }
    o.upsample(x, u0, n);
    if (type == DRIVE_GLOW) {
      const double R2 = glowR(gain), cT = TS_CC / T, r = quantR(1 / (cT + 1 / R2));
      gTable.build(r);
      double V = gV;
      for (int i = 0; i < m; i++) {
        const double v = u0[i];
        const double u = r * (gHp.tick(v) / TS_R1 + cT * V);
        const double a = std::abs(u); if (a > p) p = a;
        V = gTable.at(u);
        u0[i] = (float)(v + V);
      }
      gV = V;
      p /= 0.6;
    } else if (type == DRIVE_RASP) {
      const double Rd = raspPot(gain), cf = RAT_CF / T, gf = 1 / Rd + cf;
      const double ca = RAT_CA / T, cb = RAT_CB / T, ka = ca / RAT_RA / (1 / RAT_RA + ca), kb = cb / RAT_RB / (1 / RAT_RB + cb);
      const double rf = 1.5e3 + 100e3 * (1 - toneKnob) * (1 - toneKnob);
      rLp.set(fo, std::min(0.2 * fo, 1 / (2 * PI * rf * 3.3e-9)));
      const double Dn = gf + ka + kb, alpha = gf / Dn, kg = RAT_GBW / RAT_SR, step = T * RAT_SR, ir = 1 / RAT_RAIL;
      const DiodeTable& ground = sharedGround();
      double Vo = rVo, Vn = rVn, Va = rVa, Vb = rVb;
      for (int i = 0; i < m; i++) {
        const double vp = u0[i];
        const double beta = (-cf * (Vo - Vn) + ka * Va + kb * Vb) / Dn;
        const double V0 = Vo;
        double vo = V0;
        for (int it = 0; it < 4; it++) {
          const double e = kg * (vp - alpha * vo - beta), t = tanhf_(e), A2 = std::sqrt(t * t + 1e-4);
          const double s = vo * ir, s3 = s * s * s, s6 = s3 * s3, s7 = s6 * s, as7 = s7 < 0 ? -s7 : s7, sg = s < 0 ? -1.0 : 1.0;
          const double rate = t - 0.5 * (t * as7 + A2 * s7);
          const double dt = -kg * alpha * d308(e), dA = t * dt / A2;
          const double h = vo - V0 - step * rate, dh = 1 - step * (dt - 0.5 * (dt * as7 + t * 7 * s6 * ir * sg + dA * s7 + A2 * 7 * s6 * ir));
          const double dv = h / dh;
          vo -= dv;
          if (vo > RAT_RAIL * 1.02) vo = RAT_RAIL * 1.02; else if (vo < -RAT_RAIL * 1.02) vo = -RAT_RAIL * 1.02;
          if (dv < 1e-9 && dv > -1e-9) break;
        }
        Vo = vo;
        Vn = alpha * Vo + beta;
        Va = (Vn / RAT_RA + ca * Va) / (1 / RAT_RA + ca);
        Vb = (Vn / RAT_RB + cb * Vb) / (1 / RAT_RB + cb);
        const double a = std::abs(Vo); if (a > p) p = a;
        const double w = rHp.tick(Vo);
        u0[i] = (float)rLp.tick(ground.adaa(w, rW)); rW = w;
      }
      rVo = Vo; rVn = Vn; rVa = Va; rVb = Vb;
      p /= 0.55;
    } else if (type == DRIVE_MUFF) {
      muffClip(u0, m, gain, srcR, srcL);
      p = push;
    } else if (type == DRIVE_BOOST) {
      const double cin = 1e-6 * std::pow(0.005, toneKnob);
      const double ra = 150 + (1 - gain) * (1 - gain) * 3750, re = RM_VT / RM_IE;
      const double zin = 1 / (1 / RM_BIAS + 1 / ((RM_BETA + 1) * (re + ra)));
      const double lt = srcL / T, tc = T / cin, gin = 1 / (srcR + lt + tc), div = 1 / (1 + gin * zin);
      const double a = ra * RM_IE / RM_VT, Gs = RM_RC / (re + ra);
      double bi = bI, bvc = bVc, u = bU;
      for (int i = 0; i < m; i++) {
        const double cur = gin * (u0[i] - bvc + lt * bi) * div;
        bi = cur; bvc += tc * cur;
        const double vb = cur * zin;
        const double q = std::abs(vb) * Gs; if (q > p) p = q;
        const double z = vb / RM_VT;
        for (int k = 0; k < 2; k++) { const double e = std::exp(u); u -= (u - z + a * (e - 1)) / (1 + a * e); }
        const double v = RM_RC * RM_IE * (std::exp(u) - 1) * (RM_BETA / (RM_BETA + 1));
        u0[i] = (float)(RM_SAT - knee(RM_SAT - v, 0.15));
      }
      bI = bi; bVc = bvc; bU = u;
      p /= 1.5;
    } else if (type == DRIVE_TRANSPARENT) {
      float* ax = aux.data(); const float* ffs = aux2.data();
      for (int i = 0; i < m; i++) { const double a = u0[i]; kClip.tickDiode(a >= 0 ? rails(a, KL_RAIL_P) : rails(a, KL_RAIL_N), 3, *kTable); ax[i] = (float)(kClip.v[4] / 47e3 + ffs[i]); }
      os.downsample(ax, x, n);
      if (toneKnob != kToneKnob) {
        kToneKnob = toneKnob;
        const double C = 3.9e-9, G1 = 1 / 100e3, G2 = 1 / (1.8e3 + (1 - toneKnob) * 10e3), G3 = 1 / (4.7e3 + toneKnob * 10e3), G4 = 1 / 100e3;
        kTone.set(fs, G1 * (G2 + G3), C * (G1 + G2), G4 * (G2 + G3), C * (G3 - G4));
      }
      for (int i = 0; i < n; i++) {
        const double v = kSum.tick(x[i]);
        x[i] = (float)(kTone.tick(v >= 0 ? rails(v, KL_RAIL_P) : rails(v, KL_RAIL_N)) * out);
      }
      push = p;
      return;
    } else if (type == DRIVE_OCTAVE) {
      const double G1 = 1.5 + 6 * gain, G2 = 2 + 10 * gain;
      for (int i = 0; i < m; i++) {
        const double u = G1 * oHp.tick(u0[i]);
        const double a = std::abs(u); if (a > p) p = a;
        const double s = 2 * germanium(0.5 * u);
        const double r = knee(std::sqrt(s * s + 4e-4) - 0.02 - 0.15, 0.03);
        u0[i] = (float)oLp.tick(germanium(G2 * oDc.tick(r + 0.12 * s)));
      }
    } else if (type == DRIVE_METAL) {
      const double rf1 = 4.7e3 + 100e3 * gain * gain, G1 = rf1 / 4.7e3;
      xLp1.set(fo, std::min(0.2 * fo, 1 / (2 * PI * rf1 * 330e-12)));
      const double c2 = 470e-12 / T, r2 = xTable2->r, c3 = 10e-9 / T, r3 = xTable3->r;
      double V2 = xV2, V3 = xV3;
      for (int i = 0; i < m; i++) {
        const double v = u0[i];
        const double u1 = G1 * xHp1.tick(v);
        const double a = std::abs(u1); if (a > p) p = a;
        const double s1 = xMid.tick(rails(v + xLp1.tick(u1), 3.8));
        V2 = xTable2->at(r2 * (xHp2.tick(s1) / 2.2e3 + c2 * V2));
        V3 = xTable3->at(r3 * ((s1 + V2) / 2.2e3 + c3 * V3));
        u0[i] = (float)V3;
      }
      xV2 = V2; xV3 = V3;
      p /= 2;
    } else {
      const double ra = std::max(1.0, (1 - gain) * (1 - gain) * FF_RE), rb = std::max(1.0, FF_RE - ra);
      for (int i = 0; i < m; i++) {
        const double v = u0[i];
        const double a = std::abs(v); if (a > p) p = a;
        u0[i] = (float)ff.tick(v, srcR, srcL, ra, rb);
      }
      p *= 20;
    }
    push = p;
    o.downsample(u0, x, n);
    if (type == DRIVE_GLOW) {
      if (toneKnob != gToneKnob) { gToneKnob = toneKnob; tsTone(gTone, fs, toneKnob); }
      for (int i = 0; i < n; i++) x[i] = (float)(gTone.tick(x[i]) * out);
      return;
    }
    if (type == DRIVE_RASP) {
      for (int i = 0; i < n; i++) x[i] = (float)(x[i] * out);
      return;
    }
    if (type == DRIVE_MUFF) {
      if (toneKnob != mToneKnob) {
        mToneKnob = toneKnob;
        mStack.setR(mPotA, std::max(1.0, toneKnob * 100e3)); mStack.setR(mPotB, std::max(1.0, (1 - toneKnob) * 100e3));
      }
      float* ax = aux2.data();
      for (int i = 0; i < n; i++) { mStack.tick(x[i]); x[i] = (float)(MUFF_GOUT * mStack.v[5]); }
      os2.upsample(x, ax, n);
      for (int i = 0; i < m; i++) ax[i] = (float)rails(ax[i], 4);
      os2.downsample(ax, x, n);
      for (int i = 0; i < n; i++) x[i] = (float)(x[i] * out);
      return;
    }
    if (type == DRIVE_BOOST) {
      tone.set(fs, 9000);
      for (int i = 0; i < n; i++) x[i] = (float)(bOut.tick(tone.tick(x[i])) * out);
      return;
    }
    if (type == DRIVE_METAL) {
      tone.set(fs, 1500 * std::pow(6.0, toneKnob));
      for (int i = 0; i < n; i++) x[i] = (float)(tone.tick(xScoop.tick(x[i])) * out);
      return;
    }
    if (type == DRIVE_FUZZ) {
      fLp.set(fs, std::min(0.45 * fs, 600 * std::pow(36.0, toneKnob)));
      for (int i = 0; i < n; i++) x[i] = (float)(fLp.tick(fDc.tick(x[i])) * out);
      return;
    }
    const double fTone = 700 * std::pow(12.0, toneKnob);
    tone.set(fs, fTone);
    tone2.set(fs, std::min(fTone * 2.5, fs * 0.45));
    for (int i = 0; i < n; i++) x[i] = (float)(tone2.tick(tone.tick(x[i])) * out);
  }

private:
  void muffClip(float* u0, int m, double gain, double srcR, double srcL) {
    const double T = 1 / fsOs, cf = MUFF_CF / T, A = 1 / MUFF_RF + cf, rB = mTable->r;
    const DiodeTable& tab = *mTable;
    const double lt = srcL / T, tc = T / MUFF_CC, g1 = 1 / (srcR + MUFF_RG1 + lt + tc);
    auto kf = [&](FirstOrder& q, double ideal) {
      const double lo = 1 / (1 + (1 + ideal) / MUFF_A_LF), hi = 1 / (1 + (1 + ideal) / MUFF_A_HF);
      q.set(fsOs, lo, hi / MUFF_WC, 1, 1 / MUFF_WC);
    };
    const double ideal1 = MUFF_RF / (srcR + MUFF_RG1);
    const double a = 0.005 + 0.995 * audioTaper(gain), rIn2 = MUFF_RG + 1e3 + 100e3 * a * (1 - a), rIn3 = MUFF_RG + MUFF_ROUT;
    kf(mK1, ideal1); kf(mK2, MUFF_RF / rIn2); kf(mK3, MUFF_RF / rIn3);
    const double t2 = T / MUFF_CC, i2 = 1 / (rIn2 + t2), i3 = 1 / (rIn3 + t2), kT = T / MUFF_CD;
    double I = mI, Cc = mC, V1 = mV1, C2 = mC2, V2 = mV2, D2 = mD2, C3 = mC3, V3 = mV3, D3 = mD3;
    double pk = 0;
    for (int i = 0; i < m; i++) {
      const double vin = u0[i] - Cc + lt * I, cur = g1 * vin;
      I = cur; Cc += tc * cur;
      V1 = (-mK1.tick(cur) + cf * V1) / A;
      const double o1 = V1 >= 0 ? rails(V1, MUFF_UP) : rails(V1, MUFF_DOWN);
      const double c2 = i2 * (a * o1 - C2); C2 += t2 * c2;
      const double u2 = (-mK2.tick(c2) + cf * V2) / A - D2;
      const double q = std::abs(u2); if (q > pk) pk = q;
      const double w2 = tab.at(u2);
      D2 += kT * (u2 - w2) / rB;
      V2 = w2 + D2;
      const double c3 = i3 * (V2 - C3); C3 += t2 * c3;
      const double u3 = (-mK3.tick(c3) + cf * V3) / A - D3;
      const double w3 = tab.at(u3);
      D3 += kT * (u3 - w3) / rB;
      V3 = w3 + D3;
      u0[i] = (float)V3;
    }
    mI = I; mC = Cc; mV1 = V1; mC2 = C2; mV2 = V2; mD2 = D2; mC3 = C3; mV3 = V3; mD3 = D3;
    push = pk / 0.6;
  }

  int factor, factorHard;
  Oversampler os, os2, osHard;
  std::vector<float> up, aux, aux2, ff1;
  double fs, fsOs, fsHard;
  OnePoleHP gHp; double gV = 0; Biquad gTone; AsymTable gTable; OnePoleHP inHp2; double gToneKnob = -1;
  double rVo = 0, rVn = 0, rVa = 0, rVb = 0, rW = 0; OnePoleHP rHp; OnePoleLP rLp;
  FuzzFace ff; OnePoleHP fDc; OnePoleLP fLp;
  double mI = 0, mC = 0, mV1 = 0, mC2 = 0, mV2 = 0, mD2 = 0, mC3 = 0, mV3 = 0, mD3 = 0;
  const DiodeTable* mTable = nullptr; LinearNet mStack; int mPotA = 0, mPotB = 0; double mToneKnob = -1;
  double bI = 0, bVc = 0, bU = 0;
  LinearNet kPre; int kRg = 0; LinearNet kFf2; int kTop = 0, kBot = 0;
  Biquad kAmp; LinearNet kClip; const DiodeTable* kTable = nullptr; FirstOrder kSum, kTone; double kGain = -1, kToneKnob = -1;
  OnePoleHP oHp, oDc; OnePoleLP oLp;
  OnePoleHP xHp1; OnePoleLP xLp1; Biquad xMid; OnePoleHP xHp2; double xV2 = 0, xV3 = 0;
  const DiodeTable* xTable2 = nullptr; const DiodeTable* xTable3 = nullptr; Biquad xScoop;
  OnePoleLP tone, tone2;
  OnePoleHP inHp;
  Biquad diBq; OnePoleHP bOut { 48000, 16 };
  FirstOrder mK1, mK2, mK3;
  int lastType = -1;
};

// ---- tonestack.ts ----------------------------------------------------------

struct StackParts { int topo; double R1, R2, R3, R4, C1, C2, C3; };
inline constexpr StackParts STACK_BASSMAN { 0, 250e3, 1e6, 25e3, 56e3, 250e-12, 20e-9, 20e-9 };
inline constexpr StackParts STACK_JCM800 { 0, 220e3, 1e6, 22e3, 33e3, 470e-12, 22e-9, 22e-9 };
inline constexpr StackParts STACK_PLEXI { 0, 250e3, 1e6, 25e3, 33e3, 500e-12, 22e-9, 22e-9 };
inline constexpr StackParts STACK_SOLDANO { 0, 250e3, 1e6, 25e3, 47e3, 470e-12, 20e-9, 20e-9 };
inline constexpr StackParts STACK_BLACKFACE { 0, 250e3, 250e3, 10e3, 100e3, 250e-12, 100e-9, 47e-9 };
inline constexpr StackParts STACK_MESA { 0, 250e3, 250e3, 25e3, 100e3, 250e-12, 100e-9, 47e-9 };
inline constexpr StackParts STACK_TOPBOOST { 1, 1e6, 1e6, 20e3, 100e3, 50e-12, 22e-9, 22e-9 };
inline constexpr StackParts STACK_HIWATT { 2, 100e3, 1e6, 25e3, 250e3, 4.7e-9, 560e-12, 5.6e-9 };
inline constexpr StackParts STACK_ORANGE { 0, 250e3, 1e6, 50e3, 22e3, 500e-12, 10e-9, 10e-9 };

/** Gaussian elimination with partial pivoting, B (n x m) overwritten with the solution (tonestack.ts solve). */
inline void solveLinear(double* M, double* B, int n, int m) {
  for (int c = 0; c < n; c++) {
    int p = c; double best = std::abs(M[c * n + c]);
    for (int r = c + 1; r < n; r++) { const double a = std::abs(M[r * n + c]); if (a > best) { best = a; p = r; } }
    if (p != c) {
      for (int k = 0; k < n; k++) std::swap(M[c * n + k], M[p * n + k]);
      for (int k = 0; k < m; k++) std::swap(B[c * m + k], B[p * m + k]);
    }
    const double d = M[c * n + c];
    for (int r = c + 1; r < n; r++) {
      const double f = M[r * n + c] / d;
      if (f == 0) continue;
      for (int k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      for (int k = 0; k < m; k++) B[r * m + k] -= f * B[c * m + k];
    }
  }
  for (int c = n - 1; c >= 0; c--) {
    const double d = M[c * n + c];
    for (int k = 0; k < m; k++) {
      double s = B[c * m + k];
      for (int j = c + 1; j < n; j++) s -= M[c * n + j] * B[j * m + k];
      B[c * m + k] = s / d;
    }
  }
}

/** The tone stack solved as its circuit, as a 4-state model (tonestack.ts). */
class ToneStack {
public:
  static constexpr int NS = 4, MAXN = 14, MAXE = 16;
  static constexpr double R_LOAD = 1e6, R_MIN = 1;
  void reset() { std::fill(x, x + NS, 0.0); u1 = 0; }

  void set(double fs, const StackParts* p, double treble, double mid, double bass, double rs) {
    if (fs == kFs && p == kParts && treble == kT && mid == kM && bass == kL && rs == kRs) return;
    kFs = fs; kParts = p; kT = treble; kM = mid; kL = bass; kRs = rs;
    const double t = p->topo == 1 ? (std::pow(32.0, std::min(1.0, std::max(0.0, treble))) - 1) / 31 : std::min(1.0, std::max(0.0, treble));
    const double m = std::min(1.0, std::max(0.0, mid));
    const double l = std::exp((std::min(1.0, std::max(0.0, bass)) - 1) * 3.4);
    nr = 0; nc = 0;
    int nodes, out;
    r(1, 2, rs);
    if (p->topo == 0 || p->topo == 1) {
      const double mm = p->topo == 1 ? 0.5 : m;
      c(2, 3, p->C1);
      r(3, 4, (1 - t) * p->R1); r(4, 5, t * p->R1);
      r(2, 6, p->R4);
      c(6, 5, p->C2);
      c(6, 8, p->C3);
      r(5, 7, l * p->R2);
      r(7, 8, (1 - mm) * p->R3); r(8, 0, mm * p->R3);
      nodes = 8; out = 4;
    } else {
      r(2, 3, p->R1);
      r(3, 4, (1 - l) * p->R2); r(4, 5, l * p->R2);
      c(3, 4, p->C1);
      c(4, 5, p->C1 * 10);
      r(5, 0, m * p->R3 + 1e3);
      r(4, 8, 100e3);
      c(2, 6, p->C2);
      r(6, 8, (1 - t) * p->R4); r(8, 7, t * p->R4);
      c(7, 0, p->C3);
      nodes = 8; out = 8;
    }
    r(out, 0, R_LOAD);
    const int nsrc = nc + 1, n = nodes + nsrc, w = nsrc;
    std::fill(M, M + n * n, 0.0); std::fill(R, R + n * w, 0.0);
    for (int i = 0; i < nr; i++) {
      const int a = ra[i] - 1, b = rb[i] - 1; const double g = 1 / rv[i];
      if (a >= 0) M[a * n + a] += g;
      if (b >= 0) M[b * n + b] += g;
      if (a >= 0 && b >= 0) { M[a * n + b] -= g; M[b * n + a] -= g; }
    }
    for (int k = 0; k <= nc; k++) {
      const int a = k < nc ? ca[k] - 1 : 0, b = k < nc ? cb[k] - 1 : -1, row = nodes + k;
      if (a >= 0) { M[a * n + row] += 1; M[row * n + a] += 1; }
      if (b >= 0) { M[b * n + row] -= 1; M[row * n + b] -= 1; }
      R[row * w + k] = 1;
    }
    solveLinear(M, R, n, w);
    double A[NS * NS] = {}, B[NS] = {}, C[NS] = {};
    for (int k = 0; k < nc; k++) {
      const double cv = cvv[k];
      for (int j = 0; j < nc; j++) A[k * NS + j] = R[(nodes + k) * w + j] / cv;
      B[k] = R[(nodes + k) * w + nc] / cv;
      C[k] = R[(out - 1) * w + k];
    }
    const double D = R[(out - 1) * w + nc];
    std::copy(A, A + NS * NS, cA); std::copy(B, B + NS, cB); std::copy(C, C + NS, cC); cD = D;
    const double h = 0.5 / fs; constexpr int q = NS + 1;
    double P[NS * NS], Q[NS * q];
    for (int i = 0; i < NS; i++) {
      for (int j = 0; j < NS; j++) {
        const double a = A[i * NS + j] * h, e = i == j ? 1 : 0;
        P[i * NS + j] = e - a;
        Q[i * q + j] = e + a;
      }
      Q[i * q + NS] = B[i] * h;
    }
    solveLinear(P, Q, NS, q);
    for (int i = 0; i < NS; i++) {
      for (int j = 0; j < NS; j++) ad[i * NS + j] = Q[i * q + j];
      bd[i] = Q[i * q + NS];
      cd[i] = C[i];
    }
    dd = D;
  }

  double tick(double u) {
    const double w = u + u1;
    const double p0 = x[0], p1 = x[1], p2 = x[2], p3 = x[3];
    const double x0 = ad[0] * p0 + ad[1] * p1 + ad[2] * p2 + ad[3] * p3 + bd[0] * w;
    const double x1 = ad[4] * p0 + ad[5] * p1 + ad[6] * p2 + ad[7] * p3 + bd[1] * w;
    const double x2 = ad[8] * p0 + ad[9] * p1 + ad[10] * p2 + ad[11] * p3 + bd[2] * w;
    const double x3 = ad[12] * p0 + ad[13] * p1 + ad[14] * p2 + ad[15] * p3 + bd[3] * w;
    x[0] = x0; x[1] = x1; x[2] = x2; x[3] = x3; u1 = u;
    return cd[0] * x0 + cd[1] * x1 + cd[2] * x2 + cd[3] * x3 + dd * u;
  }

  /** |H| at f Hz of the continuous model (tonestack.ts mag). */
  double mag(double f) const {
    constexpr int n = 2 * NS;
    const double w = 2 * PI * f;
    double Mm[n * n] = {}, b[n] = {};
    for (int i = 0; i < NS; i++) {
      for (int j = 0; j < NS; j++) {
        const double re = -cA[i * NS + j], im = i == j ? w : 0;
        Mm[i * n + j] = re; Mm[i * n + NS + j] = -im;
        Mm[(NS + i) * n + j] = im; Mm[(NS + i) * n + NS + j] = re;
      }
      b[i] = cB[i];
    }
    for (int i = 0; i < n; i++) { bool z = true; for (int j = 0; j < n; j++) if (Mm[i * n + j] != 0) { z = false; break; } if (z) Mm[i * n + i] = 1; }
    solveLinear(Mm, b, n, 1);
    double hr = cD, hi = 0;
    for (int k = 0; k < NS; k++) { hr += cC[k] * b[k]; hi += cC[k] * b[NS + k]; }
    return std::sqrt(hr * hr + hi * hi);
  }
  double magContinuous1k() const { return mag(1000); }

private:
  void r(int a, int b, double v) { ra[nr] = a; rb[nr] = b; rv[nr] = std::max(R_MIN, v); nr++; }
  void c(int a, int b, double v) { ca[nc] = a; cb[nc] = b; cvv[nc] = v; nc++; }
  double ad[NS * NS] = {}, bd[NS] = {}, cd[NS] = {}, dd = 1;
  double cA[NS * NS] = {}, cB[NS] = {}, cC[NS] = {}, cD = 1;
  double x[NS] = {}, u1 = 0;
  double M[MAXN * MAXN] = {}, R[MAXN * (NS + 1)] = {};
  int ra[MAXE] = {}, rb[MAXE] = {}; double rv[MAXE] = {}; int nr = 0;
  int ca[NS] = {}, cb[NS] = {}; double cvv[NS] = {}; int nc = 0;
  double kFs = -1; const StackParts* kParts = nullptr; double kT = -1, kM = -1, kL = -1, kRs = -1;
};

// ---- cab.ts: the speakers' electrical side ------------------------------------

struct Speaker { double re, le, fs, q, res; };
inline constexpr Speaker SPEAKERS[9] = {
  { 6.6, 0.5e-3, 90, 4, 35 }, { 6.7, 0.55e-3, 95, 4.5, 40 }, { 6.5, 0.6e-3, 100, 4.5, 40 },
  { 6.8, 0.45e-3, 80, 5, 48 }, { 6.7, 0.55e-3, 98, 4.5, 40 }, { 6.5, 0.4e-3, 95, 3, 30 },
  { 6.8, 0.6e-3, 105, 5.4, 45 }, { 6.5, 0.35e-3, 105, 3.5, 30 }, { 6.4, 0.25e-3, 150, 3, 25 },
};

// ---- amp.ts ----------------------------------------------------------------

constexpr int AMP_CLEAN = 0, AMP_CRUNCH = 1, AMP_LEAD = 2, AMP_CHIME = 3;
constexpr int AMP_TWEED = 4, AMP_HIWATT = 5, AMP_BOUTIQUE = 6;
constexpr int AMP_BRIT = 7, AMP_RECTIFIED = 8, AMP_MODERN = 9;
constexpr int AMP_BLACKFACE = 10, AMP_CHAMP = 11, AMP_ORANGE = 12, AMP_BROWN = 13;
constexpr int MAX_STAGES = 4, NVOICINGS = 14;

constexpr double XFMR_A = 2 * PI * 55, XFMR_SAT = 1 / 0.0035;
constexpr double RS_PLATE = 38e3, RS_CF = 600;
constexpr double C_GK = 1.6e-12, C_GA = 1.6e-12, C_WIRE = 10e-12;
constexpr int K_HOT = 0, K_UNBY = 1, K_BRIT = 2, K_COLD = 3, K_SLOCOLD = 4, K_SLO1 = 5, K_SLO2 = 6, K_SLO4 = 7, K_MARSHALL = 8, K_AC30 = 9, K_12AY7 = 10;
constexpr int PRES_NONE = 0, PRES_NFB = 1, PRES_CUT = 2;
constexpr double CUT_R = 250e3, CUT_C = 4.7e-9, CUT_RS = 70e3, OUT_REF = 0.004;
inline double masterPot(double m) { return 0.01 * std::pow(100.0, m); }

struct AmpStage { int kind; double ck, cc, r1, c1, r2; bool pot; double cb, stop, cp; };
struct Voicing {
  int nst;
  AmpStage stages[MAX_STAGES];
  double potLo;
  int stackAt;
  bool cf;
  StackParts stack;
  double trim, follow, bias, gpi;
  bool mv;
  int pres;
  PowerParts power;
};

// the voicing table, written from amp.ts by `npm run gen`
#include "Voicings.gen.h"

/** Built once and shared by every amp (amp.ts `tables()`). */
struct AmpTables {
  std::vector<StageTable> stages;
  FollowerTable follower;
  std::vector<PowerTable> powers;
  double powerScale[NVOICINGS];
  AmpTables() {
    for (int k = 0; k < NKINDS; k++) stages.emplace_back(STAGE_KINDS[k]);
    for (int v = 0; v < NVOICINGS; v++) powers.emplace_back(VOICINGS[v].power);
    // amp.ts ampPowerScale
    for (int v = 0; v < NVOICINGS; v++) powerScale[v] = VOICINGS[v].gpi / (VOICINGS[v].bias * powers[v].scale);
  }
};
inline const AmpTables& ampTables() { static const AmpTables t; return t; }

class Amp {
public:
  float stageHeat[MAX_STAGES + 1] = {};
  double sagDepth = 0;

  explicit Amp(double sampleRate)
    : tabs(ampTables()), factor(osFactor(sampleRate, AMP_RATE, OS)), os(sampleRate, factor), fs(sampleRate), fsOs(sampleRate * factor),
      miller { { fsOs, 12000 }, { fsOs, 12000 }, { fsOs, 12000 }, { fsOs, 12000 }, { fsOs, 12000 } },
      plate { { fsOs, 20000 }, { fsOs, 20000 }, { fsOs, 20000 }, { fsOs, 20000 }, { fsOs, 20000 } },
      xfmrLp(fsOs, 9000) {
    up.assign((size_t)MAX_BLOCK * factor, 0.f);
  }

  void reset() {
    os.reset(); stack.reset();
    for (int s = 0; s <= MAX_STAGES; s++) { miller[s].z = 0; plate[s].z = 0; bleed[s].reset(); potF[s].reset(); }
    std::fill(cap, cap + MAX_STAGES, 0.0); std::fill(kd, kd + MAX_STAGES, 0.0);
    std::fill(ax, ax + MAX_STAGES, 0.0); std::fill(aFv, aFv + MAX_STAGES, 0.0); std::fill(aFg, aFg + MAX_STAGES, 0.0); cfX = cfF = paX = paF = 0;
    xfmrLp.z = 0; flux = 0; load.reset(); presLoop.reset(); sagEnv = 0; lastP = lastOut = -1;
  }

  void process(float* x, int n, int type, double gain, double bass, double mid, double treble,
               double pres, double master, double sag, double heat, int cab) {
    voice(type, gain, cab);
    const Voicing& v = VOICINGS[type];
    if (pres != lastPres) {
      const double T = v.power.nfb;
      if (v.pres == PRES_NFB && T > 0) presLoop.highShelf(fsOs, 3200, 20 * std::log10((1 + T) / (1 + T * (1 - pres))));
      else if (v.pres == PRES_CUT) {
        const double R = std::max(1.0, CUT_R * (1 - (std::pow(32.0, 1 - pres) - 1) / 31));
        presLoop.firstOrder(fsOs, 1, R * CUT_C, 1, (R + CUT_RS) * CUT_C);
      } else presLoop.bypass();
      lastPres = pres;
    }
    stack.set(fsOs, &v.stack, treble, mid, bass, v.cf ? RS_CF : RS_PLATE);

    float* u0 = up.data();
    const int m = n * factor;
    os.upsample(x, u0, n);
    const int nst = v.nst, stackAt = v.stackAt;
    const bool cfOn = v.cf;
    const double* cfY = tabs.follower.y.data(); const double* cfFt = tabs.follower.F.data();
    const double* power = tabs.powers[type].y.data(); const double* powF = tabs.powers[type].F.data();
    double cfx = cfX, cfi = cfF, pax = paX, pai = paF;
    const double P1 = masterPot(master) * tabs.powerScale[type], P0 = lastP < 0 ? P1 : lastP, dP = (P1 - P0) / m;
    lastP = P1;
    const double sagAtk = 1 - std::exp(-1 / (0.012 * fsOs));
    const double sagRel = 1 - std::exp(-1 / (0.15 * fsOs));
    std::fill(stageHeat, stageHeat + MAX_STAGES + 1, 0.f);
    const double xt = 1 / fsOs;
    double env = sagEnv, sagMin = 1, fl = flux;
    for (int i = 0; i < m; i++) {
      double s = u0[i] * heat;
      for (int k = 0; k < nst; k++) {
        const AmpStage& sk = v.stages[k];
        const StageTable& t = tabs.stages[sk.kind];
        const double vN = ccK[k] > 0 ? s - cap[k] : s;
        const double vn = miller[k].tick(potF[k].tick(bleed[k].tick(vN)));
        const double vx = ckK[k] > 0 ? vn - kd[k] * (1 + 1 / t.mu) : vn;
        const double a = std::abs(vx) / t.knee; if (a > stageHeat[k]) stageHeat[k] = (float)a;
        const double gs = 1 / t.rs;
        const double Fv = tableInt(t.vp.data(), t.Fvp.data(), TUBE_N, TUBE_LO, TUBE_INV, vx, 0), Fg = tableInt(t.ig.data(), t.Fig.data(), TUBE_N, TUBE_LO, TUBE_INV, vx, gs);
        const double dx = vx - ax[k];
        double vp, ig;
        if (dx > ADAA_EPS || dx < -ADAA_EPS) { vp = (Fv - aFv[k]) / dx; ig = (Fg - aFg[k]) / dx; }
        else { const double mid = 0.5 * (vx + ax[k]); vp = tableAt(t.vp.data(), TUBE_N, TUBE_LO, TUBE_INV, mid, 0); ig = tableAt(t.ig.data(), TUBE_N, TUBE_LO, TUBE_INV, mid, gs); }
        ax[k] = vx; aFv[k] = Fv; aFg[k] = Fg;
        if (ckK[k] > 0) kd[k] += ckK[k] * (ig - vp * rpG[k] - kd[k] * rkG[k]);
        if (ccK[k] > 0) cap[k] += ccK[k] * (vN * ccG[k] + ccF[k] * ig);
        s = plate[k].tick(vp);
        if (k + 1 == stackAt) {
          if (cfOn) {
            const double Fc = tableInt(cfY, cfFt, CF_N, CF_LO, CF_INV, s, 0), d = s - cfx;
            const double o = d > ADAA_EPS || d < -ADAA_EPS ? (Fc - cfi) / d : tableAt(cfY, CF_N, CF_LO, CF_INV, 0.5 * (s + cfx), 0);
            cfx = s; cfi = Fc; s = o;
          }
          s = stack.tick(s);
        }
      }
      double u = presLoop.tick(load.tick(miller[MAX_STAGES].tick(s) * (P0 + dP * i)));
      const double supply = 1 - 0.45 * sag * env;
      if (supply < sagMin) sagMin = supply;
      const double ua = u / supply;
      const double a = std::abs(ua); if (a > stageHeat[MAX_STAGES]) stageHeat[MAX_STAGES] = (float)a;
      const double Fp = tableInt(power, powF, PA_N, -PA_R, PA_INV, ua, 0), dp = ua - pax;
      u = supply * (dp > ADAA_EPS || dp < -ADAA_EPS ? (Fp - pai) / dp : tableAt(power, PA_N, -PA_R, PA_INV, 0.5 * (ua + pax), 0));
      pax = ua; pai = Fp;
      const double au = std::abs(u);
      env += (au - env) * (au > env ? sagAtk : sagRel);
      const double fs2 = fl * XFMR_SAT;
      const double y = xfmrLp.tick(u) - XFMR_A * fl * (1 + fs2 * fs2);
      fl += y * xt;
      u0[i] = (float)y;
    }
    sagEnv = env; flux = fl;
    cfX = cfx; cfF = cfi; paX = pax; paF = pai;
    sagDepth = 1 - sagMin;
    os.downsample(u0, x, n);
    const double o1 = dbToGain(v.trim) * OUT_REF / P1 * std::pow(1 / v.potLo, -v.follow * (gain - 0.5)), o0 = lastOut < 0 ? o1 : lastOut;
    lastOut = o1;
    for (int i = 0; i < n; i++) x[i] = (float)(x[i] * (o0 + (o1 - o0) * ((double)i / n)));
  }

private:
  void voice(int type, double gain, int cab) {
    const Voicing& v = VOICINGS[type];
    const double dt = 1 / fsOs;
    if (type != lastType) {
      reset();
      for (int k = 0; k < v.nst; k++) {
        const AmpStage& s = v.stages[k];
        const StageKind& kind = STAGE_KINDS[s.kind];
        ccK[k] = s.cc > 0 ? dt / s.cc : 0;
        ccG[k] = 1 / (s.r1 + s.r2 > 0 ? s.r1 + s.r2 : 1e6);
        ckK[k] = s.ck > 0 ? dt / s.ck : 0;
        rkG[k] = 1 / kind.rk; rpG[k] = 1 / kind.rp;
        if (s.r1 > 0 && s.r2 > 0) {
          if (s.c1 > 0) bleed[k].set(fsOs, s.r2, s.r1 * s.r2 * s.c1, s.r1 + s.r2, s.r1 * s.r2 * s.c1);
          else bleed[k].gain(s.r2 / (s.r1 + s.r2));
        } else bleed[k].gain(1);
        plate[k].set(fsOs, s.cp > 0 ? s.cp : 0.45 * fsOs);
      }
      miller[MAX_STAGES].set(fsOs, 15000);
      lastPres = -1; lastGain = -1; lastCab = -2;
    }
    if (gain != lastGain) {
      const double a = v.potLo * std::pow(1 / v.potLo, gain);
      for (int k = 0; k < v.nst; k++) {
        const AmpStage& s = v.stages[k];
        double rth = 0;
        if (s.pot) {
          const double rt = (1 - a) * s.r2, rb = a * s.r2;
          if (s.cb > 0) potF[k].set(fsOs, a, a * rt * s.cb, 1, (rt * rb / s.r2) * s.cb);
          else potF[k].gain(a);
          ccF[k] = rb / (s.r1 + s.r2);
          rth = (rb * (rt + s.r1 + RS_PLATE)) / (rb + rt + s.r1 + RS_PLATE);
        } else {
          potF[k].gain(1);
          ccF[k] = s.r2 > 0 ? s.r2 / (s.r1 + s.r2) : 1;
          rth = s.r2 > 0 ? (s.r1 > 0 ? (s.r2 * (s.r1 + RS_PLATE)) / (s.r1 + s.r2 + RS_PLATE) : RS_PLATE) : 0;
        }
        const double A = std::abs(tabs.stages[s.kind].gain);
        const double cin = C_GK + C_GA * (A + 1) + C_WIRE;
        miller[k].set(fsOs, std::min(0.45 * fsOs, 1 / (2 * PI * (s.stop + rth) * cin)));
      }
      lastGain = gain;
    }
    if (cab != lastCab) {
      const double T = v.power.nfb, zp = v.power.zp;
      if (cab < 0) load.bypass();
      else {
        const Speaker& sp = SPEAKERS[cab];
        const double lces = sp.res / (2 * PI * sp.fs * sp.q), cmes = sp.q / (2 * PI * sp.fs * sp.res);
        const double re = sp.re, le = sp.le, res = sp.res;
        const double n0 = re * res, n1 = re * lces + le * res + lces * res, n2 = re * lces * cmes * res + le * lces, n3 = le * lces * cmes * res;
        const double d0 = res, d1 = lces, d2 = lces * cmes * res;
        const double a0 = (1 + T) * n0 + zp * d0, a1 = (1 + T) * n1 + zp * d1, a2 = (1 + T) * n2 + zp * d2, a3 = (1 + T) * n3;
        const double w = 2 * PI * 1000, w2 = w * w, w3 = w2 * w;
        const double hr = n0 - n2 * w2, hi = n1 * w - n3 * w3, gr = a0 - a2 * w2, gi = a1 * w - a3 * w3;
        const double kk = std::sqrt((gr * gr + gi * gi) / (hr * hr + hi * hi));
        load.set(fsOs, n0 * kk, n1 * kk, n2 * kk, n3 * kk, a0, a1, a2, a3);
      }
      lastCab = cab;
    }
    lastType = type;
  }

  const AmpTables& tabs;
  int factor;
  Oversampler os;
  std::vector<float> up;
  double fs, fsOs;
  FirstOrder bleed[MAX_STAGES + 1], potF[MAX_STAGES + 1];
  OnePoleLP miller[MAX_STAGES + 1];
  OnePoleLP plate[MAX_STAGES + 1];
  double cap[MAX_STAGES] = {}, kd[MAX_STAGES] = {};
  double ax[MAX_STAGES] = {}, aFv[MAX_STAGES] = {}, aFg[MAX_STAGES] = {}, cfX = 0, cfF = 0, paX = 0, paF = 0;
  double ccK[MAX_STAGES] = {}, ccG[MAX_STAGES] = {}, ccF[MAX_STAGES] = {}, ckK[MAX_STAGES] = {}, rkG[MAX_STAGES] = {}, rpG[MAX_STAGES] = {};
  ToneStack stack;
  OnePoleLP xfmrLp;
  double flux = 0;
  Cubic load;
  Biquad presLoop;
  double lastP = -1, lastOut = -1;
  double sagEnv = 0;
  int lastType = -1, lastCab = -2;
  double lastPres = -1, lastGain = -1;
};

// ---- cab.ts ----------------------------------------------------------------

struct CabBreak { double f, db, q; };
struct CabVoice { bool closed; double bump, dipF, dipDb, presF, presDb, top; int nbr; CabBreak br[6]; double reflMs, reflDb, prox; };
constexpr int NCABS = 9, CAB_NMIC = 5, CAB_NFFT = 4096;
constexpr double CAB_FIR_S = 0.006;
inline constexpr CabVoice CAB_VOICES[NCABS] = {
  { false, 2, 650, -2.5, 2600, 4, 5600, 4, { { 1500, 2.5, 6 }, { 2500, 3, 8 }, { 3300, -4, 10 }, { 4200, 3, 8 } }, 1.2, -14, 2 },
  { true, 3.5, 500, -3, 2800, 5, 5000, 4, { { 1900, 2.5, 6 }, { 2600, -3, 9 }, { 3400, 4, 8 }, { 4400, -5, 10 } }, 1.8, -16, 3 },
  { true, 5, 420, -4.5, 3000, 6, 4600, 5, { { 1700, 2, 6 }, { 2400, -3, 8 }, { 3000, 4, 8 }, { 3900, -5, 10 }, { 5000, 2, 8 } }, 2.2, -15, 3 },
  { false, 2.5, 600, -2, 3600, 6, 6200, 4, { { 1600, 1.5, 6 }, { 2900, -3, 8 }, { 3800, 4, 8 }, { 4800, -4, 10 } }, 1.4, -14, 2 },
  { true, 4.5, 450, -3.5, 2000, 4, 4600, 5, { { 900, -1.5, 4 }, { 1800, 3, 5 }, { 2500, 2, 10 }, { 3200, -4, 9 }, { 4100, -3, 10 } }, 2.2, -15, 3 },
  { false, 2.5, 1400, -2, 2600, 3, 4800, 2, { { 700, 2.5, 2 }, { 3600, -3, 9 } }, 1.1, -13, 2 },
  { true, 5, 380, -5, 3200, 7, 5200, 6, { { 1600, 2.5, 4 }, { 2200, -2.5, 9 }, { 2800, 3, 7 }, { 3500, 4, 8 }, { 4300, -6, 10 }, { 5400, 2, 9 } }, 2.2, -15, 3 },
  { false, 2.5, 500, -2.5, 3200, 4, 6600, 5, { { 1200, 1.5, 4 }, { 2400, -2, 8 }, { 3600, 3, 7 }, { 4800, -3, 9 }, { 6000, 2, 8 } }, 1.3, -14, 2 },
  { false, 3, 1800, -1, 3000, 3, 4300, 1, { { 900, 2, 2 } }, 0.9, -13, 1 },
};

/** In-place radix-2 complex FFT (cab.ts fft). */
inline void cabFft(double* re, double* im, int n, int sign) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); }
  }
  for (int len = 2; len <= n; len <<= 1) {
    const double ang = sign * 2 * PI / len, wr = std::cos(ang), wi = std::sin(ang);
    for (int i = 0; i < n; i += len) {
      double cr = 1, ci = 0;
      for (int k = 0; k < len / 2; k++) {
        const int a = i + k, b = a + len / 2;
        const double xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const double t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

inline double cabVoiceDb(const CabVoice& v, double mic, double f) {
  auto lg = [&](double x) { return std::log2(std::max(1.0, f) / x); };
  auto sq = [](double x) { return x * x; };
  double d = 0;
  d += 0.6 * v.dipDb * std::exp(-0.5 * sq(lg(v.dipF) / 0.6));
  d += 0.5 * v.presDb * (1.3 - mic) * std::exp(-0.5 * sq(lg(v.presF) / 0.7));
  for (int i = 0; i < v.nbr; i++) {
    const CabBreak& b = v.br[i];
    const double g = b.f > 3000 ? b.db * (1.2 - 0.6 * mic) : b.db;
    d += g * std::exp(-0.5 * sq(lg(b.f) * b.q / 1.2));
  }
  const double top = v.top * (0.95 - 0.4 * mic);
  d += -10 * std::log10(1 + std::pow(f / top, 8));
  d += -6 * mic / (1 + sq(2500 / std::max(1.0, f)));
  const double g = std::pow(10.0, v.reflDb / 20) / std::sqrt(1 + sq(f / 2500)), ph = 2 * PI * f * v.reflMs * 1e-3;
  d += 10 * std::log10(sq(1 + g * std::cos(ph)) + sq(g * std::sin(ph)));
  return d;
}

/** The impulse responses of every cabinet at every mic position, built once per sample rate (cab.ts buildIrs). */
struct CabIrs {
  double fs = 0; int len = 0;
  std::vector<double> h;   // [cab][mic][tap]
  explicit CabIrs(double sampleRate) : fs(sampleRate) {
    len = (int)jsRound(fs * CAB_FIR_S);
    h.assign((size_t)NCABS * CAB_NMIC * len, 0.0);
    std::vector<double> re(CAB_NFFT), im(CAB_NFFT);
    const int N = CAB_NFFT;
    for (int c = 0; c < NCABS; c++)
      for (int mi = 0; mi < CAB_NMIC; mi++) {
        const double mic = (double)mi / (CAB_NMIC - 1);
        const CabVoice& v = CAB_VOICES[c];
        const double ref = cabVoiceDb(v, mic, 1000);
        for (int k = 0; k <= N / 2; k++) {
          const double f = k * fs / N;
          const double db = std::max(-80.0, f > 20000 ? -80.0 : cabVoiceDb(v, mic, f) - ref);
          re[k] = db / 20 * std::log(10.0); im[k] = 0;
          if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = 0; }
        }
        cabFft(re.data(), im.data(), N, 1);
        for (int k = 0; k < N; k++) { re[k] /= N; im[k] = 0; }
        for (int k = 1; k < N / 2; k++) { re[k] *= 2; re[N - k] = 0; }
        cabFft(re.data(), im.data(), N, -1);
        for (int k = 0; k < N; k++) { const double m = std::exp(re[k]), p = im[k]; re[k] = m * std::cos(p); im[k] = m * std::sin(p); }
        cabFft(re.data(), im.data(), N, 1);
        const int fade = len / 4;
        double* out = &h[((size_t)c * CAB_NMIC + mi) * len];
        for (int k = 0; k < len; k++) {
          const double w = k < len - fade ? 1 : 0.5 + 0.5 * std::cos(PI * (k - (len - fade)) / fade);
          out[k] = re[k] / N * w;
        }
      }
  }
};
inline const CabIrs& cabIrs(double fs) {
  // one set per sample rate (a host runs one rate at a time; a change builds a new set on the message thread's prepare)
  static std::vector<std::unique_ptr<CabIrs>> sets;
  static std::mutex lock;
  std::lock_guard<std::mutex> g(lock);
  for (auto& s : sets) if (s->fs == fs) return *s;
  sets.push_back(std::make_unique<CabIrs>(fs));
  return *sets.back();
}

class Cab {
public:
  explicit Cab(double sampleRate) : irs(cabIrs(sampleRate)), len(irs.len), fs(sampleRate) {
    h.assign((size_t)len, 0.0); hist.assign((size_t)len * 2, 0.0);
  }
  void reset() { hp.reset(); bump.reset(); back.reset(); std::fill(hist.begin(), hist.end(), 0.0); }
  void set(int type, double mic) {
    if (type == curType && mic == curMic) return;
    curType = type; curMic = mic;
    const int t = std::max(0, std::min(NCABS - 1, type));
    const CabVoice& v = CAB_VOICES[t];
    const Speaker& sp = SPEAKERS[t];
    hp.highpass(fs, sp.fs, v.closed ? 0.9 : 0.7);
    bump.peak(fs, sp.fs * 1.15, 1.2, v.bump + v.prox * (1 - mic));
    if (v.closed) back.bypass(); else back.lowShelf(fs, 180, -4);
    const double m = std::min(1.0, std::max(0.0, mic)) * (CAB_NMIC - 1);
    const int i0 = std::min(CAB_NMIC - 2, (int)std::floor(m));
    const double f = m - i0;
    const double* a = &irs.h[((size_t)t * CAB_NMIC + i0) * len];
    const double* b = a + len;
    for (int k = 0; k < len; k++) h[(size_t)k] = a[k] + f * (b[k] - a[k]);
  }
  void process(float* x, int n, int type, double mic) {
    set(type, mic);
    double* hh = h.data(); double* hs = hist.data();
    const int L = len;
    for (int i = 0; i < n; i++) {
      const double v = back.tick(bump.tick(hp.tick(x[i])));
      pos = pos == 0 ? L - 1 : pos - 1;
      hs[pos] = v; hs[pos + L] = v;
      double y = 0;
      for (int k = 0; k < L; k++) y += hh[k] * hs[pos + k];
      x[i] = (float)y;
    }
  }
private:
  const CabIrs& irs;
  int len;
  double fs;
  std::vector<double> h, hist;
  int pos = 0;
  Biquad hp, bump, back;
  int curType = -1; double curMic = -1;
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

class Eq7 {
public:
  static constexpr int BANDS = 7;
  explicit Eq7(double sampleRate) : fs(sampleRate) { for (auto& g : gains) g = std::nan(""); }
  void reset() { for (auto& b : bands) b.reset(); }
  /** Band gains in dB, low to high: the first seven values of `g`. */
  void set(const double* g) {
    static constexpr double FREQ[BANDS] = { 100, 200, 400, 800, 1600, 3200, 6400 };
    for (int b = 0; b < BANDS; b++) {
      if (g[b] == gains[b]) continue;
      gains[b] = g[b];
      bands[b].peak(fs, FREQ[b], 1.4, g[b]);
    }
  }
  void process(float* x, int n, double levelDb) {
    const double out = dbToGain(levelDb);
    for (int i = 0; i < n; i++) x[i] = (float)(bands[6].tick(bands[5].tick(bands[4].tick(bands[3].tick(bands[2].tick(bands[1].tick(bands[0].tick(x[i]))))))) * out);
  }
private:
  Biquad bands[BANDS];
  double gains[BANDS];
  double fs;
};

// ---- comp2.ts --------------------------------------------------------------

class StudioComp {
public:
  explicit StudioComp(double sampleRate) : fs(sampleRate) {}
  void reset() { power = 0; gr = 0; reduction = 0; }
  /** The largest gain reduction over the last block, dB (positive). */
  double reduction = 0;
  void process(float* x, int n, double thr, double ratio, double attack, double release, double knee, double makeupDb, double mix) {
    const double aP = std::exp(-1 / (0.012 * fs)), aA = std::exp(-1 / (attack * fs)), aR = std::exp(-1 / (release * fs));
    const double slope = 1 - 1 / ratio, makeup = dbToGain(makeupDb);
    double maxGr = 0;
    for (int i = 0; i < n; i++) {
      const double v = x[i];
      power = aP * power + (1 - aP) * v * v;
      const double over = 10 * std::log10(power + 1e-18) - thr;
      double want;
      if (2 * over < -knee) want = 0;
      else if (2 * over <= knee) want = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      else want = slope * over;
      gr = want > gr ? aA * gr + (1 - aA) * want : aR * gr + (1 - aR) * want;
      if (gr > maxGr) maxGr = gr;
      x[i] = (float)(v * (1 - mix) + v * dbToGain(-gr) * makeup * mix);
    }
    reduction = maxGr;
  }
private:
  double power = 0, gr = 0;
  double fs;
};

// ---- gtone.ts --------------------------------------------------------------

class GuitarTone {
public:
  explicit GuitarTone(double sampleRate) : fs(sampleRate) { denom(toneR(1), loadR(1), dRef); }
  void reset() { res.reset(); zero.reset(); vol.reset(); }
  void process(float* buf, int n, double tone, double volume) {
    if (tone != lastTone || volume != lastVol) { set(tone, volume); lastTone = tone; lastVol = volume; }
    for (int i = 0; i < n; i++) buf[i] = (float)vol.tick(zero.tick(res.tick(buf[i])));
  }
private:
  static constexpr double RP = PICKUP_R, LP = PICKUP_L, CP = PICKUP_CP, CC = CABLE_C, RV = 250e3, RT = 250e3, CT = 22e-9, RAMP = DI_LOAD;
  static constexpr double R_EDDY = 150e3, CB = 1e-9;
  static double toneR(double tone) { return 300 + RT * (std::pow(10.0, 2 * tone) - 1) / 99; }
  static double loadR(double volume) { const double a = volume * volume, r1 = std::max(1.0, (1 - a) * RV); return 1 / (1 / RV + 1 / (r1 + RAMP) + 1 / R_EDDY); }
  static void denom(double rt, double rl, double* d) {
    const double C = CP + CC, t = rt * CT;
    d[0] = 1 + RP / rl;
    d[1] = RP * C + LP / rl + t * (1 + RP / rl) + RP * CT;
    d[2] = LP * C + t * (RP * C + LP / rl) + LP * CT;
    d[3] = t * LP * C;
  }
  void set(double tone, double volume) {
    const double rt = toneR(tone);
    denom(rt, loadR(volume), d);
    res.set(fs, dRef[0], dRef[1], dRef[2], dRef[3], d[0], d[1], d[2], d[3]);
    zero.set(fs, 1, rt * CT, 1, toneR(1) * CT);
    const double a = volume * volume, r1 = std::max(1.0, (1 - a) * RV), r2 = std::max(1.0, a * RV);
    const double rth = r1 * r2 / (r1 + r2), t1 = r1 * CB, t2 = rth * CB, tc = rth * CC;
    bilinear2(vol, fs, 0, t1 * a, a, t2 * tc, t2 + tc, 1);
  }
  double fs;
  Cubic res; FirstOrder zero; Biquad vol;
  double dRef[4] = {}, d[4] = {};
  double lastTone = -1, lastVol = -1;
};

// ---- wah.ts ----------------------------------------------------------------

class Wah {
public:
  double pos = 0.5;
  explicit Wah(double sampleRate) : fs(sampleRate) {}
  void reset() { bp.reset(); load.reset(); env = 0; last = 0; }
  void process(float* x, int n, double posKnob, double autoAmt, double reson, double levelDb, double sR = 0, double sL = 0) {
    constexpr int STEP = 32;
    constexpr double FIT_FS = 44100;
    if (sR != srcR || sL != srcL) setLoad(sR, sL);
    const double atk = 1 - std::exp(-1 / (0.004 * fs)), rel = 1 - std::exp(-1 / (0.12 * fs));
    const double qs = std::pow(2.0, (reson - 0.6) * 2), out = dbToGain(levelDb);
    double e = env, cur = pos, l = last;
    for (int i0 = 0; i0 < n; i0 += STEP) {
      const int m = std::min(STEP, n - i0);
      cur = std::min(1.0, std::max(0.0, posKnob + autoAmt * std::min(1.0, e * 5)));
      const double q = qs * std::pow(2.0, 3 - 2 * cur);
      const double f = 450 * std::pow(2.0, 2.3 * cur), w = 2 * fs * std::tan(PI * std::min(f, 0.45 * fs) / fs);
      const double K = 0.1 * std::pow(4.0, cur) * FIT_FS;
      bilinear2(bp, fs, 0, K, 0, 1, w / q, w * w);
      for (int i = i0; i < i0 + m; i++) {
        const double v = load.tick(x[i]);
        const double a = std::abs(v);
        e += (a - e) * (a > e ? atk : rel);
        const double b = bp.tick(v), d = b - l;
        const double y = d > 1e-6 || d < -1e-6 ? (satInt(b) - satInt(l)) / d : sat(0.5 * (b + l));
        l = b;
        x[i] = (float)(y * out);
      }
    }
    env = e; pos = cur; last = l;
  }
private:
  static constexpr double SAT = 2, C_PICKUP = PICKUP_C, R_EDDY = PICKUP_EDDY, R_DI = DI_LOAD, R_WAH = 68e3;
  static double sat(double x) { return x / std::sqrt(1 + x * x / (SAT * SAT)); }
  static double satInt(double x) { return SAT * std::sqrt(SAT * SAT + x * x); }
  void setLoad(double sR, double sL) {
    srcR = sR; srcL = sL;
    if (sL <= 0) { load.bypass(); return; }
    const double di = 1 / (1 / R_DI + 1 / R_EDDY), wah = 1 / (1 / R_WAH + 1 / R_EDDY), LC = sL * C_PICKUP, RC = sR * C_PICKUP;
    bilinear2(load, fs, LC, sL / di + RC, 1 + sR / di, LC, sL / wah + RC, 1 + sR / wah);
  }
  Biquad bp, load;
  double env = 0, last = 0, srcR = -1, srcL = -1;
  double fs;
};

// ---- pedals.ts (envelope filter, pitch shifter) -----------------------------------

class EnvFilter {
public:
  explicit EnvFilter(double sampleRate) : fs(sampleRate) { coef(); }
  double pos = 0;
  void reset() { env = 0; ic1 = 0; ic2 = 0; pos = 0; }
  void process(float* x, int n, double sens, double freq, double range, double reson, double decay, double type, double dir, double level) {
    const double atk = 1 - std::exp(-1 / (0.004 * fs)), rel = 1 - std::exp(-1 / (std::max(0.005, decay) * fs));
    const double sg = 3 * std::pow(60.0, sens);
    const double Q = 1 + reson * reson * 16, kk = 1 / Q;
    const int t = (int)jsRound(type);
    const bool down = (int)jsRound(dir) == 1;
    const double top = std::min(0.45 * fs, freq * std::pow(2.0, range));
    const double ratio = top / freq;
    const double out = dbToGain(level) * (t == 1 ? 1 : 1 / std::sqrt(Q));
    double e0 = env, i1 = ic1, i2 = ic2;
    for (int i = 0; i < n; i += 8) {
      const int m = std::min(8, n - i);
      for (int j = 0; j < m; j++) {
        const double a = std::fabs((double)x[i + j]);
        e0 += (a - e0) * (a > e0 ? atk : rel);
      }
      const double v = e0 * sg, e = v / (1 + v);
      pos = e;
      const double f = freq * std::pow(ratio, down ? 1 - e : e);
      g = std::tan(PI * std::min(f, 0.45 * fs) / fs);
      k = kk;
      coef();
      for (int j = 0; j < m; j++) {
        const double s = x[i + j];
        const double v3 = s - i2;
        const double v1 = a1 * i1 + a2 * v3;
        const double v2 = i2 + a2 * i1 + a3 * v3;
        i1 = 2 * v1 - i1; i2 = 2 * v2 - i2;
        const double y = t == 0 ? v2 : t == 1 ? kk * v1 : s - kk * v1 - v2;
        x[i + j] = (float)(y * out);
      }
    }
    if (!std::isfinite(i1) || !std::isfinite(i2)) { i1 = 0; i2 = 0; e0 = 0; }
    env = e0; ic1 = i1; ic2 = i2;
  }
private:
  void coef() { a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; }
  double fs;
  double env = 0, ic1 = 0, ic2 = 0;
  double g = 0.05, k = 0.5, a1 = 0, a2 = 0, a3 = 0;
};

class PitchShift {
public:
  explicit PitchShift(double sampleRate) {
    const int w = (int)std::round(sampleRate * 0.06);
    wd = w - 8;
    buf.assign(w + 8, 0.f);
  }
  double ratio = 1;
  void reset() { std::fill(buf.begin(), buf.end(), 0.f); idx = 0; phase = 0; }
  void process(float* x, int n, double shift, double fine, double mix, double level) {
    const double st = jsRound(shift) + fine / 100;
    const double r = std::pow(2.0, st / 12);
    ratio = r;
    const int len = (int)buf.size();
    const double step = (1 - r) / wd, out = dbToGain(level);
    const bool bypass = std::fabs(st) < 1e-3;
    int i0 = idx; double p = phase;
    for (int i = 0; i < n; i++) {
      const double s = x[i];
      buf[i0] = (float)s;
      double wet = s;
      if (!bypass) {
        double p2 = p + 0.5; if (p2 >= 1) p2 -= 1;
        const double w1 = std::sin(PI * p), w2 = std::sin(PI * p2);
        wet = readDelayCubic(buf.data(), len, i0, 4 + wd * p) * w1 * w1 + readDelayCubic(buf.data(), len, i0, 4 + wd * p2) * w2 * w2;
        p += step;
        if (p >= 1) p -= 1; else if (p < 0) p += 1;
      }
      if (++i0 >= len) i0 = 0;
      x[i] = (float)((s + (wet - s) * mix) * out);
    }
    idx = i0; phase = p;
  }
private:
  std::vector<float> buf;
  int idx = 0; double phase = 0; int wd;
};

} // namespace pedalboard
