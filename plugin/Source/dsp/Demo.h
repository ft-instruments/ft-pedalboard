// The demo guitar: six Karplus-Strong strings playing three loops, so the
// rig can be heard without a guitar plugged in. C++ port of src/dsp/demo.ts.
#pragma once

#include <algorithm>
#include <vector>
#include "Util.h"

namespace pedalboard {

class PluckedString {
public:
  static constexpr int MAX_LEN = 1024;
  static constexpr double MUTED = 0.16;

  void reset() { std::fill(line, line + MAX_LEN, 0.f); std::fill(hist, hist + 256, 0.f); y1 = 0; }

  void pluck(double freq, double vel, bool muted, double fs, Rng& rng, int string) {
    static constexpr double OPEN[6] = { 82.41, 110.0, 146.83, 196.0, 246.94, 329.63 };
    static constexpr double SUSTAIN[6] = { 6.5, 5.5, 4.8, 4.0, 3.4, 2.8 };
    len = std::min((double)(MAX_LEN - 2), fs / freq - 0.5);
    const double t60 = muted ? MUTED : SUSTAIN[string] * std::pow(0.82, std::log2(freq / OPEN[string]) * 2);
    g = std::pow(10.0, -3 / (t60 * freq));
    bright = muted ? 0.25 : 0.5 + 0.35 * vel;
    pickup = (int)std::max(1.0, std::min(255.0, jsRound(len * 0.18)));
    const int L = (int)jsRound(len), pick = (int)std::max(1.0, jsRound(L * 0.13));
    const double amp = (0.25 + 0.75 * vel) * 0.55;
    const double lpA = muted ? 0.25 : 0.35 + 0.5 * vel;
    double lp = 0;
    for (int k = 0; k < L; k++) { lp += (rng.bi() - lp) * lpA; exc[k] = (float)(lp * amp); }
    for (int k = 0; k < L; k++) {
      const int i = (w - L + k + MAX_LEN * 2) % MAX_LEN;
      line[i] = (float)(line[i] * 0.2 + exc[k] - (k >= pick ? 0.9 * exc[k - pick] : 0));
    }
  }

  void damp(double fs) { g = std::min(g, std::pow(10.0, -3 / (MUTED * 2 * (fs / len)))); }

  double tick() {
    double r = w - len;
    while (r < 0) r += MAX_LEN;
    const int i0 = (int)r;
    const double fr = r - i0;
    const int i1 = i0 + 1 >= MAX_LEN ? 0 : i0 + 1;
    const double y = line[i0] + ((double)line[i1] - line[i0]) * fr;
    const double b = bright;
    const double v = (y * (0.5 + 0.5 * b) + y1 * (0.5 - 0.5 * b)) * g;
    y1 = y;
    line[w] = (float)v;
    if (++w >= MAX_LEN) w = 0;
    hist[h] = (float)y;
    const int p = (h - pickup + 256) & 255;
    h = (h + 1) & 255;
    return y - 0.6 * hist[p];
  }

private:
  float line[MAX_LEN] = {}, hist[256] = {}, exc[MAX_LEN] = {};
  int w = 0, h = 0;
  double len = 400, g = 0.999, bright = 0.5, y1 = 0;
  int pickup = 40;
};

class DemoGuitar {
public:
  struct Ev { double t; int string, fret; double vel; int muted; };
  struct Pattern { std::vector<Ev> ev; double len; };

  explicit DemoGuitar(double sampleRate) : fs(sampleRate), rng(0x51ed) {
    patterns[0] = strum(); patterns[1] = riff(); patterns[2] = lick();
    for (auto& p : patterns) std::stable_sort(p.ev.begin(), p.ev.end(), [](const Ev& a, const Ev& b) { return a.t < b.t; });
  }

  void setPattern(int i) {
    i = std::max(0, std::min(2, i));
    if (i == pattern) return;
    pattern = i;
    reset();
  }

  void reset() { t = 0; next = 0; for (auto& s : strings) s.reset(); }

