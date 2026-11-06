# PEDALBOARD as a plugin: VST3, AU (macOS) and a standalone app.
# The DSP is the C++ port in Source/dsp; the UI is the web UI (../dist)
# embedded into the binary and shown in a WebView.
#
#   ./build.sh            builds the web UI, then the plugins, and installs them
#
# or by hand:
#   npm run build   (in the repo root; the UI must exist before configuring)
#   cmake -S plugin -B plugin/build -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build plugin/build

cmake_minimum_required(VERSION 3.22)
project(Pedalboard VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")

include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.15
  GIT_SHALLOW TRUE
  # let the Linux WebView use the GPU (see patch-juce.cmake)
  PATCH_COMMAND ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_SOURCE_DIR}/patch-juce.cmake)
FetchContent_MakeAvailable(JUCE)

# Copy the built plugins into the user's plugin folders (off in CI).
option(PEDALBOARD_INSTALL "Install the plugins after building" ON)

set(PEDALBOARD_FORMATS VST3 Standalone)
if(APPLE)
  list(APPEND PEDALBOARD_FORMATS AU)
endif()

juce_add_plugin(Pedalboard
  COMPANY_NAME "FT"
  BUNDLE_ID "com.ft.pedalboard"
  PLUGIN_MANUFACTURER_CODE Ftft
  PLUGIN_CODE Pdbd
  PRODUCT_NAME "Pedalboard"
  DESCRIPTION "guitar rack: amps, drives, modulation, echo, reverb"
  FORMATS ${PEDALBOARD_FORMATS}
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  NEEDS_MIDI_OUTPUT FALSE
  IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS TRUE
  NEEDS_WEB_BROWSER TRUE
  VST3_CATEGORIES Fx Distortion
  AU_MAIN_TYPE kAudioUnitType_Effect
  NEEDS_WEBVIEW2 TRUE
  COPY_PLUGIN_AFTER_BUILD ${PEDALBOARD_INSTALL})

target_sources(Pedalboard PRIVATE
  Source/PluginProcessor.cpp
  Source/PluginEditor.cpp)

target_include_directories(Pedalboard PRIVATE Source)

target_compile_definitions(Pedalboard PUBLIC
  JUCE_WEB_BROWSER=1
  JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0)

# The built web UI, embedded. Rebuild it (npm run build) and re-run the build
# after changing anything under src/.
set(PEDALBOARD_UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../dist")
if(NOT EXISTS "${PEDALBOARD_UI_DIR}/index.html")
  message(FATAL_ERROR "No web UI in ${PEDALBOARD_UI_DIR}: run `npm run build` in the repo root first (or use plugin/build.sh).")
endif()
file(GLOB_RECURSE PEDALBOARD_UI_FILES CONFIGURE_DEPENDS "${PEDALBOARD_UI_DIR}/*")
juce_add_binary_data(PedalboardUI SOURCES ${PEDALBOARD_UI_FILES})

target_link_libraries(Pedalboard
  PRIVATE
    PedalboardUI
    juce::juce_audio_utils
    juce::juce_gui_extra
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags)
