// The tubes, as tables built once from circuit equations (no allocation
// after that, and nothing to solve per sample).
//
// Preamp stage: a 12AX7 common-cathode stage on its load line. The triode
// is the Dempwolf-Zolzer model (DAFx-11, "A physically-motivated triode
// model for circuit simulations"; parameters fitted to an RSD 12AX7):
//
//   Ik = G (ln(1 + e^(C (Vpk/mu + Vgk))) / C)^gamma
//   Ig = Gg (ln(1 + e^(Cg Vgk)) / Cg)^xi + Ig0,   Ip = Ik - Ig
//
// solved against the plate resistor, the cathode resistor (bypassed: the
// cathode sits at its bias voltage; unbypassed: it rides on the current)
// and the grid current through the source resistance. What comes out is
// the stage's plate swing and grid current for a voltage at the grid node:
// lopsided as a real stage is (the gain rises towards grid conduction and
// falls towards cutoff, so a clean stage makes mostly second harmonic),
// a firm knee where the grid conducts and a soft one at cutoff.
//
// Power stage: the phase inverter (a soft symmetric limit), two output
// tubes in push-pull (3/2-power law above a soft cutoff, the grid limited
// where it conducts, the plate knee where the load line runs out of
// supply) or one tube in single-ended class A, and the global negative
// feedback solved around all of it. Push-pull cancels the even harmonics
// (a little imbalance leaves some); feedback keeps it clean up to a
// fairly firm ceiling; without feedback it bends early and gradually.

export interface StageKind { vb: number; rp: number; rk: number; bypassed: boolean; rs: number; /** amplification factor and perveance (G): a 12AX7's unless given */ mu?: number; g?: number }

/**
 * The preamp stages the amps are built from (index = kind). "bypassed" means
 * the table is solved with the cathode held at its idle voltage; the amp then
 * moves the cathode with its own state (Rk against the real bypass cap Ck),
 * so a partly bypassed stage has its real bass shelf and its memory of the
 * bias. Unbypassed tables solve the cathode riding on the current. `rs` is
 * what limits the grid current: the stopper plus what drives it.
 */
export const STAGE_KINDS: StageKind[] = [
  // 0: 100k plate, 1.5k cathode (gain ~60 bypassed): Fender, Vox second stages, most "hot" stages
  { vb: 300, rp: 100e3, rk: 1.5e3, bypassed: true, rs: 68e3 },
  // 1: the same, unbypassed: gain ~33 (ampbooks: Bassman V2 32 dB, AC30 second stage 30 dB)
  { vb: 300, rp: 100e3, rk: 1.5e3, bypassed: false, rs: 68e3 },
  // 2: 100k / 2.7k (the Marshall input stage, partly bypassed by 0.68 uF)
  { vb: 300, rp: 100e3, rk: 2.7e3, bypassed: true, rs: 68e3 },
  // 3: the JCM800 cold clipper: 10k unbypassed (Robinette): ~19 dB, idles near cutoff and clips the negative lobe first
  { vb: 300, rp: 100e3, rk: 10e3, bypassed: false, rs: 100e3 },
  // 4: the Soldano SLO's colder stage: 39k unbypassed (ampbooks: 7.7 dB unloaded), behind a 220k stopper
  { vb: 300, rp: 100e3, rk: 39e3, bypassed: false, rs: 220e3 },
  // 5: 220k plate / 1.8k (SLO stages 1 and 4; ampbooks 37.8 dB bypassed)
  { vb: 300, rp: 220e3, rk: 1.8e3, bypassed: true, rs: 68e3 },
  // 6: 100k / 1.8k (SLO stage 2)
  { vb: 300, rp: 100e3, rk: 1.8e3, bypassed: true, rs: 68e3 },
  // 7: 220k / 1.8k behind a 470k grid stopper (SLO stage 4, "the first stage to overdrive")
  { vb: 300, rp: 220e3, rk: 1.8e3, bypassed: true, rs: 470e3 },
  // 8: 100k / 820 (Marshall V2a, partly bypassed by 0.68 uF; ampbooks JMP50)
  { vb: 300, rp: 100e3, rk: 820, bypassed: true, rs: 68e3 },
  // 9: 220k / 1.5k (the AC30's first stage, 25 uF: ampbooks 37.8 dB unloaded)
  { vb: 300, rp: 220e3, rk: 1.5e3, bypassed: true, rs: 68e3 },
  // 10: a 12AY7 on 100k / 1.5k bypassed (the 5E3's first stage, ampbooks): mu 44, G from the datasheet's 3 mA at
  // 250 V and -4 V [inference: the Dempwolf-Zolzer fit is for a 12AX7; only mu and G are changed]
  { vb: 300, rp: 100e3, rk: 1.5e3, bypassed: true, rs: 68e3, mu: 44, g: 1.56e-3 },
];
export const NKINDS = STAGE_KINDS.length;

