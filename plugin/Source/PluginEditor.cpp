#include "PluginEditor.h"
#include "BinaryData.h"

using namespace pedalboard;

namespace {

const char* mimeFor(const juce::String& file) {
  const auto ext = file.fromLastOccurrenceOf(".", false, false).toLowerCase();
  if (ext == "html") return "text/html; charset=utf-8";
  if (ext == "js") return "text/javascript; charset=utf-8";
  if (ext == "css") return "text/css; charset=utf-8";
  if (ext == "svg") return "image/svg+xml";
  if (ext == "png") return "image/png";
  if (ext == "json") return "application/json; charset=utf-8";
  if (ext == "woff2") return "font/woff2";
  if (ext == "woff") return "font/woff";
  return "application/octet-stream";
}

// Linux: on NVIDIA, WebKit cannot share GPU buffers with the window and shows
// nothing; handing frames over in shared memory works everywhere.
void webkitEnv() {
 #if JUCE_LINUX
  setenv("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1", 0);
 #endif
}

juce::var valuesObject(const std::array<float, NUM_PARAMS>& v) {
  auto* o = new juce::DynamicObject();
  for (int i = 0; i < NUM_PARAMS; i++) o->setProperty(PARAMS[i].id, v[(size_t)i]);
  return juce::var(o);
}

template <size_t N>
juce::var floats(const float (&a)[N]) {
  juce::Array<juce::var> out;
  out.ensureStorageAllocated((int)N);
  for (float x : a) out.add(std::round(x * 1e5) / 1e5);
  return out;
}

} // namespace

PedalboardEditor::PedalboardEditor(PedalboardProcessor& p)
  : AudioProcessorEditor(p), proc(p),
    web((webkitEnv(), juce::WebBrowserComponent::Options {})
          .withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
          .withNativeIntegrationEnabled()
          .withKeepPageLoadedWhenBrowserIsHidden()
          .withResourceProvider([this](const juce::String& url) { return resource(url); })
          .withEventListener("pedalboard", [this](const juce::var& msg) { onMessage(msg); })) {
  for (int i = 0; i < NUM_PARAMS; i++) ids[PARAMS[i].id] = i;
  addAndMakeVisible(web);
  setResizable(true, true);
  setResizeLimits(720, 520, 2600, 1800);
  if (proc.editorW > 0 && proc.editorH > 0) setSize(proc.editorW, proc.editorH);
  else {
    double s = 1;
    if (auto* d = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay())
      s = std::min({ 1.0, d->userBounds.getWidth() * 0.9 / UI_W, d->userBounds.getHeight() * 0.85 / UI_H });
    setSize(juce::roundToInt(UI_W * s), juce::roundToInt(UI_H * s));
  }
  sized = true;
  web.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
  startTimerHz(30);
}

void PedalboardEditor::paint(juce::Graphics& g) { g.fillAll(juce::Colour(0xff0a0806)); }

void PedalboardEditor::resized() {
  web.setBounds(getLocalBounds());
  if (sized) { proc.editorW = getWidth(); proc.editorH = getHeight(); }
}

std::optional<juce::WebBrowserComponent::Resource> PedalboardEditor::resource(const juce::String& url) {
  // BinaryData keeps only file names, and the built UI has no two files with the same name
  auto path = url.upToFirstOccurrenceOf("?", false, false);
  if (path.isEmpty() || path == "/") path = "index.html";
  const auto file = path.fromLastOccurrenceOf("/", false, false);
  for (int i = 0; i < BinaryData::namedResourceListSize; i++) {
    if (file != BinaryData::originalFilenames[i]) continue;
    int size = 0;
    const char* data = BinaryData::getNamedResource(BinaryData::namedResourceList[i], size);
    if (!data) break;
    std::vector<std::byte> bytes((size_t)size);
    std::memcpy(bytes.data(), data, (size_t)size);
    return juce::WebBrowserComponent::Resource { std::move(bytes), mimeFor(file) };
  }
  return std::nullopt;
}

void PedalboardEditor::send(juce::DynamicObject::Ptr obj) {
  web.emitEventIfBrowserIsVisible("pedalboard", juce::var(obj.get()));
}

void PedalboardEditor::sendIR() {
  juce::DynamicObject::Ptr o = new juce::DynamicObject();
  o->setProperty("type", "ir");
  o->setProperty("name", proc.irName());
  send(o);
}

void PedalboardEditor::sendNAM() {
  juce::DynamicObject::Ptr o = new juce::DynamicObject();
  o->setProperty("type", "nam");
  o->setProperty("name", proc.namName());
  o->setProperty("error", proc.namError);
  send(o);
}

void PedalboardEditor::sendState() {
  for (int i = 0; i < NUM_PARAMS; i++) shown[(size_t)i] = proc.paramValue(i);
  juce::DynamicObject::Ptr o = new juce::DynamicObject();
  o->setProperty("type", "state");
  o->setProperty("values", valuesObject(shown));
  o->setProperty("preset", proc.presetName());
  const int kind = proc.sourceKind.load();
  o->setProperty("source", kind == 1 ? "demo:" + juce::String(proc.demoPattern.load()) : juce::String("live"));
  o->setProperty("channel", proc.inputChannel.load());
  o->setProperty("muted", proc.tunerMute.load());
  const auto file = PedalboardProcessor::userRigFile();
  o->setProperty("user", file.existsAsFile() ? juce::JSON::parse(file) : juce::var(juce::Array<juce::var>()));
  send(o);
  sendIR();
  sendNAM();
  seenState = proc.stateVersion.load();
}

