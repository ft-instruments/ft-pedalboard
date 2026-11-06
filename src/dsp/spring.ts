// Spring tank: two springs (one per side), each a loop of a dispersive
// allpass chain and a delay. The stretched first-order allpasses
// (z^-1 -> z^-K) delay the low band more than the top, so every trip down
// the spring smears a click into the falling "drip" chirp of an amp's
// reverb. After J. Parker and S. Bilbao's spring models, kept cheap.

const STAGES = 36;
const K = 5;                   // stretch: the dispersive band sits under fs / (2K)
const A = 0.62;                // allpass coefficient: how strong the chirp is

class Spring {
  private ap: Float32Array;    // STAGES rings of K samples (x and y history)
  private apY: Float32Array;
  private apIdx = 0;
  private line: Float32Array;
  private idx = 0;
  private lp = 0; private hp = 0; private lp2 = 0;
  private readonly len: number;

  constructor(sampleRate: number, ms: number) {
    this.ap = new Float32Array(STAGES * K);
    this.apY = new Float32Array(STAGES * K);
    this.len = Math.round(ms * 1e-3 * sampleRate);
    this.line = new Float32Array(this.len);
  }

  reset(): void { this.ap.fill(0); this.apY.fill(0); this.line.fill(0); this.lp = this.hp = this.lp2 = 0; }

  tick(x: number, g: number, lpA: number, hpA: number): number {
    // loop: input + the returning wave through damping, then the dispersion
    const back = this.line[this.idx];
    this.lp += (back - this.lp) * lpA;
    this.hp += (this.lp - this.hp) * hpA;
    let v = x + (this.lp - this.hp) * g;
    const j = this.apIdx;
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
  private readonly loopSeconds: number;
  level = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.a = new Spring(sampleRate, 37);
    this.b = new Spring(sampleRate, 43);
    this.loopSeconds = 0.04;
  }

  reset(): void { this.a.reset(); this.b.reset(); this.level = 0; }

  /** In place, stereo. `decay` seconds to -60 dB, `tone` 0..1, `mix` 0..1. */
  process(L: Float32Array, R: Float32Array, n: number, decay: number, tone: number, mix: number): void {
    const fs = this.fs;
    const g = Math.min(0.97, Math.pow(10, -3 * this.loopSeconds / Math.max(0.1, decay)));
    const lpA = 1 - Math.exp(-2 * Math.PI * (2500 + tone * 3500) / fs);
    const hpA = 1 - Math.exp(-2 * Math.PI * 180 / fs);
    const wet = mix * 0.9, dry = 1 - mix * 0.4;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      const drive = (xl + xr) * 0.35;
      const wl = this.a.tick(drive, g, lpA, hpA);
      const wr = this.b.tick(drive, g, lpA, hpA);
      const a = Math.abs(wl); if (a > peak) peak = a;
      L[i] = xl * dry + wl * wet;
      R[i] = xr * dry + wr * wet;
    }
    this.level = peak;
  }
}
