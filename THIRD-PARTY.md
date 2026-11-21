# Third-party software

PEDALBOARD is licensed under the [AGPL v3](LICENSE). What it includes or builds on:

| Component | Used for | License |
|---|---|---|
| [JUCE](https://juce.com) 8 | the plugin shell (VST3, AU, standalone, WebView), fetched by CMake at build time, not copied into this repo | AGPLv3 (or commercial; this project uses the AGPL option) |
| VST3 SDK (3.7.x) | bundled inside JUCE | Steinberg VST3 License or GPLv3 (this project uses the GPLv3 option, which is compatible with the AGPLv3) |
| [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore) (commit `d3189ed`) | the NAM capture unit (plugin only); fetched by CMake at build time, compiled into the plugin, not copied into this repo | MIT, (c) 2023 Steven Atkinson |
| [Eigen](https://eigen.tuxfamily.org) 3.5 | linear algebra for the NAM core (a submodule of it); built with `EIGEN_MPL2_ONLY`, so none of its LGPL-only parts are included | MPL 2.0; its source is at the commit above under `Dependencies/eigen` |
| [nlohmann/json](https://github.com/nlohmann/json) 3.12 | model-file parsing for the NAM core (a submodule of it) | MIT, (c) Niels Lohmann |
| [Tektur](https://github.com/hyvyys/Tektur) | display font, `src/fonts/` (Latin subset) | SIL OFL 1.1, [`src/fonts/OFL-tektur.txt`](src/fonts/OFL-tektur.txt) |
| [Geist](https://github.com/vercel/geist-font) | UI font, `src/fonts/` (Latin subset) | SIL OFL 1.1, [`src/fonts/OFL-geist.txt`](src/fonts/OFL-geist.txt) |
| [Geist Mono](https://github.com/vercel/geist-font) | monospace font, `src/fonts/` (Latin subset) | SIL OFL 1.1, [`src/fonts/OFL-geist-mono.txt`](src/fonts/OFL-geist-mono.txt) |
| [Noto Sans Symbols](https://github.com/notofonts/symbols) 1 and 2 | arrows and key/geometric symbols, subset into `src/fonts/ft-symbols.woff2` | SIL OFL 1.1, [`src/fonts/OFL-noto-symbols.txt`](src/fonts/OFL-noto-symbols.txt) |

Build-time only (nothing of it ships): Vite, TypeScript and `@types/node`, plus
their dependencies, all MIT, ISC, BSD or Apache-2.0.

The NAM core's licence text, which its MIT terms ask to travel with
binaries:

> MIT License. Copyright (c) 2023 Steven Atkinson. Permission is hereby
> granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy,
> modify, merge, publish, distribute, sublicense, and/or sell copies of the
> Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions: The above copyright notice and this
> permission notice shall be included in all copies or substantial portions of
> the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
> EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
> MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
> EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
> ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.

The release zips include this file and the LICENSE. There are no samples or impulse responses (NAM models and cabinet IRs are loaded by the user): the cabinets are filters, and the demo guitar is synthesized.
