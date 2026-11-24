// The passive tone stacks, solved as the circuits they are: the network of
// resistors, pots and caps between the stage that drives it and the next
// grid, with the driving stage's own output resistance in series and the
// next stage's 1M as the load. For the Bassman/Marshall/Fender
// bass-middle-treble stack with an ideal source this is exactly Yeh and
// Smith's third-order transfer function ("Discretization of the '59 Fender
// Bassman tone stack", DAFx-06; the render test checks the two agree); with
// the source resistance in it, a stack hung on a plate (the blackface Fender:
// ~38k, not the ~600 ohms of a cathode follower) gets its real loss and
// scoop, which Yeh and Smith note their derivation leaves out.
//
// How: each cap is a state. With the caps replaced by voltage sources the
// network is resistive, and one small nodal solve gives every cap's current
// and the output for a unit of each source and of the input: that is the
// state-space model (A, B, C, D). The trapezoidal rule (the bilinear
// transform) turns it into the per-sample update. The knobs interact, as
// they do on the amp: the middle moves the bass, the treble moves the mids.
// Only a knob change re-solves; no allocation after construction.

/** Component values. `topo` 0: bass/middle/treble (TMB); 1: the Vox top boost (TMB without a middle pot: R3 is fixed); 2: a James-type network (separate bass and treble paths). */
export interface StackParts { topo: number; R1: number; R2: number; R3: number; R4: number; C1: number; C2: number; C3: number }

// values: Yeh's thesis (Figs 2.2-2.4) and the published schematic values
/** '59 Bassman 5F6-A (Yeh Fig 2.2 with Guitarix's 56k slope). */
export const STACK_BASSMAN: StackParts = { topo: 0, R1: 250e3, R2: 1e6, R3: 25e3, R4: 56e3, C1: 250e-12, C2: 20e-9, C3: 20e-9 };
/** JCM800 (Yeh Fig 2.2). */
export const STACK_JCM800: StackParts = { topo: 0, R1: 220e3, R2: 1e6, R3: 22e3, R4: 33e3, C1: 470e-12, C2: 22e-9, C3: 22e-9 };
/** Plexi / Marshall lead: 250k treble, 500 pF. */
export const STACK_PLEXI: StackParts = { topo: 0, R1: 250e3, R2: 1e6, R3: 25e3, R4: 33e3, C1: 500e-12, C2: 22e-9, C3: 22e-9 };
/** Soldano SLO (and the 5150 that copies it). */
export const STACK_SOLDANO: StackParts = { topo: 0, R1: 250e3, R2: 1e6, R3: 25e3, R4: 47e3, C1: 470e-12, C2: 20e-9, C3: 20e-9 };
/** Blackface Fender (Yeh Fig 2.4): 250k bass, 10k mid, 100k slope, 100n/47n. */
export const STACK_BLACKFACE: StackParts = { topo: 0, R1: 250e3, R2: 250e3, R3: 10e3, R4: 100e3, C1: 250e-12, C2: 100e-9, C3: 47e-9 };
/** Mesa Mark-style. */
export const STACK_MESA: StackParts = { topo: 0, R1: 250e3, R2: 250e3, R3: 25e3, R4: 100e3, C1: 250e-12, C2: 100e-9, C3: 47e-9 };
/** Vox AC30 top boost (Yeh Fig 2.3): 1M treble, 1M bass, 10k fixed (here a 20k "middle" whose noon is the real 10k), 100k, 50p/22n/22n. */
export const STACK_TOPBOOST: StackParts = { topo: 1, R1: 1e6, R2: 1e6, R3: 20e3, R4: 100e3, C1: 50e-12, C2: 22e-9, C3: 22e-9 };
/**
 * Hiwatt: a James-type network with ampbooks' CP103 values where they are
 * given (100k with 47 nF: the bass transition at 37 Hz; a 1M bass and a 250k
 * treble pot); the rest chosen so the treble transition falls near 2.8 kHz
 * and the fixed scoop near 316 Hz (ampbooks' figures). R3 is the middle: a
 * pot in the bass path's ground leg. The exact DR103 topology was not found.
 */
