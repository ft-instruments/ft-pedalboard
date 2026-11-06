// The spine: the signal chain drawn as one patch cable down the left edge of
// the rack, from the input jack through a socket at each unit to the output.
// Each stretch glows with the level leaving the unit above it and runs
// hotter in colour as the drives and amps work harder (cold steel, amber,
// white heat); current pulses run down it at a speed that follows the level.
// Click a socket to switch its unit.

export interface SpineNode {
  y: number;           // centre of the socket, px from the top of the canvas
  colour: string;
  on: boolean;
  /** This unit's heat colours the cable after it (drives, amps). */
  drives: boolean;
}

export interface SpineLive {
  inPeak: number;
  slotPeak: ArrayLike<number>;
  slotHeat: ArrayLike<number>;
}

const COLD = [92, 112, 128], AMBER = [255, 176, 74], WHITE = [255, 240, 214];

function mix(a: number[], b: number[], t: number): number[] { return a.map((v, i) => v + (b[i] - v) * t); }
function rgba(c: number[], a: number): string { return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a.toFixed(3)})`; }
/** Heat 0..1 to cable colour. */
export function heatColour(t: number): number[] { return t < 0.5 ? mix(COLD, AMBER, t * 2) : mix(AMBER, WHITE, (t - 0.5) * 2); }
const levelOf = (peak: number) => Math.max(0, Math.min(1, (20 * Math.log10(peak + 1e-9) + 60) / 60));

const MAX = 16;
const SOCKET = 7;

export class Spine {
  private ctx: CanvasRenderingContext2D;
  private w = 0; private h = 0;
  private nodes: SpineNode[] = [];
  private seg = new Float64Array(MAX + 1);
  private segHeat = new Float64Array(MAX + 1);
  private nodeHeat = new Float64Array(MAX);
  private phase = new Float64Array(MAX + 1);
  private live: SpineLive | null = null;
  private last = 0;
  private hover = -1;

  constructor(private canvas: HTMLCanvasElement, private onToggle: (index: number) => void) {
    this.ctx = canvas.getContext('2d')!;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'the signal chain: one cable from the input through every unit to the output');
    canvas.addEventListener('click', (e) => { const i = this.nodeAt(e); if (i >= 0) this.onToggle(i); });
    canvas.addEventListener('pointermove', (e) => { this.hover = this.nodeAt(e); canvas.style.cursor = this.hover >= 0 ? 'pointer' : 'default'; });
    canvas.addEventListener('pointerleave', () => { this.hover = -1; });
  }

  private nodeAt(e: MouseEvent): number {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.abs(x - this.w / 2) > 14) return -1;
    return this.nodes.findIndex((n) => Math.abs(y - n.y) < 14);
  }

  setNodes(nodes: SpineNode[]): void { this.nodes = nodes.slice(0, MAX); }
  setLive(live: SpineLive): void { this.live = live; }

  private fit(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w !== this.w || h !== this.h || this.canvas.width !== Math.round(w * dpr)) {
      this.w = w; this.h = h;
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(now: number): void {
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    this.fit();
    const { ctx, w, h, nodes } = this;
    if (w === 0 || h === 0) return;
    const n = nodes.length, live = this.live, k = Math.min(1, dt * 10);
    // levels along the cable: the input, then after each unit in chain order
    let lvl = live ? levelOf(live.inPeak) : 0, heat = 0;
    for (let s = 0; s <= n; s++) {
      if (s > 0) {
        const node = nodes[s - 1];
        if (live && node.on) {
          lvl = levelOf(live.slotPeak[s - 1]);
          if (node.drives) heat = Math.max(heat, live.slotHeat[s - 1]);
        }
        this.nodeHeat[s - 1] += ((live && node.on ? live.slotHeat[s - 1] : 0) - this.nodeHeat[s - 1]) * k;
      }
      this.seg[s] += (lvl - this.seg[s]) * k;
      this.segHeat[s] += (heat - this.segHeat[s]) * k * 0.5;
      this.phase[s] += dt * (12 + 90 * this.seg[s]);
    }

    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const ys = [0, ...nodes.map((d) => d.y), h];
    ctx.lineCap = 'butt';
    for (let s = 0; s <= n; s++) {
      const a = ys[s] + (s === 0 ? 0 : SOCKET + 2), b = ys[s + 1] - (s === n ? 0 : SOCKET + 2);
      if (b - a < 2) continue;
      const level = this.seg[s], col = heatColour(this.segHeat[s]);
      ctx.strokeStyle = '#060505'; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(cx, a); ctx.lineTo(cx, b); ctx.stroke();
      ctx.strokeStyle = '#2a241f'; ctx.lineWidth = 5; ctx.stroke();
      if (level > 0.01) {
        ctx.save();
        ctx.shadowColor = rgba(col, 0.9); ctx.shadowBlur = 4 + 14 * level;
        ctx.strokeStyle = rgba(col, 0.2 + 0.7 * level); ctx.lineWidth = 1.2 + 2.4 * level;
        ctx.stroke();
        ctx.setLineDash([2, 16 - 8 * level]);
        ctx.lineDashOffset = -this.phase[s];
        ctx.strokeStyle = rgba(mix(col, WHITE, 0.6), 0.25 + 0.75 * level); ctx.lineWidth = 2 + 1.6 * level;
        ctx.stroke();
        ctx.restore();
      }
    }
    // the sockets
    for (let i = 0; i < n; i++) {
      const node = nodes[i], y = node.y;
      const hot = this.nodeHeat[i];
      ctx.beginPath(); ctx.arc(cx, y, SOCKET, 0, Math.PI * 2);
      ctx.fillStyle = '#16120f'; ctx.fill();
      ctx.lineWidth = this.hover === i ? 2 : 1.4;
      ctx.strokeStyle = node.on ? node.colour : 'rgba(255,255,255,0.22)';
      if (node.on) { ctx.shadowColor = node.colour; ctx.shadowBlur = 8; }
      ctx.stroke(); ctx.shadowBlur = 0;
      if (node.on) {
        ctx.beginPath(); ctx.arc(cx, y, 2.6, 0, Math.PI * 2); ctx.fillStyle = node.colour; ctx.fill();
        if (hot > 0.02) {
          const c = heatColour(hot);
          ctx.beginPath(); ctx.arc(cx, y, SOCKET + 3.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, hot));
          ctx.strokeStyle = rgba(c, 0.9); ctx.lineWidth = 1.6; ctx.stroke();
        }
      } else {
        // bypassed: the cable runs past the socket
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - 4, y); ctx.lineTo(cx + 4, y); ctx.stroke();
      }
    }
  }
}
