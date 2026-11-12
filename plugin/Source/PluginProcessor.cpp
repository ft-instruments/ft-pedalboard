#include "PluginProcessor.h"
#include "PluginEditor.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <cmath>
#include <limits>

using namespace pedalboard;

namespace {

// ---- parameters: the same curves and text as src/dsp/params.ts ------------

bool discrete(const ParamDef& p) { return p.scale == Scale::Int || p.scale == Scale::Enum || p.scale == Scale::Bool; }

juce::String utf8(const char* s) { return juce::String(juce::CharPointer_UTF8(s)); }

juce::String format(const ParamDef& p, double v) {
  if (p.labels) {
    const int i = (int)jsRound(v);
    return i >= 0 && i < p.numLabels ? utf8(p.labels[i]) : juce::String(v);
  }
  if (p.scale == Scale::Bool) return v >= 0.5 ? "on" : "off";
  const juce::String unit = p.unit ? utf8(p.unit) : juce::String();
  if (unit == "dBFS") return juce::String(v, 1) + " dBFS";
  if (unit == "dB") return juce::String(v, std::abs(v) < 10 ? 1 : 0) + " dB";
  // the slot knobs mean something different for every module: show them like the gear does, 0 to 10
  return juce::String(v * 10, 1);
}

/** Host-facing name: "Input", "Slot 3 module", "Slot 3 knob 2". */
juce::String hostName(const ParamDef& p) {
  const juce::String group = p.group, name = utf8(p.name);
  if (group.startsWith("slot")) return "Slot " + group.substring(4) + " " + name;
  return name.substring(0, 1).toUpperCase() + name.substring(1);
}

/** A float parameter that tells the host when it is really a switch or a list. */
class RackParam final : public juce::AudioParameterFloat {
public:
  RackParam(const ParamDef& d)
    : AudioParameterFloat(juce::ParameterID { d.id, 1 }, hostName(d),
        juce::NormalisableRange<float>((float)d.min, (float)d.max,
          [&d](float, float, float t) { return (float)fromNorm(d, t); },
          [&d](float, float, float v) { return (float)toNorm(d, v); },
          [&d](float, float, float v) {
            const double c = std::min(d.max, std::max(d.min, (double)v));
            return (float)(discrete(d) ? jsRound(c) : c);
          }),
        (float)d.def,
        juce::AudioParameterFloatAttributes()
          .withStringFromValueFunction([&d](float v, int) { return format(d, v); })),
      def(d) {}

  int getNumSteps() const override {
    return discrete(def) ? (int)jsRound(def.max - def.min) + 1 : juce::AudioProcessor::getDefaultNumParameterSteps();
  }
  bool isDiscrete() const override { return discrete(def); }
  bool isBoolean() const override { return def.scale == Scale::Bool; }

private:
  const ParamDef& def;
};

juce::AudioProcessorValueTreeState::ParameterLayout makeLayout() {
  juce::AudioProcessorValueTreeState::ParameterLayout layout;
  for (int i = 0; i < NUM_PARAMS; i++) layout.add(std::make_unique<RackParam>(PARAMS[i]));
  return layout;
}

} // namespace

// ============================================================================