export const STACK_HIWATT: StackParts = { topo: 2, R1: 100e3, R2: 1e6, R3: 25e3, R4: 250e3, C1: 4.7e-9, C2: 560e-12, C3: 5.6e-9 };
/** Orange: no documented values; a flat, thick TMB (kept from before). */
export const STACK_ORANGE: StackParts = { topo: 0, R1: 250e3, R2: 1e6, R3: 50e3, R4: 22e3, C1: 500e-12, C2: 10e-9, C3: 10e-9 };

/** The next grid (the stack's load). */
const R_LOAD = 1e6;
/** Pot ends never quite reach 0 ohms. */
const R_MIN = 1;
const MAXN = 14;      // nodes + sources
const NS = 4;         // caps (states)
const MAXE = 16;      // resistors

/** Solve M x = b in place for several right-hand sides (Gaussian elimination, partial pivoting). M is n x n row-major, B is n x m. */
function solve(M: Float64Array, B: Float64Array, n: number, m: number): void {
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(M[c * n + c]);
    for (let r = c + 1; r < n; r++) { const a = Math.abs(M[r * n + c]); if (a > best) { best = a; p = r; } }
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
      for (let k = 0; k < m; k++) { const t = B[c * m + k]; B[c * m + k] = B[p * m + k]; B[p * m + k] = t; }
    }
    const d = M[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      for (let k = 0; k < m; k++) B[r * m + k] -= f * B[c * m + k];
    }
  }
  for (let c = n - 1; c >= 0; c--) {
    const d = M[c * n + c];
    for (let k = 0; k < m; k++) {
      let s = B[c * m + k];
      for (let j = c + 1; j < n; j++) s -= M[c * n + j] * B[j * m + k];
      B[c * m + k] = s / d;
    }
  }
}

export class ToneStack {
  // the discrete model: x = Ad x' + Bd (u + u'), y = Cd x + Dd u
  private ad = new Float64Array(NS * NS); private bd = new Float64Array(NS);
  private cd = new Float64Array(NS); private dd = 1;
  private x = new Float64Array(NS); private xn = new Float64Array(NS); private u1 = 0;
  // the continuous model, for mag()
  private A = new Float64Array(NS * NS); private B = new Float64Array(NS); private C = new Float64Array(NS); private D = 1;
  // scratch for the solves, and the netlist
  private M = new Float64Array(MAXN * MAXN); private R = new Float64Array(MAXN * (NS + 1));
  private P = new Float64Array(NS * NS); private Q = new Float64Array(NS * (NS + 1));
  private ra = new Int32Array(MAXE); private rb = new Int32Array(MAXE); private rv = new Float64Array(MAXE); private nr = 0;
  private ca = new Int32Array(NS); private cb = new Int32Array(NS); private cv = new Float64Array(NS); private nc = 0;
  private kFs = -1; private kParts: StackParts | null = null; private kT = -1; private kM = -1; private kL = -1; private kRs = -1;

  reset(): void { this.x.fill(0); this.u1 = 0; }

  private r(a: number, b: number, v: number): void { const i = this.nr++; this.ra[i] = a; this.rb[i] = b; this.rv[i] = Math.max(R_MIN, v); }
  private c(a: number, b: number, v: number): void { const i = this.nc++; this.ca[i] = a; this.cb[i] = b; this.cv[i] = v; }