// Dempwolf-Zolzer 12AX7, "RSD-1"
export const TMU = 103.2;
const TG = 2.242e-3, TC = 3.40, TGAMMA = 1.26, TGG = 6.177e-4, TCG = 9.901, TXI = 1.314, TIG0 = 8.025e-8;

function softplus(x: number, c: number): number { const t = c * x; return t > 40 ? x : Math.log(1 + Math.exp(t)) / c; }
function cathodeCurrent(vpk: number, vgk: number, mu = TMU, g = TG): number { return g * Math.pow(softplus(vpk / mu + vgk, TC), TGAMMA); }
function gridCurrent(vgk: number): number { return TGG * Math.pow(softplus(vgk, TCG), TXI) + TIG0; }

/**
 * Root of r(i) = i - F(i) for a current i, where F falls as i rises (more
 * current, less plate voltage), so r' >= 1 and Newton is safe. A fixed
 * number of steps from a warm start, so both engines do the same work.
 */
function newton(r: (x: number) => number, x: number): number {
  for (let k = 0; k < 8; k++) { const f = r(x); x -= f * 1e-10 / (r(x + 1e-10) - f); }
  return x;
}

/** The grid node's range in the table, volts. Below it the stage is cut off; above it the grid is clamped. */
export const TUBE_LO = -16, TUBE_HI = 64, TUBE_N = 8192;
export const TUBE_INV = (TUBE_N - 1) / (TUBE_HI - TUBE_LO);
const SWEEP = 8192;

/**
 * The antiderivative of a table's linearly interpolated curve (y on the grid
 * lo + j / inv), zero at x = 0 (the idle point, so it stays small where the
 * signal lives and the differences ADAA takes are exact there).
 */
export function antiderivative(y: Float64Array, lo: number, inv: number, hiSlope: number): Float64Array {
  const N = y.length, F = new Float64Array(N);
  for (let j = 1; j < N; j++) F[j] = F[j - 1] + 0.5 * (y[j - 1] + y[j]) / inv;
  const F0 = tableInt(y, F, lo, inv, 0, hiSlope);
  for (let j = 0; j < N; j++) F[j] -= F0;
  return F;
}
/** The curve at x: flat below the table, rising at `hiSlope` above it. */
export function tableAt(y: Float64Array, lo: number, inv: number, x: number, hiSlope: number): number {
  const N = y.length, p = (x - lo) * inv;
  if (p <= 0) return y[0];
  if (p >= N - 1) return y[N - 1] + (x - lo - (N - 1) / inv) * hiSlope;
  const j = p | 0, f = p - j;
  return y[j] + f * (y[j + 1] - y[j]);
}
/** Its antiderivative at x. */
export function tableInt(y: Float64Array, F: Float64Array, lo: number, inv: number, x: number, hiSlope: number): number {
  const N = y.length, p = (x - lo) * inv;
  if (p <= 0) return F[0] + y[0] * (x - lo);
  if (p >= N - 1) { const d = x - lo - (N - 1) / inv; return F[N - 1] + d * (y[N - 1] + 0.5 * hiSlope * d); }
  const j = p | 0, f = p - j;
  return F[j] + (y[j] + 0.5 * (y[j + 1] - y[j]) * f) * f / inv;
}
/** Below this step (volts) first-order ADAA takes the curve at the midpoint instead of the difference quotient. */
export const ADAA_EPS = 1e-6;

export class StageTable {
  /** Plate swing (volts, from the idle point) and grid current (amps, from idle) at node volts TUBE_LO + i / TUBE_INV. */
  readonly vp = new Float64Array(TUBE_N);
  readonly ig = new Float64Array(TUBE_N);
  /** Source resistance seen by the grid current, for running off the top of the table. */
  readonly rs: number;
  /** Node volts at which the grid starts to conduct (the stage's headroom upwards). */
  knee = 1;
  /** Small-signal gain (negative: the stage inverts). */
  gain = 0;
  /** The triode's amplification factor. */
  mu = TMU;
  /** The antiderivatives of vp and ig, for antiderivative antialiasing (amp.ts). */
  readonly Fvp: Float64Array; readonly Fig: Float64Array;