void PedalboardEditor::onMessage(const juce::var& msg) {
  const auto type = msg["type"].toString();
  auto idOf = [this](const juce::var& v) {
    const auto it = ids.find(v.toString().toStdString());
    return it == ids.end() ? -1 : it->second;
  };
  if (type == "ready") {
    ready = true;
    sendState();
  } else if (type == "param") {
    const int i = idOf(msg["id"]);
    if (i < 0) return;
    proc.setParamFromUi(i, (double)msg["value"]);
    shown[(size_t)i] = proc.paramValue(i);   // the page already shows it
  } else if (type == "params" || type == "rig") {
    // "params": a rearranged rack (only what changed); "rig": a whole rig, the rest to defaults
    const bool whole = type == "rig";
    std::array<double, NUM_PARAMS> v {};
    for (int i = 0; i < NUM_PARAMS; i++) v[(size_t)i] = whole ? PARAMS[i].def : proc.paramValue(i);
    if (auto* obj = msg["values"].getDynamicObject())
      for (auto& prop : obj->getProperties()) {
        const int i = idOf(prop.name.toString());
        if (i >= 0) v[(size_t)i] = (double)prop.value;
      }
    if (whole) proc.loadValues(v, msg["name"].toString());
    else for (int i = 0; i < NUM_PARAMS; i++) proc.setParamFromUi(i, v[(size_t)i]);
    for (int i = 0; i < NUM_PARAMS; i++) shown[(size_t)i] = proc.paramValue(i);
  } else if (type == "current") {
    proc.setPresetName(msg["name"].toString());
  } else if (type == "source") {
    proc.sourceKind = (int)msg["kind"] == 0 ? 0 : 1;
    proc.demoPattern = juce::jlimit(0, 2, (int)msg["pattern"]);
  } else if (type == "channel") {
    proc.inputChannel = juce::jlimit(0, 2, (int)msg["value"]);
  } else if (type == "mute") {
    proc.tunerMute = (bool)msg["value"];
  } else if (type == "pickIR") {
    chooser = std::make_unique<juce::FileChooser>("Choose a cabinet impulse response", juce::File(), "*.wav;*.aif;*.aiff;*.flac");
    juce::Component::SafePointer<PedalboardEditor> self(this);
    chooser->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles, [self](const juce::FileChooser& fc) {
      if (self == nullptr) return;
      const auto f = fc.getResult();
      if (f != juce::File()) self->proc.loadIR(f.getFullPathName());
      self->sendIR();
    });
  } else if (type == "pickNAM") {
    chooser = std::make_unique<juce::FileChooser>("Choose a NAM capture", juce::File(), "*.nam");
    juce::Component::SafePointer<PedalboardEditor> self(this);
    chooser->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles, [self](const juce::FileChooser& fc) {
      if (self == nullptr) return;
      const auto f = fc.getResult();
      if (f != juce::File()) self->proc.loadNAM(f.getFullPathName());
      self->sendNAM();
    });
  } else if (type == "saveUser") {
    const auto file = PedalboardProcessor::userRigFile();
    file.getParentDirectory().createDirectory();
    file.replaceWithText(juce::JSON::toString(msg["rigs"]));
  }
}

void PedalboardEditor::timerCallback() {
  if (!ready) return;
  // the whole rig changed under the page (session load, the host's preset menu)
  if (proc.stateVersion.load() != seenState) { sendState(); return; }

  // parameters the host moved (automation, its generic editor)
  juce::DynamicObject::Ptr changed;
  for (int i = 0; i < NUM_PARAMS; i++) {
    const float v = proc.paramValue(i);
    if (v == shown[(size_t)i]) continue;
    shown[(size_t)i] = v;
    if (!changed) changed = new juce::DynamicObject();
    changed->setProperty(PARAMS[i].id, v);
  }
  if (changed) {
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty("type", "params");
    o->setProperty("values", juce::var(changed.get()));
    send(o);
  }

  // meters, the tuner and the tubes
  const auto m = proc.takeMeters();
  juce::DynamicObject::Ptr o = new juce::DynamicObject();
  o->setProperty("type", "stats");
  o->setProperty("load", m.load);
  o->setProperty("peakIn", m.peakIn);
  o->setProperty("peakRaw", m.peakRaw);
  o->setProperty("peakL", m.peakL);
  o->setProperty("peakR", m.peakR);
  o->setProperty("tunerHz", m.tunerHz);
  o->setProperty("tunerClarity", m.tunerClarity);
  o->setProperty("slotPeak", floats(m.slotPeak));
  o->setProperty("slotHeat", floats(m.slotHeat));
  o->setProperty("slotLive", floats(m.slotLive));
  o->setProperty("stageHeat", floats(m.stageHeat));
  send(o);
}
