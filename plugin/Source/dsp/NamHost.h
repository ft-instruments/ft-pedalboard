// The NAM (Neural Amp Modeler) unit's interface. Engine.h only sees this; the
// implementation (NamHost.cpp) links the NAM core, so the engine and the null
// test build without it. Plugin only: the web version passes the signal through.
#pragma once
#include <memory>
#include <string>

namespace pedalboard {

class NamUnit {
public:
  virtual ~NamUnit() = default;
  /** Mono, in place-safe; any n up to MAX_BLOCK. Samples are digital full scale (the engine scales volts to it). */
  virtual void process(const float* in, float* out, int n) = 0;
};

/** Load a .nam at the host's sample rate (resampling when the model is trained at another). nullptr and `error` set on failure. Message thread. */
std::unique_ptr<NamUnit> loadNam(const std::string& path, double hostRate, std::string& error);

} // namespace pedalboard
