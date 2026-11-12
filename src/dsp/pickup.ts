// The guitar the DSP assumes, shared by every unit that loads the pickup
// (fuzz, muff, treble booster, wah) and by the guitar-tone unit: a Strat-type
// single coil (6.5k, 2.6 H, 120 pF of its own) on a cable of 600 pF, recorded
// as a DI into ~1M (the interface) with the coil's eddy-current loss across
// it. A DI therefore already holds the coil-and-cable resonance (~3.7 kHz).

export const PICKUP_R = 6.5e3, PICKUP_L = 2.6;
/** The coil's own capacitance and the cable's; together what the DI saw. */
export const PICKUP_CP = 120e-12, CABLE_C = 600e-12, PICKUP_C = PICKUP_CP + CABLE_C;
/** The coil's eddy-current loss (a resistance across it) and the interface's input. */
export const PICKUP_EDDY = 150e3, DI_LOAD = 1e6;
