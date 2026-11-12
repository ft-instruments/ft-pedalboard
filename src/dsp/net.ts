// A small linear circuit solver for the pedals' passive networks (the Klon's
// feed-forward paths and clipper, the Big Muff's tone stack): resistors and
// capacitors between numbered nodes, driven by one ideal voltage source.
// Node 0 is ground, node 1 the source; nodes 2.. are solved. Capacitors are
// trapezoidal companions (a conductance 2C/T and a history current), so a
// sample is one matrix-vector product with the inverted conductance matrix,
// rebuilt only when a resistor (a pot) changes. One node may carry a diode
// pair to ground: its voltage is then the exact solution of
// v + Rth Id(v) = v_open, with Rth the network's resistance at that node,
// read from a diode table built for Rth.
//
// Nothing allocates after construction.

export class LinearNet {
  /** Unknown nodes (2..n+1). */
  readonly n: number;
  private ra = new Int32Array(16); private rb = new Int32Array(16); private rv = new Float64Array(16); private nr = 0;
  private ca = new Int32Array(16); private cb = new Int32Array(16); private cg = new Float64Array(16); private cj = new Float64Array(16); private nc = 0;
  /** The inverse conductance matrix (n x n), the source's coupling, scratch. */
  readonly inv: Float64Array; private bin: Float64Array; private m: Float64Array; private rhs: Float64Array;
  /** Node voltages after the last tick (index = node; 0 and 1 are ground and the source). */
  readonly v: Float64Array;
  private readonly T: number;
  private dirty = true;
  private lastOpen = 0;

  constructor(nodes: number, sampleRate: number) {
    this.n = nodes; this.T = 1 / sampleRate;
    this.inv = new Float64Array(nodes * nodes); this.m = new Float64Array(nodes * nodes);
    this.bin = new Float64Array(nodes); this.rhs = new Float64Array(nodes);
    this.v = new Float64Array(nodes + 2);
  }

  /** A resistor between nodes a and b; returns its index for setR. */
  r(a: number, b: number, ohms: number): number { const i = this.nr++; this.ra[i] = a; this.rb[i] = b; this.rv[i] = ohms; this.dirty = true; return i; }
  /** A capacitor between nodes a and b. */
  c(a: number, b: number, farads: number): void { const i = this.nc++; this.ca[i] = a; this.cb[i] = b; this.cg[i] = 2 * farads / this.T; this.cj[i] = 0; this.dirty = true; }
  /** Change a resistor (a pot); the matrix is rebuilt on the next tick. */
  setR(i: number, ohms: number): void { if (this.rv[i] !== ohms) { this.rv[i] = ohms; this.dirty = true; } }

  reset(): void { this.cj.fill(0); this.v.fill(0); this.lastOpen = 0; }

  private stamp(a: number, b: number, g: number): void {
    const n = this.n, m = this.m;
    if (a >= 2) m[(a - 2) * n + a - 2] += g;
    if (b >= 2) m[(b - 2) * n + b - 2] += g;
    if (a >= 2 && b >= 2) { m[(a - 2) * n + b - 2] -= g; m[(b - 2) * n + a - 2] -= g; }
    if (a === 1 && b >= 2) this.bin[b - 2] += g;
    if (b === 1 && a >= 2) this.bin[a - 2] += g;
  }

  /** Assemble and invert (Gauss-Jordan, partial pivoting). */
  build(): void {
    const n = this.n, m = this.m, inv = this.inv;
    m.fill(0); this.bin.fill(0);
    for (let i = 0; i < this.nr; i++) this.stamp(this.ra[i], this.rb[i], 1 / this.rv[i]);
    for (let i = 0; i < this.nc; i++) this.stamp(this.ca[i], this.cb[i], this.cg[i]);
    inv.fill(0);
    for (let i = 0; i < n; i++) inv[i * n + i] = 1;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]) > Math.abs(m[p * n + c])) p = r;
      if (p !== c) for (let k = 0; k < n; k++) { let t = m[c * n + k]; m[c * n + k] = m[p * n + k]; m[p * n + k] = t; t = inv[c * n + k]; inv[c * n + k] = inv[p * n + k]; inv[p * n + k] = t; }
      const d = 1 / m[c * n + c];
      for (let k = 0; k < n; k++) { m[c * n + k] *= d; inv[c * n + k] *= d; }
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = m[r * n + c];
        if (f === 0) continue;
        for (let k = 0; k < n; k++) { m[r * n + k] -= f * m[c * n + k]; inv[r * n + k] -= f * inv[c * n + k]; }
      }
    }
    this.dirty = false;
  }

  /** The resistance the network shows at node `d` (to ground, the source shorted). */
  rth(d: number): number { if (this.dirty) this.build(); return this.inv[(d - 2) * this.n + d - 2]; }

  /** The open-circuit node voltages for source voltage u (before any diode current). */
  private open(u: number): void {
    if (this.dirty) this.build();
    const n = this.n, rhs = this.rhs, inv = this.inv, v = this.v;
    for (let i = 0; i < n; i++) rhs[i] = this.bin[i] * u;
    for (let i = 0; i < this.nc; i++) {
      const a = this.ca[i], b = this.cb[i], j = this.cj[i];
      if (a >= 2) rhs[a - 2] += j;
      if (b >= 2) rhs[b - 2] -= j;
    }
    v[0] = 0; v[1] = u;
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < n; k++) s += inv[i * n + k] * rhs[k]; v[i + 2] = s; }
  }

  private commit(): void {
    const v = this.v;
    for (let i = 0; i < this.nc; i++) {
      const vab = v[this.ca[i]] - v[this.cb[i]], g = this.cg[i];
      const cur = g * vab - this.cj[i];
      this.cj[i] = g * vab + cur;
    }
  }

  /** One sample with source voltage u. */
  tick(u: number): void { this.open(u); this.commit(); }

  /**
   * One sample with a diode pair from node d to ground: `table` gives the
   * diode voltage for an open-circuit voltage behind rth(d) (a DiodeTable
   * built for that resistance), averaged since the last sample.
   * Returns the diode current.
   */
  tickDiode(u: number, d: number, table: { adaa(u: number, u1: number): number }): number {
    this.open(u);
    const n = this.n, inv = this.inv, v = this.v, k = d - 2, r = inv[k * n + k];
    // the diode voltage as the mean of the static curve since the last sample (antiderivative antialiasing)
    const vo = v[d], vd = table.adaa(vo, this.lastOpen), id = (vo - vd) / r;
    this.lastOpen = vo;
    for (let i = 0; i < n; i++) v[i + 2] -= inv[i * n + k] * id;
    this.commit();
    return id;
  }
}
