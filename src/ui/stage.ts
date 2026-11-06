// The room behind the board: a dark stage with one warm light from above and
// dust drifting through its beam. The beam brightens with the output level,
// the dust warms from pale gold to orange as the rig is driven harder, and a
// hard pick attack puffs the dust up off the floor like air off a speaker.

import { heatColour } from './spine.ts';

interface Mote { x: number; y: number; vx: number; vy: number; r: number; tw: number }

export class Stage {
  private ctx: CanvasRenderingContext2D;
  private motes: Mote[] = [];
  private w = 0; private h = 0;
  private level = 0; private heat = 0; private lastPeak = 0;
  private last = 0;
  private readonly still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = window.innerWidth; this.h = window.innerHeight;
      canvas.width = Math.round(this.w * dpr); canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    window.addEventListener('resize', resize);
    resize();
    for (let i = 0; i < 140; i++) {
      this.motes.push({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.004, vy: -0.002 - Math.random() * 0.006, r: 0.4 + Math.random() * 1.6, tw: Math.random() * 6.28 });
    }
  }

  /** Output peak (linear) and drive heat 0..1, from the latest meters. */
  feed(peak: number, heat: number): void {
    const lvl = Math.max(0, Math.min(1, (20 * Math.log10(peak + 1e-9) + 50) / 50));
    if (!this.still && peak > this.lastPeak * 2.2 && peak > 0.05) {
      // a transient: puff the dust near the floor upwards
      for (const m of this.motes) if (m.y > 0.6) m.vy -= 0.02 * lvl * (m.y - 0.5);
    }
    this.lastPeak = peak;
    this.level += (lvl - this.level) * 0.2;
    this.heat += (heat - this.heat) * 0.05;
  }

  draw(now: number): void {
    const dt = this.still ? 0 : Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    const { ctx, w, h } = this;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b0907'); g.addColorStop(1, '#070605');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // the light: a cone from above
    const col = heatColour(0.35 + 0.6 * this.heat);
    const lx = w * 0.5, beam = 0.05 + 0.1 * this.level;
    const cone = ctx.createRadialGradient(lx, -h * 0.1, 0, lx, -h * 0.1, h * 1.2);
    cone.addColorStop(0, `rgba(${col[0] | 0}, ${col[1] | 0}, ${col[2] | 0}, ${beam})`);
    cone.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cone;
    ctx.beginPath(); ctx.moveTo(lx - w * 0.08, 0); ctx.lineTo(lx + w * 0.08, 0); ctx.lineTo(lx + w * 0.45, h); ctx.lineTo(lx - w * 0.45, h); ctx.closePath(); ctx.fill();
    // a pool of light on the floor
    const pool = ctx.createRadialGradient(lx, h * 0.95, 0, lx, h * 0.95, w * 0.5);
    pool.addColorStop(0, `rgba(${col[0] | 0}, ${col[1] | 0}, ${col[2] | 0}, ${0.04 + 0.08 * this.level})`); pool.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = pool; ctx.fillRect(0, h * 0.5, w, h * 0.5);
    // dust
    for (const m of this.motes) {
      m.vx += (Math.random() - 0.5) * 0.002 * dt; m.vy += (-0.004 - m.vy) * dt * 0.5;
      m.x += m.vx * dt; m.y += m.vy * dt * (1 + this.level);
      m.tw += dt * 2;
      if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); m.vy = -0.002 - Math.random() * 0.006; }
      if (m.x < -0.02) m.x = 1.02; else if (m.x > 1.02) m.x = -0.02;
      const px = m.x * w, py = m.y * h;
      // lit only inside the beam
      const half = w * (0.08 + 0.37 * m.y);
      const inBeam = Math.max(0, 1 - Math.abs(px - lx) / half);
      const a = (0.08 + 0.5 * this.level) * inBeam * (0.6 + 0.4 * Math.sin(m.tw));
      if (a < 0.01) continue;
      ctx.fillStyle = `rgba(${col[0] | 0}, ${col[1] | 0}, ${col[2] | 0}, ${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(px, py, m.r, 0, Math.PI * 2); ctx.fill();
    }
  }
}