  constructor(k: StageKind) {
    this.rs = k.rs;
    const { vb, rp, rk, rs } = k;
    // the idle point: grid at 0 V through the grid leak, cathode on its resistor
    const mu = k.mu ?? TMU, G = k.g ?? TG;
    this.mu = mu;
    const ik0 = newton((i) => i - cathodeCurrent(vb - (rp + rk) * i, -rk * i, mu, G), 1e-3);
    const vk0 = rk * ik0;
    const vn = new Float64Array(SWEEP), vpa = new Float64Array(SWEEP), iga = new Float64Array(SWEEP);
    let knee = 0, cur = 0;
    for (let s = 0; s < SWEEP; s++) {
      const vgk = -30 + 33.5 * s / (SWEEP - 1);
      const ig = gridCurrent(vgk);
      let ip: number, vk: number;
      if (k.bypassed) {
        vk = vk0;
        ip = cur = newton((i) => i - (cathodeCurrent(vb - rp * i - vk0, vgk, mu, G) - ig), cur);
      } else {
        const ik = cur = newton((i) => i - cathodeCurrent(vb - rp * (i - ig) - rk * i, vgk, mu, G), cur);
        ip = ik - ig; vk = rk * ik;
      }
      vn[s] = vgk + vk + rs * ig;
      vpa[s] = vb - rp * ip;
      iga[s] = ig;
      if (vgk <= 0) knee = vn[s];
    }
    this.knee = knee;
    // resample onto the uniform node grid
    let m = 0;
    for (let j = 0; j < TUBE_N; j++) {
      const x = TUBE_LO + j / TUBE_INV;
      while (m < SWEEP - 2 && vn[m + 1] < x) m++;
      const f = Math.min(1, Math.max(0, (x - vn[m]) / (vn[m + 1] - vn[m])));
      this.vp[j] = vpa[m] + f * (vpa[m + 1] - vpa[m]);
      this.ig[j] = iga[m] + f * (iga[m + 1] - iga[m]);
    }
    // from the idle point (node at 0 V)
    const p0 = -TUBE_LO * TUBE_INV, i0 = Math.floor(p0), f0 = p0 - i0;
    const vp0 = this.vp[i0] + f0 * (this.vp[i0 + 1] - this.vp[i0]);
    const ig0 = this.ig[i0] + f0 * (this.ig[i0 + 1] - this.ig[i0]);
    for (let j = 0; j < TUBE_N; j++) { this.vp[j] -= vp0; this.ig[j] -= ig0; }
    this.gain = (this.vp[i0 + 4] - this.vp[i0 - 4]) * TUBE_INV / 8;
    this.Fvp = antiderivative(this.vp, TUBE_LO, TUBE_INV, 0);
    this.Fig = antiderivative(this.ig, TUBE_LO, TUBE_INV, 1 / this.rs);
  }
}

/** The cathode follower's input range (volts of the driving plate's swing) and size. */
export const CF_LO = -260, CF_HI = 260, CF_N = 4096;
export const CF_INV = (CF_N - 1) / (CF_HI - CF_LO);

/**
 * The DC-coupled cathode follower between the last preamp stage and the
 * tone stack (Bassman, Marshall, Soldano): its grid sits on the driving
 * plate, its cathode on 100k. Its gain is ~0.98 until the grid gets above
 * the cathode; then grid current flows through the driving stage's 100k
 * plate resistor and the positive swing flattens (Dunkel et al., DAFx-16:
 * asymmetric clipping "and its concomitant even order harmonics"). The table
 * maps the driving plate's open-circuit swing to the cathode's swing.
 */
export class FollowerTable {
  readonly y = new Float64Array(CF_N);
  /** Its antiderivative (ADAA). */
  readonly F: Float64Array;
  /** Small-signal gain. */
  gain = 0;

