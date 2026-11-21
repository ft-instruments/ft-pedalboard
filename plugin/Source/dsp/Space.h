// The time-based modules: tape echo, spring tank and hall. C++ ports of
// src/dsp/delay.ts, spring.ts and reverb.ts.
#pragma once

#include <vector>
#include "Util.h"

namespace pedalboard {

// ---- delay.ts --------------------------------------------------------------

class TapeEcho {
public:
  double level = 0;
  explicit TapeEcho(double sampleRate) : fs(sampleRate) {
    const size_t len = (size_t)std::ceil(sampleRate * 1.45);
    bufL.assign(len, 0.f); bufR.assign(len, 0.f);
    time = sampleRate * 0.38;
  }
  void reset() { std::fill(bufL.begin(), bufL.end(), 0.f); std::fill(bufR.begin(), bufR.end(), 0.f); lpL = lpR = hpL = hpR = 0; prL = prR = deL = deR = 0; level = 0; }
  void process(float* L, float* R, int n, double seconds, double feedback, double tone, double wow, double mix, bool pingPong) {
    constexpr double EMPH_K = 1, EMPH_HZ = 2500, DRIFT_HZ = 3;
    const int len = (int)bufL.size();
    int i0 = idx;
    const double target = std::min(len - 0.03 * fs, std::max(8.0, seconds * fs));
    const double slew = 1 - std::exp(-1 / (0.12 * fs));
    const double lpA = 1 - std::exp(-2 * PI * (1200 + tone * 7000) / fs);
    const double hpA = 1 - std::exp(-2 * PI * 120 / fs);
    const double wowInc = 2 * PI * 0.55 / fs, flutInc = 2 * PI * 6.3 / fs;
    const double wowDepth = wow * 2.2e-3 * fs, flutDepth = wow * 0.18e-3 * fs;
    const double fb = feedback, wet = mix, dry = 1 - mix * 0.5;
    const double ea = 1 - std::exp(-2 * PI * EMPH_HZ / fs);
    const double da = 1 - std::exp(-2 * PI * DRIFT_HZ / fs), dn = wow * 0.8e-3 * fs / std::sqrt(da / (3 * (2 - da)));
    double t = time, wp = wowPh, fp = flutPh, dr = drift;
    auto tape = [&](double w, bool left) {
      double& pr = left ? prL : prR; double& de = left ? deL : deR;
      pr += (w - pr) * ea;
      const double sv = tanhf_((1 + EMPH_K) * w - EMPH_K * pr);
      const double y = (sv + EMPH_K * (1 - ea) * de) / (1 + EMPH_K * (1 - ea));
      de += (y - de) * ea;
      return y;
    };
    double l1 = lpL, l2 = lpR, h1 = hpL, h2 = hpR, peak = 0;
    for (int i = 0; i < n; i++) {
      t += (target - t) * slew;
      wp += wowInc; if (wp > 6.283185307) wp -= 6.283185307;
      fp += flutInc; if (fp > 6.283185307) fp -= 6.283185307;
      dr += (rng.bi() - dr) * da;
      const double d = t + (1 + std::sin(wp)) * wowDepth + std::sin(fp) * flutDepth + (1 + dr) * dn * 0.5;
      double rl = readDelayCubic(bufL.data(), len, i0, d);
      double rr = readDelayCubic(bufR.data(), len, i0, d + 0.6e-3 * fs);
      l1 += (rl - l1) * lpA; l2 += (rr - l2) * lpA;
      h1 += (l1 - h1) * hpA; h2 += (l2 - h2) * hpA;
      rl = l1 - h1; rr = l2 - h2;
      const double xl = L[i], xr = R[i];
      if (pingPong) {
        bufL[i0] = (float)tape((xl + xr) * 0.5 + rr * fb, true);
        bufR[i0] = (float)tape(rl * fb, false);
      } else {
        bufL[i0] = (float)tape(xl + rl * fb, true);
        bufR[i0] = (float)tape(xr + rr * fb, false);
      }
      const double a = std::abs(rl) + std::abs(rr); if (a > peak) peak = a;
      L[i] = (float)(xl * dry + rl * wet);
      R[i] = (float)(xr * dry + rr * wet);
      if (++i0 >= len) i0 = 0;
    }
    idx = i0; time = t; wowPh = wp; flutPh = fp; drift = dr;
    lpL = l1; lpR = l2; hpL = h1; hpR = h2;
    level = peak * 0.5;
  }
private:
  std::vector<float> bufL, bufR;
  int idx = 0;
  double time = 0, wowPh = 0, flutPh = 0;
  double lpL = 0, lpR = 0, hpL = 0, hpR = 0;
  double prL = 0, prR = 0, deL = 0, deR = 0, drift = 0;
  Rng rng;
  double fs;
};

// ---- spring.ts -------------------------------------------------------------

class StereoDelay {
public:
  double level = 0;
  explicit StereoDelay(double sampleRate) : fs(sampleRate) {
    const size_t len = (size_t)std::ceil(sampleRate * 1.55);
    bufL.assign(len, 0.f); bufR.assign(len, 0.f);
    tl = sampleRate * 0.375; tr = sampleRate * 0.5;
  }
  void reset() { std::fill(bufL.begin(), bufL.end(), 0.f); std::fill(bufR.begin(), bufR.end(), 0.f); lpL = lpR = hpL = hpR = 0; level = 0; }
  void process(float* L, float* R, int n, double timeL, double timeR, double fbL, double fbR, double cross,
               double tone, double mod, double levelL, double levelR, double mix, double drive) {
    const int len = (int)bufL.size();
    int i0 = idx;
    const double maxT = len - 0.04 * fs;
    const double targetL = std::min(maxT, std::max(8.0, timeL * fs)), targetR = std::min(maxT, std::max(8.0, timeR * fs));
    const double slew = 1 - std::exp(-1 / (0.1 * fs));
    const double lpA = 1 - std::exp(-2 * PI * (1200 + tone * 8000) / fs);
    const double hpA = 1 - std::exp(-2 * PI * 100 / fs);
    const double inc1 = 2 * PI * 0.6 / fs, inc2 = 2 * PI * 0.83 / fs, depth = mod * 1.5e-3 * fs;
    const double g = 1 + 3 * drive, gInv = 1 / g;
    const double wet = mix, dry = 1 - mix * 0.5;
    double t1 = tl, t2 = tr, p1 = ph1, p2 = ph2;
    double l1 = lpL, l2 = lpR, h1 = hpL, h2 = hpR, peak = 0;
    for (int i = 0; i < n; i++) {
      t1 += (targetL - t1) * slew; t2 += (targetR - t2) * slew;
      p1 += inc1; if (p1 > 6.283185307) p1 -= 6.283185307;
      p2 += inc2; if (p2 > 6.283185307) p2 -= 6.283185307;
      double rl = readDelayCubic(bufL.data(), len, i0, t1 + std::sin(p1) * depth + depth);
      double rr = readDelayCubic(bufR.data(), len, i0, t2 + std::sin(p2) * depth + depth);
      l1 += (rl - l1) * lpA; l2 += (rr - l2) * lpA;
      h1 += (l1 - h1) * hpA; h2 += (l2 - h2) * hpA;
      rl = l1 - h1; rr = l2 - h2;
      const double xl = L[i], xr = R[i];
      const double inL = xl + (xr - xl) * 0.5 * cross, inR = xr * (1 - cross);
      double wl = inL + ((1 - cross) * rl + cross * rr) * fbL;
      double wr = inR + ((1 - cross) * rr + cross * rl) * fbR;
      if (drive > 0) { wl = tanhf_(wl * g) * gInv; wr = tanhf_(wr * g) * gInv; }
      bufL[i0] = (float)wl; bufR[i0] = (float)wr;
      const double a = std::abs(rl) + std::abs(rr); if (a > peak) peak = a;
      L[i] = (float)(xl * dry + rl * wet * levelL);
      R[i] = (float)(xr * dry + rr * wet * levelR);
      if (++i0 >= len) i0 = 0;
    }
    idx = i0; tl = t1; tr = t2; ph1 = p1; ph2 = p2;
    lpL = l1; lpR = l2; hpL = h1; hpR = h2;
    level = peak * 0.5;
  }
private:
  std::vector<float> bufL, bufR;
  int idx = 0;
  double tl = 0, tr = 0, ph1 = 0, ph2 = 0.3;
  double lpL = 0, lpR = 0, hpL = 0, hpR = 0;
  double fs;
};

class Spring {
public:
  static constexpr int STAGES = 100;
  static constexpr double DISP_HZ = 4800;
  double trip = 0;
  Spring(double sampleRate, double ms, double A_) : K(std::max(1, (int)jsRound(sampleRate / (2 * DISP_HZ)))), len((int)jsRound(ms * 1e-3 * sampleRate)), A(A_) {
    ap.assign(STAGES * K, 0.f); apY.assign(STAGES * K, 0.f); line.assign((size_t)len, 0.f);
    const double wk = 2 * PI * 1000 / sampleRate * K;
    trip = (len + STAGES * K * (1 - A * A) / (1 + 2 * A * std::cos(wk) + A * A)) / sampleRate;
  }
  void reset() { std::fill(ap.begin(), ap.end(), 0.f); std::fill(apY.begin(), apY.end(), 0.f); std::fill(line.begin(), line.end(), 0.f); lp = hp = lp2 = 0; }
  double tick(double x, double g, double lpA, double hpA) {
    const double back = line[idx];
    lp += (back - lp) * lpA;
    hp += (lp - hp) * hpA;
    double v = x + (lp - hp) * g;
    const int j = apIdx;
    for (int s = 0; s < STAGES; s++) {
      const int o = s * K + j;
      const double xd = ap[o], yd = apY[o];
      const double y = A * v + xd - A * yd;
      ap[o] = (float)v; apY[o] = (float)y;
      v = y;
    }
    apIdx = j + 1 >= K ? 0 : j + 1;
    line[idx] = (float)v;
    if (++idx >= len) idx = 0;
    lp2 += (v - lp2) * lpA;
    return lp2;
  }
private:
  std::vector<float> ap, apY, line;
  int apIdx = 0, idx = 0;
  double lp = 0, hp = 0, lp2 = 0;
  int K, len;
  double A;
};

class SpringTank {
public:
  double level = 0;
  explicit SpringTank(double sampleRate) : a(sampleRate, 33, 0.73), b(sampleRate, 45, 0.77), fs(sampleRate) {}
  void reset() { a.reset(); b.reset(); level = 0; }
  void process(float* L, float* R, int n, double decay, double tone, double mix) {
    const double lpA = 1 - std::exp(-2 * PI * (2500 + tone * 3500) / fs);
    const double hpA = 1 - std::exp(-2 * PI * 180 / fs);
    const double w = 2 * PI * 1000 / fs, cw = std::cos(w);
    const double lpM = lpA / std::sqrt(1 - 2 * (1 - lpA) * cw + (1 - lpA) * (1 - lpA));
    const double hpLoss = (1 - hpA) * std::sqrt((2 - 2 * cw) / (1 - 2 * (1 - hpA) * cw + (1 - hpA) * (1 - hpA)));
    if (tone != lastTone) {
      lastTone = tone; double mx = 0;
      for (double f = 50; f < 12000; f *= 1.1) {
        const double c = std::cos(2 * PI * f / fs);
        const double l = lpA / std::sqrt(1 - 2 * (1 - lpA) * c + (1 - lpA) * (1 - lpA)), h = (1 - hpA) * std::sqrt((2 - 2 * c) / (1 - 2 * (1 - hpA) * c + (1 - hpA) * (1 - hpA)));
        if (l * h > mx) mx = l * h;
      }
      maxLH = mx;
    }
    const double d = std::max(0.1, decay), cap = 0.999 / maxLH;
    const double ga = std::min(cap, std::pow(10.0, -3 * a.trip / d) / (lpM * hpLoss)), gb = std::min(cap, std::pow(10.0, -3 * b.trip / d) / (lpM * hpLoss));
    const double wet = mix * 0.9, dry = 1 - mix * 0.4;
    double peak = 0;
    for (int i = 0; i < n; i++) {
      const double xl = L[i], xr = R[i];
      const double drive = (xl + xr) * 0.35;
      const double wl = a.tick(drive, ga, lpA, hpA);
      const double wr = b.tick(drive, gb, lpA, hpA);
      const double ab = std::abs(wl); if (ab > peak) peak = ab;
      L[i] = (float)(xl * dry + wl * wet);
      R[i] = (float)(xr * dry + wr * wet);
    }
    level = peak;
  }
private:
  Spring a, b;
  double fs;
  double lastTone = -1, maxLH = 1;
};

// ---- reverb.ts (hall) --------------------------------------------------------

class PitchUp {
public:
  explicit PitchUp(double sampleRate) : W((int)std::round(sampleRate * 0.045)) { buf.assign(W + 4, 0.f); }
  void clear() { std::fill(buf.begin(), buf.end(), 0.f); }
  double tick(double x) {
    const int len = (int)buf.size();
    buf[idx] = (float)x;
    const double p = phase;
    double p2 = p + 0.5; if (p2 >= 1) p2 -= 1;
    const double a = readDelay(buf.data(), len, idx, W * (1 - p)) * std::sin(PI * p);
    const double b = readDelay(buf.data(), len, idx, W * (1 - p2)) * std::sin(PI * p2);
    phase += 1.0 / W; if (phase >= 1) phase -= 1;
    if (++idx >= len) idx = 0;
    return a + b;
  }
private:
  std::vector<float> buf;
  int idx = 0;
  double phase = 0;
  int W;
};

class Hall {
public:
  explicit Hall(double sampleRate) : shimmer(sampleRate), fs(sampleRate) {
    const double ratio = sampleRate / 48000;
    for (int i = 0; i < N; i++) {
      lines[i].assign((size_t)std::ceil(BASE[i] * ratio * MAX_SCALE + MOD_DEPTH * 2 + 8), 0.f);
      modPhase[i] = (float)((double)i / N);
    }
    for (int i = 0; i < 4; i++) ap[i].assign((size_t)std::max(2.0, std::round(AP_MS[i] * 1e-3 * sampleRate)), 0.f);
    pre.assign((size_t)std::round(0.018 * sampleRate), 0.f);
    er.assign((size_t)std::ceil(0.035 * sampleRate) + 2, 0.f);
    setSize(0.6, 3, 0.5);
  }