PedalboardProcessor::PedalboardProcessor()
  : AudioProcessor(BusesProperties()
      .withInput("Input", juce::AudioChannelSet::stereo(), true)
      .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
    apvts(*this, nullptr, "PEDALBOARD", makeLayout()) {
  for (int i = 0; i < NUM_PARAMS; i++) {
    params[(size_t)i] = apvts.getParameter(PARAMS[i].id);
    raw[(size_t)i] = apvts.getRawParameterValue(PARAMS[i].id);
    jassert(params[(size_t)i] != nullptr && raw[(size_t)i] != nullptr);
  }
  pushed.fill(std::numeric_limits<float>::quiet_NaN());
  // a new instance starts on the first factory rig, like the web page does
  loadFactory(0);
}

void PedalboardProcessor::prepareToPlay(double sr, int) {
  sampleRate = sr;
  engine = std::make_unique<Engine>(sr);
  demo = std::make_unique<DemoGuitar>(sr);
  pushed.fill(std::numeric_limits<float>::quiet_NaN());   // push every parameter on the next block
  fresh = true;
  if (irPath.isNotEmpty()) loadIR(irPath);
  if (namPath.isNotEmpty()) loadNAM(namPath);   // the engine is new: give it the impulse response again
}

bool PedalboardProcessor::loadNAM(const juce::String& path) {
  namError = {};
  if (path.isEmpty()) { namPath = {}; if (engine) engine->setNam(nullptr); stateVersion++; return true; }
  std::string err;
  auto unit = pedalboard::loadNam(path.toStdString(), sampleRate, err);
  if (!unit) { namError = err; return false; }
  if (engine) engine->setNam(std::move(unit));
  namPath = path;
  stateVersion++;
  return true;
}

bool PedalboardProcessor::loadIR(const juce::String& path) {
  if (path.isEmpty()) { irPath = {}; if (engine) engine->setIR(nullptr, 0); stateVersion++; return true; }
  juce::AudioFormatManager fm;
  fm.registerBasicFormats();
  std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(juce::File(path)));
  if (!reader || reader->lengthInSamples < 2 || reader->lengthInSamples > 48000 * 10) return false;
  const int n = (int)reader->lengthInSamples, ch = (int)reader->numChannels;
  juce::AudioBuffer<float> buf(ch, n);
  reader->read(&buf, 0, n, 0, true, true);
  std::vector<float> mono((size_t)n, 0.0f);
  for (int c = 0; c < ch; c++) for (int i = 0; i < n; i++) mono[(size_t)i] += buf.getSample(c, i) / (float)ch;
  const double ratio = reader->sampleRate / sampleRate;
  if (std::abs(ratio - 1.0) > 1e-6) {
    const int m = (int)std::ceil(n / ratio);
    std::vector<float> out((size_t)m, 0.0f);
    juce::LagrangeInterpolator li;
    li.process(ratio, mono.data(), out.data(), m);
    mono.swap(out);
  }
  if (engine && !engine->setIR(mono.data(), (int)mono.size())) return false;
  irPath = path;
  stateVersion++;
  return true;
}

bool PedalboardProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
  const auto in = layouts.getMainInputChannelSet(), out = layouts.getMainOutputChannelSet();
  const bool inOk = in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo();
  const bool outOk = out == juce::AudioChannelSet::mono() || out == juce::AudioChannelSet::stereo();
  return inOk && outOk;
}

void PedalboardProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) {
  juce::ScopedNoDenormals noDenormals;
  const int n = buffer.getNumSamples();
  const auto t0 = juce::Time::getHighResolutionTicks();
  if (!engine || n == 0) { buffer.clear(); return; }

  // parameters that moved since the last block
  for (int i = 0; i < NUM_PARAMS; i++) {
    const float v = raw[(size_t)i]->load(std::memory_order_relaxed);
    if (!(v == pushed[(size_t)i])) { engine->setParam(i, v); pushed[(size_t)i] = v; }
  }
  // the track is in digital full scale: the engine turns it into volts with the interface reference; the demo is in volts
  engine->external = sourceKind.load(std::memory_order_relaxed) == 0;
  if (fresh) { engine->snap(); fresh = false; }
  engine->muted = tunerMute.load(std::memory_order_relaxed);

  const int kind = sourceKind.load(std::memory_order_relaxed), pattern = demoPattern.load(std::memory_order_relaxed);
  if (kind != lastKind) { engine->reset(); lastKind = kind; }
  if (pattern != lastPattern) { demo->setPattern(pattern); lastPattern = pattern; }
  const int ch = inputChannel.load(std::memory_order_relaxed);

  const int inChans = getTotalNumInputChannels();
  const float* inL = inChans > 0 ? buffer.getReadPointer(0) : nullptr;
  const float* inR = inChans > 1 ? buffer.getReadPointer(1) : inL;
  float* L = buffer.getWritePointer(0);
  float* R = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1) : nullptr;
  float mono[MAX_BLOCK], outR[MAX_BLOCK];
  for (int off = 0; off < n; off += MAX_BLOCK) {
    const int m = std::min(MAX_BLOCK, n - off);
    // the input first: the output buffer is the same memory
    if (kind == 1) demo->process(mono, m);
    else if (!inL) std::fill(mono, mono + m, 0.f);
    else if (ch == 0) std::copy(inL + off, inL + off + m, mono);
    else if (ch == 1) std::copy(inR + off, inR + off + m, mono);
    else {
      // both: averaging would lose 6 dB when only one side carries the guitar, so each side
      // is weighted by its share of the power (a slow envelope); two identical sides stay as they are
      double sa = 0, sb = 0;
      for (int k = 0; k < m; k++) { sa += (double)inL[off + k] * inL[off + k]; sb += (double)inR[off + k] * inR[off + k]; }
      const double a = 1 - std::exp(-m / (0.1 * sampleRate));
      powL += (sa / m - powL) * a; powR += (sb / m - powR) * a;
      const double tot = powL + powR, w1 = tot > 1e-12 ? powL / tot : 0.5, w0 = wL;
      for (int k = 0; k < m; k++) { const double w = w0 + (w1 - w0) * (k + 1) / m; mono[k] = (float)(inL[off + k] * w + inR[off + k] * (1 - w)); }
      wL = w1;
    }
    engine->process(mono, L + off, R ? R + off : outR, m);
    if (!R) for (int k = 0; k < m; k++) L[off + k] = 0.5f * (L[off + k] + outR[k]);
  }
  for (int c = 2; c < buffer.getNumChannels(); c++) buffer.clear(c, 0, n);

  // meters for the UI: peaks held until the editor reads them
  const double took = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - t0);
  const juce::SpinLock::ScopedTryLockType lock(meterLock);
  if (lock.isLocked()) {
    Meters& mt = meters;
    mt.load = 0.9f * mt.load + 0.1f * (float)(took / (n / sampleRate));
    mt.peakIn = std::max(mt.peakIn, (float)engine->peakIn);
    mt.peakRaw = std::max(mt.peakRaw, (float)engine->peakRaw);
    mt.peakL = std::max(mt.peakL, (float)engine->peakL);
    mt.peakR = std::max(mt.peakR, (float)engine->peakR);
    mt.tunerHz = (float)engine->tuner.freq; mt.tunerClarity = (float)engine->tuner.clarity;
    for (int s = 0; s < NSLOTS; s++) {
      mt.slotPeak[s] = std::max(mt.slotPeak[s], engine->slotPeak[s]);
      mt.slotHeat[s] = engine->slotHeat[s];
      mt.slotLive[s] = engine->slotLive[s];
    }
    std::copy(std::begin(engine->stageHeat), std::end(engine->stageHeat), mt.stageHeat);
  }
}

PedalboardProcessor::Meters PedalboardProcessor::takeMeters() {
  const juce::SpinLock::ScopedLockType lock(meterLock);
  Meters out = meters;
  meters.peakIn = meters.peakRaw = meters.peakL = meters.peakR = 0;
  std::fill(std::begin(meters.slotPeak), std::end(meters.slotPeak), 0.f);
  return out;
}

// ---- UI traffic ------------------------------------------------------------

void PedalboardProcessor::setParamFromUi(int i, double value) {
  auto* p = params[(size_t)i];
  const float norm = p->convertTo0to1((float)value);
  if (std::abs(norm - p->getValue()) < 1e-7f) return;
  p->beginChangeGesture();
  p->setValueNotifyingHost(norm);
  p->endChangeGesture();
}