  constructor(vb = 300, rk = 100e3, rdrive = 100e3, vg0 = 180) {
    const vo = new Float64Array(SWEEP), vk = new Float64Array(SWEEP);
    let cur = 1e-3;
    for (let s = 0; s < SWEEP; s++) {
      const vgk = -60 + 63 * s / (SWEEP - 1);
      const ik = cur = newton((i) => i - cathodeCurrent(vb - rk * i, vgk), cur);
      vk[s] = rk * ik;
      vo[s] = vk[s] + vgk + rdrive * gridCurrent(vgk);
    }
    // the idle point: the grid on the driving plate's idle voltage
    let m = 0;
    const at = (x: number): number => {
      while (m < SWEEP - 2 && vo[m + 1] < x) m++;
      while (m > 0 && vo[m] > x) m--;
      const f = Math.min(1, Math.max(0, (x - vo[m]) / (vo[m + 1] - vo[m])));
      return vk[m] + f * (vk[m + 1] - vk[m]);
    };
    const k0 = at(vg0);
    m = 0;
    for (let j = 0; j < CF_N; j++) this.y[j] = at(vg0 + CF_LO + j / CF_INV) - k0;
    const c = Math.round(-CF_LO * CF_INV);
    this.gain = (this.y[c + 2] - this.y[c - 2]) * CF_INV / 4;
    this.F = antiderivative(this.y, CF_LO, CF_INV, 0);
  }
}

/** The power stage of one voicing. */
export interface PowerParts {
  /** Single-ended class A (one tube) instead of push-pull. */
  se: boolean;
  /** Distance from the idle point to cutoff, with grid conduction at 1: under 1 is class AB (colder, less compression, a little crossover), 1 and over class A. */
  cut: number;
  /** Loop gain of the global negative feedback (0 none; 2 is ~10 dB). */
  nfb: number;
  /** Mismatch between the two sides of the push-pull: a little second harmonic. */
  imb: number;
  /** The phase inverter's limit, in the same units (it clips after the output tubes when it is above 1). */
  pi: number;
  /** Sharpness of the plate knee: 2 soft, 4 firm. */
  knee: number;
  /** The output tubes' plate resistance seen from the 8 ohm tap (ohms): with the feedback, what the speaker's impedance works against. */
  zp: number;
}

export const PA_R = 12, PA_N = 2048;
export const PA_INV = (PA_N - 1) / (2 * PA_R);

function outputTube(v: number, cut: number, im: number, n: number): number {
  const g = v - 0.92 * softplus(v - 1, 12);             // the grid conducts above 1 and is held there by the driver's impedance
  const i = Math.pow(softplus(g + cut, 14), 1.5);       // 3/2 law above a soft cutoff
  return i / Math.pow(1 + Math.pow(i / im, n), 1 / n);  // the plate knee
}

export class PowerTable {
  /** Output at input PA_R * (2 i / (PA_N - 1) - 1): unit slope at 0, a ceiling near 1. */
  readonly y = new Float64Array(PA_N);
  /** Its antiderivative (ADAA). */
  readonly F: Float64Array;
  /** The drive at the output grids (in units of their bias) that reaches full power: input 1 of the table. */
  readonly scale: number;

  constructor(p: PowerParts) {
    const im = 0.85 * Math.pow(1 + p.cut, 1.5);
    const idle = outputTube(0, p.cut, im, p.knee);
    const open = (x: number): number => {
      const v = p.pi * Math.tanh(x / p.pi);
      if (p.se) return outputTube(v, p.cut, im, p.knee) - idle;
      return (1 + p.imb) * outputTube(v, p.cut, im, p.knee) - (1 - p.imb) * outputTube(-v, p.cut, im, p.knee) - 2 * p.imb * idle;
    };
    const h = 1e-4;
    const a0 = (open(h) - open(-h)) / (2 * h);
    const top = open(50);
    const beta = p.nfb / a0;
    const scale = top * (1 + p.nfb) / a0;
    this.scale = scale;
    // the loop y = open(x - beta y), swept along the tubes' own drive e
    // (x = e + beta open(e) is explicit), then resampled onto x
    const E = PA_R * scale;
    const xs = new Float64Array(SWEEP), ys = new Float64Array(SWEEP);
    for (let s = 0; s < SWEEP; s++) { const e = E * (2 * s / (SWEEP - 1) - 1); ys[s] = open(e); xs[s] = e + beta * ys[s]; }
    let m = 0;
    for (let j = 0; j < PA_N; j++) {
      const x = PA_R * (2 * j / (PA_N - 1) - 1) * scale;
      while (m < SWEEP - 2 && xs[m + 1] < x) m++;
      const f = Math.min(1, Math.max(0, (x - xs[m]) / (xs[m + 1] - xs[m])));
      this.y[j] = (ys[m] + f * (ys[m + 1] - ys[m])) / top;
    }
    this.F = antiderivative(this.y, -PA_R, PA_INV, 0);
  }
}