  /**
   * Pots 0..1 (treble and middle linear, bass audio taper, as Yeh describes; the top boost's treble log).
   * `rs`: the driving stage's output resistance (a cathode follower ~600
   * ohms, a 12AX7 plate on 100k ~38k).
   */
  set(fs: number, p: StackParts, treble: number, mid: number, bass: number, rs = 600): void {
    if (fs === this.kFs && p === this.kParts && treble === this.kT && mid === this.kM && bass === this.kL && rs === this.kRs) return;
    this.kFs = fs; this.kParts = p; this.kT = treble; this.kM = mid; this.kL = bass; this.kRs = rs;
    // the Vox top boost's treble is a 1M log pot (voxac30.org.uk: "1M log potentiometers"): ~15% at noon
    const t = p.topo === 1 ? (Math.pow(32, Math.min(1, Math.max(0, treble))) - 1) / 31 : Math.min(1, Math.max(0, treble));
    const m = Math.min(1, Math.max(0, mid));
    const l = Math.exp((Math.min(1, Math.max(0, bass)) - 1) * 3.4);
    this.nr = 0; this.nc = 0;
    let nodes: number, out: number;
    // nodes are 1-based (0 = ground). 1: the source (behind rs), 2: the stack's input
    this.r(1, 2, rs);
    if (p.topo === 0 || p.topo === 1) {
      // 3: top of the treble pot, 4: its wiper (out), 5: its bottom = top of the bass pot, 6: the slope node,
      // 7: the bass pot's other end = top of the middle pot, 8: the middle's wiper, where C3 lands
      const mm = p.topo === 1 ? 0.5 : m;
      this.c(2, 3, p.C1);
      this.r(3, 4, (1 - t) * p.R1); this.r(4, 5, t * p.R1);
      this.r(2, 6, p.R4);
      this.c(6, 5, p.C2);
      this.c(6, 8, p.C3);
      this.r(5, 7, l * p.R2);
      this.r(7, 8, (1 - mm) * p.R3); this.r(8, 0, mm * p.R3);
      nodes = 8; out = 4;
    } else {
      // James (passive Baxandall): the bass path 2 -R1- 3 -[bass pot 3..4..5]- 5 -[middle]- 0, C1 across the
      // pot's top section and 10 C1 across its bottom one, the wiper (4) into the output (8) through 100k; the treble
      // path 2 -C2- 6 -[treble pot 6..8..7]- 7 -C3- 0 with its wiper on the output
      this.r(2, 3, p.R1);
      this.r(3, 4, (1 - l) * p.R2); this.r(4, 5, l * p.R2);
      this.c(3, 4, p.C1);
      this.c(4, 5, p.C1 * 10);
      this.r(5, 0, m * p.R3 + 1e3);
      this.r(4, 8, 100e3);
      this.c(2, 6, p.C2);
      this.r(6, 8, (1 - t) * p.R4); this.r(8, 7, t * p.R4);
      this.c(7, 0, p.C3);
      nodes = 8; out = 8;
    }
    this.r(out, 0, R_LOAD);
    // the modified nodal matrix: node voltages, then the current through each source (caps, then the input)
    const nc = this.nc, nsrc = nc + 1, n = nodes + nsrc;
    const M = this.M, R = this.R, w = nsrc;
    M.fill(0, 0, n * n); R.fill(0, 0, n * w);
    for (let i = 0; i < this.nr; i++) {
      const a = this.ra[i] - 1, b = this.rb[i] - 1, g = 1 / this.rv[i];
      if (a >= 0) M[a * n + a] += g;
      if (b >= 0) M[b * n + b] += g;
      if (a >= 0 && b >= 0) { M[a * n + b] -= g; M[b * n + a] -= g; }
    }
    // source k between nodes a (+) and b: its current leaves a through it to b
    for (let k = 0; k <= nc; k++) {
      const a = k < nc ? this.ca[k] - 1 : 0, b = k < nc ? this.cb[k] - 1 : -1, row = nodes + k;
      if (a >= 0) { M[a * n + row] += 1; M[row * n + a] += 1; }
      if (b >= 0) { M[b * n + row] -= 1; M[row * n + b] -= 1; }
      R[row * w + k] = 1;
    }
    solve(M, R, n, w);
    // cap k's current for a unit on source j is R[(nodes + k) w + j]; C dv/dt = i
    const A = this.A, B = this.B, C = this.C;
    A.fill(0); B.fill(0); C.fill(0);
    for (let k = 0; k < nc; k++) {
      const cv = this.cv[k];
      for (let j = 0; j < nc; j++) A[k * NS + j] = R[(nodes + k) * w + j] / cv;
      B[k] = R[(nodes + k) * w + nc] / cv;
      C[k] = R[(out - 1) * w + k];
    }
    this.D = R[(out - 1) * w + nc];
    // trapezoidal: (I - A T/2) x = (I + A T/2) x' + B T/2 (u + u')
    const h = 0.5 / fs, P = this.P, Q = this.Q, q = NS + 1;
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NS; j++) {
        const a = A[i * NS + j] * h, e = i === j ? 1 : 0;
        P[i * NS + j] = e - a;
        Q[i * q + j] = e + a;
      }
      Q[i * q + NS] = B[i] * h;
    }
    solve(P, Q, NS, q);
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NS; j++) this.ad[i * NS + j] = Q[i * q + j];
      this.bd[i] = Q[i * q + NS];
      this.cd[i] = C[i];
    }
    this.dd = this.D;
  }

  tick(u: number): number {
    const a = this.ad, b = this.bd, c = this.cd, x = this.x, w = u + this.u1;
    const p0 = x[0], p1 = x[1], p2 = x[2], p3 = x[3];
    const x0 = a[0] * p0 + a[1] * p1 + a[2] * p2 + a[3] * p3 + b[0] * w;
    const x1 = a[4] * p0 + a[5] * p1 + a[6] * p2 + a[7] * p3 + b[1] * w;
    const x2 = a[8] * p0 + a[9] * p1 + a[10] * p2 + a[11] * p3 + b[2] * w;
    const x3 = a[12] * p0 + a[13] * p1 + a[14] * p2 + a[15] * p3 + b[3] * w;
    x[0] = x0; x[1] = x1; x[2] = x2; x[3] = x3; this.u1 = u;
    return c[0] * x0 + c[1] * x1 + c[2] * x2 + c[3] * x3 + this.dd * u;
  }

  /** |H| at `f` Hz of the circuit (the continuous model), for the amp's picture and the tests. Not for the audio thread (it allocates). */
  mag(_fs: number, f: number): number {
    // (jw I - A) z = B, H = C z + D: a complex 4x4 solve as a real 8x8 one
    const w = 2 * Math.PI * f, n = 2 * NS, M = new Float64Array(n * n), b = new Float64Array(n);
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NS; j++) {
        const re = -this.A[i * NS + j], im = i === j ? w : 0;
        M[i * n + j] = re; M[i * n + NS + j] = -im;
        M[(NS + i) * n + j] = im; M[(NS + i) * n + NS + j] = re;
      }
      b[i] = this.B[i];
    }
    // unused states (a stack with fewer caps) are all-zero rows: pin them
    for (let i = 0; i < n; i++) { let z = true; for (let j = 0; j < n; j++) if (M[i * n + j] !== 0) { z = false; break; } if (z) M[i * n + i] = 1; }
    solve(M, b, n, 1);
    let hr = this.D, hi = 0;
    for (let k = 0; k < NS; k++) { hr += this.C[k] * b[k]; hi += this.C[k] * b[NS + k]; }
    return Math.sqrt(hr * hr + hi * hi);
  }
}

