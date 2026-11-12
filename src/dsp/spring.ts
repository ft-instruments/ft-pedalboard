// Spring tank: two springs (one per side), each a loop of a dispersive
// allpass chain and a delay. The stretched first-order allpasses
// (z^-1 -> z^-K, coefficient A > 0) delay the top of each of their bands
// more than its bottom, so every trip down the spring smears a click into a
// chirp. After J. Parker and S. Bilbao's spring models; the chain is ~100
// stages with a coefficient near 0.75, as in Valimaki, Parker & Abel
// ("Parametric spring reverberation effect", JAES 2010), where the group
// delay rises toward fs / 2K as it does here. The two springs differ in
// length and coefficient so the sides are not the same chirp.
//
// The stretch K is set from the sample rate so the dispersive band edge,
// fs / (2K), stays near DISP_HZ at any host rate (it was 4.8 kHz at 48 kHz,
// 9.6 kHz at 96 kHz); the group delay of each stage, K / fs seconds, then
// stays the same too.

const STAGES = 100;
/** Where the dispersive band ends, Hz: K = round(fs / (2 DISP_HZ)), 5 at 48 kHz. */
const DISP_HZ = 4800;
/** Allpass coefficients of the two springs: how strong the chirp is. */
const A_L = 0.73, A_R = 0.77;
/** The loop gain never quite reaches 1 at the damping filters' loudest frequency. */
const G_MAX = 0.999;

class Spring {
  private ap: Float32Array;    // STAGES rings of K samples (x and y history)
  private apY: Float32Array;
  private apIdx = 0;
  private line: Float32Array;
  private idx = 0;
  private lp = 0; private hp = 0; private lp2 = 0;
  private readonly len: number;
  private readonly K: number;
  private readonly A: number;
  /** One trip round the loop at 1 kHz, seconds: the line and the chain's group delay there. */
  readonly trip: number;

  constructor(sampleRate: number, ms: number, A: number) {
    const K = Math.max(1, Math.round(sampleRate / (2 * DISP_HZ)));
    this.K = K; this.A = A;
    this.ap = new Float32Array(STAGES * K);
    this.apY = new Float32Array(STAGES * K);
    this.len = Math.round(ms * 1e-3 * sampleRate);
    this.line = new Float32Array(this.len);
    const wk = 2 * Math.PI * 1000 / sampleRate * K;
    this.trip = (this.len + STAGES * K * (1 - A * A) / (1 + 2 * A * Math.cos(wk) + A * A)) / sampleRate;
  }

  reset(): void { this.ap.fill(0); this.apY.fill(0); this.line.fill(0); this.lp = this.hp = this.lp2 = 0; }

  tick(x: number, g: number, lpA: number, hpA: number): number {
    // loop: input + the returning wave through damping, then the dispersion
    const back = this.line[this.idx];
    this.lp += (back - this.lp) * lpA;
    this.hp += (this.lp - this.hp) * hpA;
    let v = x + (this.lp - this.hp) * g;
    const j = this.apIdx, K = this.K, A = this.A;
    for (let s = 0; s < STAGES; s++) {
      const o = s * K + j;
      const xd = this.ap[o], yd = this.apY[o];
      const y = A * v + xd - A * yd;     // H(z) = (A + z^-K) / (1 + A z^-K)
      this.ap[o] = v; this.apY[o] = y;
      v = y;
    }
    this.apIdx = j + 1 >= K ? 0 : j + 1;
    this.line[this.idx] = v;
    if (++this.idx >= this.len) this.idx = 0;
    this.lp2 += (v - this.lp2) * lpA;
    return this.lp2;
  }
}

export class SpringTank {
  private a: Spring;
  private b: Spring;
  private readonly fs: number;
  private lastTone = -1; private maxLH = 1;
  level = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.a = new Spring(sampleRate, 33, A_L);
    this.b = new Spring(sampleRate, 45, A_R);
  }

  reset(): void { this.a.reset(); this.b.reset(); this.level = 0; }

  /** In place, stereo. `decay` seconds to -60 dB, `tone` 0..1, `mix` 0..1. */
  process(L: Float32Array, R: Float32Array, n: number, decay: number, tone: number, mix: number): void {
    const fs = this.fs;
    const lpA = 1 - Math.exp(-2 * Math.PI * (2500 + tone * 3500) / fs);
    const hpA = 1 - Math.exp(-2 * Math.PI * 180 / fs);
    // the loop's damping filters take some of each trip at 1 kHz too: give it back, so `decay` is the time to -60 dB there
    const w = 2 * Math.PI * 1000 / fs, cw = Math.cos(w);
    const lpM = lpA / Math.sqrt(1 - 2 * (1 - lpA) * cw + (1 - lpA) * (1 - lpA));
    const hpLoss = (1 - hpA) * Math.sqrt((2 - 2 * cw) / (1 - 2 * (1 - hpA) * cw + (1 - hpA) * (1 - hpA)));
    // the damping's loudest point (it was capped at a loop gain of 0.97 instead, which held the decay near 3 s)
    if (tone !== this.lastTone) {
      this.lastTone = tone; let mx = 0;
      for (let f = 50; f < 12000; f *= 1.1) {
        const c = Math.cos(2 * Math.PI * f / fs);
        const l = lpA / Math.sqrt(1 - 2 * (1 - lpA) * c + (1 - lpA) * (1 - lpA)), h = (1 - hpA) * Math.sqrt((2 - 2 * c) / (1 - 2 * (1 - hpA) * c + (1 - hpA) * (1 - hpA)));
        if (l * h > mx) mx = l * h;
      }
      this.maxLH = mx;
    }
    const d = Math.max(0.1, decay), cap = G_MAX / this.maxLH;
    const ga = Math.min(cap, Math.pow(10, -3 * this.a.trip / d) / (lpM * hpLoss)), gb = Math.min(cap, Math.pow(10, -3 * this.b.trip / d) / (lpM * hpLoss));
    const wet = mix * 0.9, dry = 1 - mix * 0.4;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      const drive = (xl + xr) * 0.35;
      const wl = this.a.tick(drive, ga, lpA, hpA);
      const wr = this.b.tick(drive, gb, lpA, hpA);
      const a = Math.abs(wl); if (a > peak) peak = a;
      L[i] = xl * dry + wl * wet;
      R[i] = xr * dry + wr * wet;
    }
    this.level = peak;
  }
}
