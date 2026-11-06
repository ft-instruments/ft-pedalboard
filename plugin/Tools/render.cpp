// Offline render of the C++ engine, the twin of `node scripts/render.ts raw`:
// every factory rig through the demo strum for 6 s, written as raw float32
// stereo (interleaved) to <dir>/<rig>.f32. scripts/null-test.ts compares the two.
//
//   render <dir>          every rig
//   render bench          CPU timing on the heaviest rig

#include <cctype>
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>
#include "../Source/dsp/Engine.h"
#include "../Source/dsp/Demo.h"

using namespace pedalboard;

static constexpr double FS = 48000;
static constexpr int BLOCK = 128;

static void render(const Preset& pr, double seconds, std::vector<float>& L, std::vector<float>& R) {
  Engine e(FS);
  e.loadPreset(pr);
  e.snap();
  DemoGuitar g(FS);
  const int n = (int)jsRound(seconds * FS);
  L.assign((size_t)n, 0.f); R.assign((size_t)n, 0.f);
  float inp[BLOCK];
  for (int off = 0; off < n; off += BLOCK) {
    const int m = std::min(BLOCK, n - off);
    g.process(inp, m);
    e.process(inp, L.data() + off, R.data() + off, m);
  }
}

static std::string slug(const char* name) {
  std::string s;
  bool space = false;
  for (const char* c = name; *c; c++) {
    if (std::isspace((unsigned char)*c)) { space = true; continue; }
    if (space && !s.empty()) s += '-';
    space = false;
    s += (char)std::tolower((unsigned char)*c);
  }
  return s;
}

int main(int argc, char** argv) {
  const std::string arg = argc > 1 ? argv[1] : "out/cpp";
  if (arg == "bench") {
    std::vector<float> L, R;
    for (int i = 0; i < NUM_PRESETS; i++) {
      const auto t0 = std::chrono::steady_clock::now();
      render(PRESETS[i], 5, L, R);
      const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      std::printf("%-18s %5.1f%% of real time\n", PRESETS[i].name, ms / 5000 * 100);
    }
    return 0;
  }
  for (int i = 0; i < NUM_PRESETS; i++) {
    std::vector<float> L, R;
    render(PRESETS[i], 6, L, R);
    std::vector<float> inter(L.size() * 2);
    for (size_t k = 0; k < L.size(); k++) { inter[2 * k] = L[k]; inter[2 * k + 1] = R[k]; }
    const std::string path = arg + "/" + slug(PRESETS[i].name) + ".f32";
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) { std::fprintf(stderr, "cannot write %s\n", path.c_str()); return 1; }
    std::fwrite(inter.data(), sizeof(float), inter.size(), f);
    std::fclose(f);
  }
  std::printf("wrote %d rigs to %s\n", NUM_PRESETS, arg.c_str());
  return 0;
}
