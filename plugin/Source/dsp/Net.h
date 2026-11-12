// A small linear circuit solver for the pedals' passive networks: C++ port
// of src/dsp/net.ts (resistors and capacitors between numbered nodes, one
// ideal source on node 1, trapezoidal companions, an inverted conductance
// matrix rebuilt when a resistor changes, an optional diode pair at one node
// solved through a table with antiderivative antialiasing).
#pragma once

#include <vector>
#include "Util.h"

namespace pedalboard {

class LinearNet {
public:
  int n;
  std::vector<double> inv, v;

  LinearNet(int nodes, double sampleRate) : n(nodes), inv((size_t)(nodes * nodes)), v((size_t)(nodes + 2)), T(1 / sampleRate),
    bin((size_t)nodes), m((size_t)(nodes * nodes)), rhs((size_t)nodes) {}

  int r(int a, int b, double ohms) { const int i = nr++; ra[i] = a; rb[i] = b; rv[i] = ohms; dirty = true; return i; }
  void c(int a, int b, double farads) { const int i = nc++; ca[i] = a; cb[i] = b; cg[i] = 2 * farads / T; cj[i] = 0; dirty = true; }
  void setR(int i, double ohms) { if (rv[i] != ohms) { rv[i] = ohms; dirty = true; } }

  void reset() { for (int i = 0; i < 16; i++) cj[i] = 0; for (auto& x : v) x = 0; lastOpen = 0; }

  void build() {
    for (auto& x : m) x = 0;
    for (auto& x : bin) x = 0;
    for (int i = 0; i < nr; i++) stamp(ra[i], rb[i], 1 / rv[i]);
    for (int i = 0; i < nc; i++) stamp(ca[i], cb[i], cg[i]);
    for (auto& x : inv) x = 0;
    for (int i = 0; i < n; i++) inv[(size_t)(i * n + i)] = 1;
    for (int c = 0; c < n; c++) {
      int p = c;
      for (int rr = c + 1; rr < n; rr++) if (std::abs(m[(size_t)(rr * n + c)]) > std::abs(m[(size_t)(p * n + c)])) p = rr;
      if (p != c) for (int k = 0; k < n; k++) { std::swap(m[(size_t)(c * n + k)], m[(size_t)(p * n + k)]); std::swap(inv[(size_t)(c * n + k)], inv[(size_t)(p * n + k)]); }
      const double d = 1 / m[(size_t)(c * n + c)];
      for (int k = 0; k < n; k++) { m[(size_t)(c * n + k)] *= d; inv[(size_t)(c * n + k)] *= d; }
      for (int rr = 0; rr < n; rr++) {
        if (rr == c) continue;
        const double f = m[(size_t)(rr * n + c)];
        if (f == 0) continue;
        for (int k = 0; k < n; k++) { m[(size_t)(rr * n + k)] -= f * m[(size_t)(c * n + k)]; inv[(size_t)(rr * n + k)] -= f * inv[(size_t)(c * n + k)]; }
      }
    }
    dirty = false;
  }

  double rth(int d) { if (dirty) build(); return inv[(size_t)((d - 2) * n + d - 2)]; }

  void tick(double u) { open(u); commit(); }

  template <class Table>
  double tickDiode(double u, int d, const Table& table) {
    open(u);
    const int k = d - 2;
    const double rr = inv[(size_t)(k * n + k)];
    const double vo = v[(size_t)d], vd = table.adaa(vo, lastOpen), id = (vo - vd) / rr;
    lastOpen = vo;
    for (int i = 0; i < n; i++) v[(size_t)(i + 2)] -= inv[(size_t)(i * n + k)] * id;
    commit();
    return id;
  }

private:
  void stamp(int a, int b, double g) {
    if (a >= 2) m[(size_t)((a - 2) * n + a - 2)] += g;
    if (b >= 2) m[(size_t)((b - 2) * n + b - 2)] += g;
    if (a >= 2 && b >= 2) { m[(size_t)((a - 2) * n + b - 2)] -= g; m[(size_t)((b - 2) * n + a - 2)] -= g; }
    if (a == 1 && b >= 2) bin[(size_t)(b - 2)] += g;
    if (b == 1 && a >= 2) bin[(size_t)(a - 2)] += g;
  }
  void open(double u) {
    if (dirty) build();
    for (int i = 0; i < n; i++) rhs[(size_t)i] = bin[(size_t)i] * u;
    for (int i = 0; i < nc; i++) {
      const int a = ca[i], b = cb[i]; const double j = cj[i];
      if (a >= 2) rhs[(size_t)(a - 2)] += j;
      if (b >= 2) rhs[(size_t)(b - 2)] -= j;
    }
    v[0] = 0; v[1] = u;
    for (int i = 0; i < n; i++) { double s = 0; for (int k = 0; k < n; k++) s += inv[(size_t)(i * n + k)] * rhs[(size_t)k]; v[(size_t)(i + 2)] = s; }
  }
  void commit() {
    for (int i = 0; i < nc; i++) {
      const double vab = v[(size_t)ca[i]] - v[(size_t)cb[i]], g = cg[i];
      const double cur = g * vab - cj[i];
      cj[i] = g * vab + cur;
    }
  }
  double T;
  int ra[16] = {}, rb[16] = {}; double rv[16] = {}; int nr = 0;
  int ca[16] = {}, cb[16] = {}; double cg[16] = {}, cj[16] = {}; int nc = 0;
  std::vector<double> bin, m, rhs;
  bool dirty = true;
  double lastOpen = 0;
};

} // namespace pedalboard