void PedalboardProcessor::loadValues(const std::array<double, NUM_PARAMS>& values, const juce::String& name) {
  for (int i = 0; i < NUM_PARAMS; i++) if (!notInRig(i)) setParamFromUi(i, values[(size_t)i]);
  setPresetName(name);
}

void PedalboardProcessor::setPresetName(const juce::String& name) {
  const juce::ScopedLock l(nameLock);
  current = name;
}

// ---- programs --------------------------------------------------------------

void PedalboardProcessor::loadFactory(int index) {
  if (index < 0 || index >= NUM_PRESETS) return;
  std::array<double, NUM_PARAMS> v {};
  for (int i = 0; i < NUM_PARAMS; i++) v[(size_t)i] = PARAMS[i].def;
  const Preset& pr = PRESETS[index];
  for (int k = 0; k < pr.count; k++) v[(size_t)pr.values[k].id] = pr.values[k].value;
  for (int i = 0; i < NUM_PARAMS; i++) {
    if (notInRig(i)) continue;
    params[(size_t)i]->setValueNotifyingHost(params[(size_t)i]->convertTo0to1((float)v[(size_t)i]));
  }
  currentProgram = index;
  setPresetName(utf8(pr.name));
}

void PedalboardProcessor::setCurrentProgram(int index) {
  if (index < 0 || index >= NUM_PRESETS) return;
  loadFactory(index);
  stateVersion++;
}

const juce::String PedalboardProcessor::getProgramName(int index) {
  return index >= 0 && index < NUM_PRESETS ? utf8(PRESETS[index].name) : juce::String();
}

// ---- state -----------------------------------------------------------------

void PedalboardProcessor::getStateInformation(juce::MemoryBlock& destData) {
  auto state = apvts.copyState();
  state.setProperty("preset", presetName(), nullptr);
  state.setProperty("program", currentProgram, nullptr);
  state.setProperty("source", sourceKind.load(), nullptr);
  state.setProperty("pattern", demoPattern.load(), nullptr);
  state.setProperty("channel", inputChannel.load(), nullptr);
  state.setProperty("editorW", editorW.load(), nullptr);
  state.setProperty("editorH", editorH.load(), nullptr);
  state.setProperty("irPath", irPath, nullptr);
  state.setProperty("namPath", namPath, nullptr);
  if (auto xml = state.createXml()) copyXmlToBinary(*xml, destData);
}

void PedalboardProcessor::setStateInformation(const void* data, int sizeInBytes) {
  auto xml = getXmlFromBinary(data, sizeInBytes);
  if (!xml || !xml->hasTagName(apvts.state.getType())) return;
  auto state = juce::ValueTree::fromXml(*xml);
  apvts.replaceState(state);
  setPresetName(state.getProperty("preset").toString());
  currentProgram = state.getProperty("program", 0);
  sourceKind = juce::jlimit(0, 1, (int)state.getProperty("source", 0));
  demoPattern = juce::jlimit(0, 2, (int)state.getProperty("pattern", 0));
  inputChannel = juce::jlimit(0, 2, (int)state.getProperty("channel", 0));
  editorW = (int)state.getProperty("editorW", 0);
  editorH = (int)state.getProperty("editorH", 0);
  irPath = state.getProperty("irPath").toString();
  if (engine) loadIR(irPath);
  namPath = state.getProperty("namPath").toString();
  if (engine) loadNAM(namPath);
  stateVersion++;
}

juce::File PedalboardProcessor::userRigFile() {
#if JUCE_MAC
  auto dir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("Application Support");
#else
  auto dir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#endif
  return dir.getChildFile("FT").getChildFile("Pedalboard").getChildFile("user-rigs.json");
}

juce::AudioProcessorEditor* PedalboardProcessor::createEditor() { return new PedalboardEditor(*this); }

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new PedalboardProcessor(); }
