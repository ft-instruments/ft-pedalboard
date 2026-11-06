// The passive bass/middle/treble tone stack as its exact circuit transfer
// function: a third-order filter whose coefficients come straight from the
// component values and the three pot positions (D. T. Yeh and J. O. Smith,
// "Discretization of the '59 Fender Bassman tone stack", DAFx-06),
// discretized with the bilinear transform. The knobs interact, as they do on
// the amp: the middle moves the bass, the treble moves the mids.

export interface StackParts { R1: number; R2: number; R3: number; R4: number; C1: number; C2: number; C3: number }

/** Blackface / tweed Bassman values. */
export const STACK_FENDER: StackParts = { R1: 250e3, R2: 1e6, R3: 25e3, R4: 56e3, C1: 250e-12, C2: 20e-9, C3: 20e-9 };
/** Plexi / JCM values: more mids, a different centre. */
export const STACK_MARSHALL: StackParts = { R1: 220e3, R2: 1e6, R3: 22e3, R4: 33e3, C1: 470e-12, C2: 22e-9, C3: 22e-9 };
/** The chime channel: the same circuit with a small slope resistor and a big mid cap (a top-boost voicing on this topology): flatter and brighter. */
export const STACK_TOPBOOST: StackParts = { R1: 220e3, R2: 1e6, R3: 25e3, R4: 15e3, C1: 330e-12, C2: 22e-9, C3: 68e-9 };
/** Amp ii: a warm tweed stack (soft scoop, rolled-off top), a nearly flat tight hi-watt stack, and a gentle one that the boutique channel's mid peak sits on. */
export const STACK_TWEED: StackParts = { R1: 250e3, R2: 1e6, R3: 25e3, R4: 22e3, C1: 120e-12, C2: 22e-9, C3: 22e-9 };
export const STACK_HIWATT: StackParts = { R1: 250e3, R2: 1e6, R3: 50e3, R4: 22e3, C1: 500e-12, C2: 10e-9, C3: 10e-9 };
export const STACK_BOUTIQUE: StackParts = { R1: 250e3, R2: 500e3, R3: 25e3, R4: 22e3, C1: 330e-12, C2: 22e-9, C3: 22e-9 };

export class ToneStack {
  private b0 = 1; private b1 = 0; private b2 = 0; private b3 = 0;
  private a1 = 0; private a2 = 0; private a3 = 0;
  private z1 = 0; private z2 = 0; private z3 = 0;
  private kFs = -1; private kParts: StackParts | null = null; private kT = -1; private kM = -1; private kL = -1;

  reset(): void { this.z1 = this.z2 = this.z3 = 0; }

  /** Pots 0..1. The bass pot is audio taper. */
  set(fs: number, p: StackParts, treble: number, mid: number, bass: number): void {
    if (fs === this.kFs && p === this.kParts && treble === this.kT && mid === this.kM && bass === this.kL) return;
    this.kFs = fs; this.kParts = p; this.kT = treble; this.kM = mid; this.kL = bass;
    const { R1, R2, R3, R4, C1, C2, C3 } = p;
    const t = Math.min(1, Math.max(0, treble));
    const m = Math.min(1, Math.max(0, mid));
    const l = Math.exp((Math.min(1, Math.max(0, bass)) - 1) * 3.4);

    const b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);
    const b2 = t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4)
      - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4)
      + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
      + (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);
    const b3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
      - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + t * C1 * C2 * C3 * R1 * R3 * R4 - t * m * C1 * C2 * C3 * R1 * R3 * R4
      + t * l * C1 * C2 * C3 * R1 * R2 * R4;
    const a0 = 1;
    const a1 = (C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4) + m * C3 * R3 + l * (C1 * R2 + C2 * R2);
    const a2 = m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
      - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4)
      + (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3 + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);
    const a3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
      - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + m * (C1 * C2 * C3 * R3 * R3 * R4 + C1 * C2 * C3 * R1 * R3 * R3 - C1 * C2 * C3 * R1 * R3 * R4)
      + l * C1 * C2 * C3 * R1 * R2 * R4 + C1 * C2 * C3 * R1 * R3 * R4;

    // bilinear transform, s = c (1 - z^-1) / (1 + z^-1)
    const c = 2 * fs, c2 = c * c, c3 = c2 * c;
    const B0 = -b1 * c - b2 * c2 - b3 * c3;
    const B1 = -b1 * c + b2 * c2 + 3 * b3 * c3;
    const B2 = b1 * c + b2 * c2 - 3 * b3 * c3;
    const B3 = b1 * c - b2 * c2 + b3 * c3;
    const A0 = -a0 - a1 * c - a2 * c2 - a3 * c3;
    const A1 = -3 * a0 - a1 * c + a2 * c2 + 3 * a3 * c3;
    const A2 = -3 * a0 + a1 * c + a2 * c2 - 3 * a3 * c3;
    const A3 = -a0 + a1 * c - a2 * c2 + a3 * c3;
    this.b0 = B0 / A0; this.b1 = B1 / A0; this.b2 = B2 / A0; this.b3 = B3 / A0;
    this.a1 = A1 / A0; this.a2 = A2 / A0; this.a3 = A3 / A0;
  }

  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y + this.z3;
    this.z3 = this.b3 * x - this.a3 * y;
    return y;
  }

  /** |H| at `f` Hz (fs as passed to set), for the amp's picture. */
  mag(fs: number, f: number): number {
    const w = 2 * Math.PI * f / fs;
    let nr = this.b0, ni = 0, dr = 1, di = 0;
    const b = [this.b1, this.b2, this.b3], a = [this.a1, this.a2, this.a3];
    for (let k = 1; k <= 3; k++) {
      const c = Math.cos(k * w), s = Math.sin(k * w);
      nr += b[k - 1] * c; ni -= b[k - 1] * s;
      dr += a[k - 1] * c; di -= a[k - 1] * s;
    }
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}
