// The plugin: the guitar in (or the demo guitar), host parameters in, the
// rack's stereo out. The editor (a WebView running the web UI) talks to it
// through a few atomics and a try-locked copy of the meters; nothing here
// blocks the audio thread.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <atomic>
#include <memory>
#include "dsp/Engine.h"
#include "dsp/Demo.h"

class PedalboardProcessor final : public juce::AudioProcessor {
public:
  PedalboardProcessor();
  ~PedalboardProcessor() override = default;

  void prepareToPlay(double sampleRate, int samplesPerBlock) override;
  void releaseResources() override {}
  bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
  void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
  using AudioProcessor::processBlock;

  juce::AudioProcessorEditor* createEditor() override;
  bool hasEditor() const override { return true; }

  const juce::String getName() const override { return JucePlugin_Name; }
  bool acceptsMidi() const override { return false; }
  bool producesMidi() const override { return false; }
  bool isMidiEffect() const override { return false; }
  double getTailLengthSeconds() const override { return 10.0; }

  // the factory rigs, so the host's preset menu lists them
  int getNumPrograms() override { return pedalboard::NUM_PRESETS; }
  int getCurrentProgram() override { return currentProgram; }
  void setCurrentProgram(int index) override;
  const juce::String getProgramName(int index) override;
  void changeProgramName(int, const juce::String&) override {}

  void getStateInformation(juce::MemoryBlock& destData) override;
  void setStateInformation(const void* data, int sizeInBytes) override;

  // ---- for the editor (message thread) ------------------------------------

  float paramValue(int i) const { return raw[(size_t)i]->load(); }
  /** Set a parameter as if a person moved it (one gesture). */
  void setParamFromUi(int i, double value);
  /** Load a whole rig: every parameter but the volume, missing ones to their default. */
  void loadValues(const std::array<double, pedalboard::NUM_PARAMS>& values, const juce::String& name);

  juce::String presetName() const { const juce::ScopedLock l(nameLock); return current; }
  void setPresetName(const juce::String& name);

  /** What plays into the rack: 0 the input (the guitar), 1 the demo guitar; and its loop. */
  std::atomic<int> sourceKind { 0 }, demoPattern { 0 };
  /** Which input the guitar is on: 0 left / 1, 1 right / 2, 2 both. */
  std::atomic<int> inputChannel { 0 };
  /** Mute the output while tuning. */
  std::atomic<bool> tunerMute { false };

  /** Bumped whenever the whole state changes under the UI (session load, program change). */
  std::atomic<int> stateVersion { 0 };
  /** The editor's size once someone has resized it (0 = the default), kept with the session. */
  std::atomic<int> editorW { 0 }, editorH { 0 };

  struct Meters {
    float load = 0, peakIn = 0, peakL = 0, peakR = 0, tunerHz = 0, tunerClarity = 0;
    float slotPeak[pedalboard::NSLOTS] {}, slotHeat[pedalboard::NSLOTS] {}, slotLive[pedalboard::NSLOTS] {};
    float stageHeat[pedalboard::NSLOTS * pedalboard::STAGE_STRIDE] {};
  };
  /** The meters since the last call (peaks are held until read). */
  Meters takeMeters();

  static juce::File userRigFile();

private:
  void loadFactory(int index);

  std::unique_ptr<pedalboard::Engine> engine;
  std::unique_ptr<pedalboard::DemoGuitar> demo;
  juce::AudioProcessorValueTreeState apvts;
  std::array<juce::RangedAudioParameter*, pedalboard::NUM_PARAMS> params {};
  std::array<std::atomic<float>*, pedalboard::NUM_PARAMS> raw {};
  std::array<float, pedalboard::NUM_PARAMS> pushed {};   // last value given to the engine
  int currentProgram = 0;
  bool fresh = true;     // the first block after prepare starts without fades
  int lastKind = 0, lastPattern = 0;

  juce::CriticalSection nameLock;
  juce::String current;

  juce::SpinLock meterLock;
  Meters meters;
  double sampleRate = 48000;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PedalboardProcessor)
};