  void process(float* out, int n) {
    static constexpr double OPEN[6] = { 82.41, 110.0, 146.83, 196.0, 246.94, 329.63 };
    const Pattern& p = patterns[pattern];
    const double dt = 1 / fs;
    for (int i = 0; i < n; i++) {
      while (next < p.ev.size() && p.ev[next].t <= t) {
        const Ev& e = p.ev[next++];
        if (e.fret < 0) strings[e.string].damp(fs);
        else strings[e.string].pluck(OPEN[e.string] * std::pow(2.0, e.fret / 12.0), e.vel, e.muted > 0, fs, rng, e.string);
      }
      double v = 0;
      for (int s = 0; s < 6; s++) v += strings[s].tick();
      out[i] = (float)(v * 0.16);
      t += dt;
      if (t >= p.len) { t -= p.len; next = 0; }
    }
  }

private:
  static Pattern strum() {
    const double beat = 60.0 / 92;
    Pattern p;
    const int chords[4][6] = { { 0, 2, 2, 0, 0, 0 }, { -1, 3, 2, 0, 1, 0 }, { 3, 2, 0, 0, 0, 3 }, { -1, -1, 0, 2, 3, 2 } };
    const double pattern[6][2] = { { 0, 1 }, { 1, 1 }, { 1.5, -1 }, { 2.5, -1 }, { 3, 1 }, { 3.5, -1 } };
    for (int bar = 0; bar < 4; bar++) {
      const double t0 = bar * 4 * beat;
      for (int s = 0; s < 6; s++) if (chords[bar][s] < 0) p.ev.push_back({ t0, s, -1, 0, 0 });
      for (const auto& pb : pattern) {
        const double b = pb[0], dir = pb[1];
        std::vector<std::pair<int, int>> strings;
        for (int s = 0; s < 6; s++) if (chords[bar][s] >= 0) strings.push_back({ s, chords[bar][s] });
        std::vector<std::pair<int, int>> order;
        if (dir > 0) order = strings;
        else {
          const size_t from = strings.size() > 4 ? strings.size() - 4 : 0;
          order.assign(strings.begin() + (long)from, strings.end());
          std::reverse(order.begin(), order.end());
        }
        for (size_t k = 0; k < order.size(); k++)
          p.ev.push_back({ t0 + b * beat + (double)k * (dir > 0 ? 0.011 : 0.008), order[k].first, order[k].second, dir > 0 ? 0.75 : 0.45, 0 });
      }
    }
    p.len = 16 * beat;
    return p;
  }

  static Pattern riff() {
    const double e8 = 60.0 / 120 / 2;
    Pattern p;
    auto power = [&p](double t, int root, int fret, double vel, int muted) {
      p.ev.push_back({ t, root, fret, vel, muted });
      p.ev.push_back({ t + 0.004, root + 1, fret + 2, vel, muted });
      if (!muted) p.ev.push_back({ t + 0.008, root + 2, fret + 2, vel * 0.9, 0 });
    };
    for (int bar = 0; bar < 4; bar++) {
      const double t0 = bar * 8 * e8;
      for (int k = 0; k < 5; k++) power(t0 + k * e8, 0, 0, 0.7, 1);
      const bool last = bar == 3;
      power(t0 + 5 * e8, 0, last ? 5 : 3, 0.9, 0);
      power(t0 + 6.5 * e8, 0, last ? 7 : 5, 0.9, 0);
    }
    p.len = 32 * e8;
    return p;
  }

  static Pattern lick() {
    const double s16 = 60.0 / 100 / 4;
    Pattern p;
    const int notes[16][2] = { { 3, 12 }, { 3, 14 }, { 4, 12 }, { 4, 15 }, { 5, 12 }, { 5, 15 }, { 5, 12 }, { 4, 15 },
      { 4, 12 }, { 3, 14 }, { 3, 12 }, { 2, 14 }, { 2, 12 }, { 1, 14 }, { 2, 14 }, { 3, 14 } };
    for (int k = 0; k < 16; k++) {
      const int s = notes[k][0], f = notes[k][1];
      p.ev.push_back({ k * s16, s, f, 0.6 + 0.25 * ((k % 4) == 0 ? 1 : 0), 0 });
      if (k > 0 && notes[k - 1][0] != s) p.ev.push_back({ k * s16 + 0.02, notes[k - 1][0], -1, 0, 0 });
    }
    const double t = 16 * s16;
    p.ev.push_back({ t, 4, 15, 0.85, 0 }); p.ev.push_back({ t + 8 * s16, 4, -1, 0, 0 });
    p.ev.push_back({ t + 12 * s16, 3, 14, 0.8, 0 }); p.ev.push_back({ t + 12 * s16 + 0.03, 4, 15, 0.7, 0 });
    p.len = t + 28 * s16;
    return p;
  }

  PluckedString strings[6];
  Pattern patterns[3];
  int pattern = 0;
  double t = 0;
  size_t next = 0;
  double fs;
  Rng rng;
};

} // namespace pedalboard