  void clear() {
    for (auto& l : lines) std::fill(l.begin(), l.end(), 0.f);
    for (auto& a : ap) std::fill(a.begin(), a.end(), 0.f);
    std::fill(pre.begin(), pre.end(), 0.f);
    std::fill(lp, lp + N, 0.f); std::fill(hp, hp + N, 0.f); std::fill(er.begin(), er.end(), 0.f); inLp = 0;
    shimmer.clear(); shimLp = 0;
  }

  void process(float* L, float* R, int n, double size, double decay, double tone, double shim, double mix, double erAmt = 0) {
    static constexpr double ER_G[5] = { 0.62, -0.5, 0.42, -0.33, 0.26 };
    if (mix <= 0) return;
    setSize(size, decay, tone);
    const int erLen = (int)er.size();
    int ei = erIdx; double il = inLp;
    const double lpA = 1 - std::exp(-2 * PI * (1200 + tone * 9000) / fs);
    const double hpA = 1 - std::exp(-2 * PI * 70 / fs);
    const double shimLpA = 1 - std::exp(-2 * PI * 3500 / fs);
    const double twoOverN = 2.0 / N;
    const double wet = mix * 0.6, dry = 1 - mix * 0.35;
    const int preLen = (int)pre.size();
    int pi = preIdx;
    const double shimGain = shim * 0.45;
    double sl = shimLp;
    for (int i = 0; i < n; i++) {
      const double xl = L[i], xr = R[i];
      const double inMono = (xl + xr) * 0.5;
      const double preOut = pre[pi]; pre[pi] = (float)inMono; if (++pi >= preLen) pi = 0;
      il += (preOut - il) * lpA;
      double x = allpass(allpass(allpass(allpass(il, 0), 1), 2), 3);
      er[ei] = (float)inMono;
      double eL = 0, eR = 0;
      if (erAmt > 0) {
        for (int k = 0; k < 5; k++) {
          int a = ei - erTapL[k]; if (a < 0) a += erLen;
          int b = ei - erTapR[k]; if (b < 0) b += erLen;
          eL += ER_G[k] * er[a]; eR += ER_G[k] * er[b];
        }
      }
      if (++ei >= erLen) ei = 0;
      double sum = 0, outL = 0, outR = 0;
      for (int j = 0; j < N; j++) {
        double ph = (double)modPhase[j] + MOD_RATE[j] / fs; if (ph >= 1) ph -= 1; modPhase[j] = (float)ph;
        const double d = lengths[j] + std::sin(6.283185307 * ph) * MOD_DEPTH;
        const double v = readDelay(lines[j].data(), (int)lines[j].size(), idx[j], d);
        tmp[j] = (float)v; sum += v;
        if (j & 1) outR += (j & 2) ? v : -v; else outL += (j & 2) ? v : -v;
      }
      if (shimGain > 0) {
        const double sh = shimmer.tick((outL + outR) * 0.25);
        sl += (sh - sl) * shimLpA;
        x += tanhf_(sl * shimGain);
      }
      const double s = sum * twoOverN;
      for (int j = 0; j < N; j++) {
        lp[j] = (float)((double)lp[j] * damp[j] + ((double)tmp[j] - s) * dampG[j]);
        hp[j] = (float)(hp[j] + ((double)lp[j] - hp[j]) * hpA);
        const double v = (double)lp[j] - hp[j] + ((j & 1) ? -x : x);
        auto& line = lines[j];
        line[idx[j]] = (float)v;
        if (++idx[j] >= (int)line.size()) idx[j] = 0;
      }
      L[i] = (float)(xl * dry + (outL + erAmt * eL) * wet);
      R[i] = (float)(xr * dry + (outR + erAmt * eR) * wet);
    }
    preIdx = pi; shimLp = sl; erIdx = ei; inLp = il;
  }

private:
  static constexpr int N = 8;
  static constexpr double BASE[N] = { 1499, 1889, 2311, 2707, 3169, 3559, 4003, 4519 };
  static constexpr double MOD_RATE[N] = { 0.11, 0.17, 0.23, 0.31, 0.13, 0.19, 0.29, 0.37 };
  static constexpr double AP_MS[4] = { 3.1, 5.3, 8.7, 13.9 };
  static constexpr double AP_G = 0.62;
  static constexpr double MAX_SCALE = 1.45;
  static constexpr double MOD_DEPTH = 9;