/** Yeh and Smith's closed-form TMB response with an ideal source and no load, |H(j 2 pi f)|: the reference the render test checks the network solver against. */
export function yehMag(p: StackParts, treble: number, mid: number, bass: number, f: number): number {
  const { R1, R2, R3, R4, C1, C2, C3 } = p;
  const t = treble, m = mid, l = Math.exp((bass - 1) * 3.4);
  const b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);
  const b2 = t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4) - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
    + m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) + l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4)
    + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3) + (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);
  const b3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4) - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
    + m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4) + t * C1 * C2 * C3 * R1 * R3 * R4 - t * m * C1 * C2 * C3 * R1 * R3 * R4
    + t * l * C1 * C2 * C3 * R1 * R2 * R4;
  const a1 = (C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4) + m * C3 * R3 + l * (C1 * R2 + C2 * R2);
  const a2 = m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
    - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) + l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4)
    + (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3 + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);
  const a3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4) - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
    + m * (C1 * C2 * C3 * R3 * R3 * R4 + C1 * C2 * C3 * R1 * R3 * R3 - C1 * C2 * C3 * R1 * R3 * R4) + l * C1 * C2 * C3 * R1 * R2 * R4 + C1 * C2 * C3 * R1 * R3 * R4;
  const w = 2 * Math.PI * f;
  // s = jw: s^2 = -w^2, s^3 = -j w^3
  const nr = -b2 * w * w, ni = b1 * w - b3 * w * w * w;
  const dr = 1 - a2 * w * w, di = a1 * w - a3 * w * w * w;
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}
