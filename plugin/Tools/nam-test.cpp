// Loads a .nam through pedalboard::loadNam at 44.1 and 48 kHz and checks the output is finite, not silent,
// and the same for any block size (48 kHz). Build and run (NAM core in ~/SDKs/NeuralAmpModelerCore):
//   N=~/SDKs/NeuralAmpModelerCore; clang++ -std=c++20 -O2 -I$N -I$N/Dependencies/eigen -I$N/Dependencies/nlohmann -Iplugin/Source \
//     plugin/Tools/nam-test.cpp plugin/Source/NamHost.cpp $(find $N/NAM -name "*.cpp") -o /tmp/nam-test && /tmp/nam-test $N/example_models/wavenet.nam
#include "dsp/NamHost.h"
#include <cmath>
#include <cstdio>
#include <vector>

using namespace pedalboard;

static std::vector<float> render(NamUnit& u, const std::vector<float>& in, int block) {
  std::vector<float> out(in.size());
  for (size_t i = 0; i < in.size(); i += (size_t) block) u.process(&in[i], &out[i], (int) std::min<size_t>((size_t) block, in.size() - i));
  return out;
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  int bad = 0;
  std::vector<float> in(48000);
  for (size_t i = 0; i < in.size(); i++) in[i] = 0.2f * std::sin(0.05f * (float) i) * (i > 2000 ? 1.0f : 0.0f);
  for (double sr : { 48000.0, 44100.0 }) {
    std::string err;
    auto u = loadNam(argv[1], sr, err);
    if (!u) { std::printf("FAIL load @%.0f: %s\n", sr, err.c_str()); return 1; }
    auto y = render(*u, in, 128);
    double peak = 0; bool fin = true;
    for (float v : y) { peak = std::max(peak, (double) std::fabs(v)); fin = fin && std::isfinite(v); }
    const bool ok = fin && peak > 1e-3 && peak < 50;
    std::printf("%s @%.0f Hz: peak %.3f\n", ok ? "ok  " : "FAIL", sr, peak);
    bad += !ok;
  }
  std::string err;
  auto a = loadNam(argv[1], 48000, err), b = loadNam(argv[1], 48000, err);
  auto ya = render(*a, in, 64), yb = render(*b, in, 480);
  double d = 0; for (size_t i = 0; i < ya.size(); i++) d = std::max(d, (double) std::fabs(ya[i] - yb[i]));
  std::printf("%s block size 64 vs 480: max diff %.2e\n", d < 1e-4 ? "ok  " : "FAIL", d);
  bad += d >= 1e-4;
  return bad;
}