  void setSize(double size, double decay, double tone) {
    static constexpr double ER_L[5] = { 4.3, 9.7, 15.1, 21.9, 29.3 }, ER_R[5] = { 5.9, 11.3, 17.7, 24.7, 33.1 };
    if (size == curSize && decay == curDecay && tone == curTone) return;
    curSize = size; curDecay = decay; curTone = tone;
    const double scale = (0.45 + size) * fs / 48000;
    const double hf = 0.35 + 0.5 * tone;
    const double c = std::cos(2 * PI * 4000 / fs), c1 = std::cos(2 * PI * 1000 / fs);
    const double trip = std::pow(10.0, 0.083 / 20 * (48000 / fs) * (48000 / fs));
    for (int i = 0; i < N; i++) {
      lengths[i] = BASE[i] * scale;
      const double g0 = std::pow(10.0, (-3 * lengths[i]) / (decay * fs)), r2 = std::pow(g0, 2 / hf - 2);
      const double p = 1 - r2 * c, q = 1 - r2;
      const double b = (p - std::sqrt(p * p - q * q)) / q;
      const double m1 = (1 - b) / std::sqrt(1 - 2 * b * c1 + b * b), g = std::min(0.9995, g0 / m1 * trip);
      gains[i] = (float)g; damp[i] = (float)b; dampG[i] = (float)(g * (1 - b));
    }
    const double es = (0.4 + 2 * std::min(0.3, size)) * 1e-3 * fs;
    for (int k = 0; k < 5; k++) { erTapL[k] = (int)jsRound(ER_L[k] * es); erTapR[k] = (int)jsRound(ER_R[k] * es); }
  }

  double allpass(double x, int i) {
    auto& buf = ap[i];
    int k = apIdx[i];
    const double d = buf[k];
    const double v = x - AP_G * d;
    buf[k] = (float)v;
    if (++k >= (int)buf.size()) k = 0;
    apIdx[i] = k;
    return d + AP_G * v;
  }

  std::vector<float> lines[N];
  int idx[N] = {};
  double lengths[N] = {};
  float gains[N] = {}, damp[N] = {}, dampG[N] = {};
  std::vector<float> er;
  int erIdx = 0, erTapL[5] = {}, erTapR[5] = {};
  double inLp = 0;
  float lp[N] = {}, hp[N] = {};
  float modPhase[N] = {};
  float tmp[N] = {};
  std::vector<float> ap[4];
  int apIdx[4] = {};
  std::vector<float> pre;
  int preIdx = 0;
  PitchUp shimmer;
  double shimLp = 0;
  double fs;
  double curSize = -1, curDecay = -1, curTone = -1;
};

} // namespace pedalboard
