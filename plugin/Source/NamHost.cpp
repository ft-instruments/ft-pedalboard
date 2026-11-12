// NAM unit (compiled as C++20 with the NAM core, see CMakeLists.txt).
#include "dsp/NamHost.h"
#include <NAM/dsp.h>
#include <NAM/get_dsp.h>
#include <algorithm>
#include <cmath>
#include <exception>
#include <filesystem>
#include <vector>

namespace pedalboard {
namespace {

constexpr int MAX_N = 4096;   // the largest block either side sees

/** Streaming 4-point Hermite resampler; `step` = input samples per output sample. */
struct Resampler {
  double step = 1, ph = 0;
  float h0 = 0, h1 = 0, h2 = 0, h3 = 0;
  int run(const float* in, int n, float* out) {
    int m = 0;
    for (int i = 0; i < n; i++) {
      h0 = h1; h1 = h2; h2 = h3; h3 = in[i];
      while (ph < 1.0) {
        const float t = (float) ph;
        const float c0 = h1, c1 = 0.5f * (h2 - h0), c2 = h0 - 2.5f * h1 + 2.0f * h2 - 0.5f * h3, c3 = 0.5f * (h3 - h0) + 1.5f * (h1 - h2);
        out[m++] = ((c3 * t + c2) * t + c1) * t + c0;
        ph += step;
      }
      ph -= 1.0;
    }
    return m;
  }
};

class NamModel final : public NamUnit {
public:
  NamModel(std::unique_ptr<nam::DSP> d, double hostRate) : dsp(std::move(d)) {
    modelRate = dsp->GetExpectedSampleRate();
    if (modelRate <= 0) modelRate = hostRate;
    direct = std::abs(modelRate - hostRate) < 0.5;
    dsp->Reset(modelRate, MAX_N);
    up.step = hostRate / modelRate;      // host samples per model sample
    down.step = modelRate / hostRate;
    fifo.assign(MAX_N * 4, 0.0f);
    wr = PREFILL;                         // a few samples of silence so a short block never runs dry
  }

  void process(const float* in, float* out, int n) override {
    n = std::min(n, MAX_N / 4);
    if (direct) { run(in, out, n); return; }
    const int m = up.run(in, n, mIn.data());
    run(mIn.data(), mOut.data(), m);
    const int k = down.run(mOut.data(), m, tmp.data());
    const int cap = (int) fifo.size();
    for (int i = 0; i < k; i++) { fifo[(size_t) (wr % cap)] = tmp[(size_t) i]; wr++; }
    for (int i = 0; i < n; i++) { out[i] = rd < wr ? fifo[(size_t) (rd % cap)] : 0.0f; if (rd < wr) rd++; }
  }

private:
  void run(const float* in, float* out, int n) {
    for (int i = 0; i < n; i++) din[(size_t) i] = in[i];
    double* ip = din.data(); double* op = dout.data();
    dsp->process(&ip, &op, n);
    for (int i = 0; i < n; i++) out[i] = std::isfinite(dout[(size_t) i]) ? (float) dout[(size_t) i] : 0.0f;
  }

  static constexpr long PREFILL = 8;
  std::unique_ptr<nam::DSP> dsp;
  double modelRate = 48000;
  bool direct = true;
  Resampler up, down;
  std::vector<double> din = std::vector<double>(MAX_N), dout = std::vector<double>(MAX_N);
  std::vector<float> mIn = std::vector<float>(MAX_N), mOut = std::vector<float>(MAX_N), tmp = std::vector<float>(MAX_N), fifo;
  long wr = 0, rd = 0;
};

} // namespace

std::unique_ptr<NamUnit> loadNam(const std::string& path, double hostRate, std::string& error) {
  try {
    auto d = nam::get_dsp(std::filesystem::path(path));
    if (!d) { error = "not a NAM model"; return nullptr; }
    if (d->NumInputChannels() != 1 || d->NumOutputChannels() != 1) { error = "only mono models are supported"; return nullptr; }
    return std::make_unique<NamModel>(std::move(d), hostRate);
  } catch (const std::exception& e) {
    error = e.what();
  } catch (...) {
    error = "could not load that model";
  }
  return nullptr;
}

} // namespace pedalboard
