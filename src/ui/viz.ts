// The picture on each unit's faceplate: what its controls are doing, and
// what the signal is doing to it right now. The gate shows the level against
// its threshold; the compressor, its gain reduction; a drive, its clipping
// curve with the live signal riding on it; the amp, its tone stack and a row
// of tubes lit by how hard each stage is driven; the EQ and the phaser their
// responses (the phaser's moving with its sweep); chorus and tremolo their
// LFOs; the echo its repeats; the spring a coil that shivers; the hall its
// decay.

import { driveCurve } from '../dsp/drive.ts';
import { ToneStack } from '../dsp/tonestack.ts';
import { ampStack, ampStages } from '../dsp/amp.ts';
import { Eq, Eq7 } from '../dsp/eq.ts';
import { Biquad } from '../dsp/util.ts';
import {
  M_GATE, M_COMP, M_COMP2, M_EQ7, M_GLOW, M_RASP, M_FUZZ, M_AMP, M_EQ, M_CHORUS, M_PHASER, M_TREM, M_ECHO, M_SPRING, M_HALL,
  M_MUFF, M_BOOST, M_AMP2, M_FLANGER, M_TRANSPARENT, M_METAL, M_AMP3, M_PLATE, M_ROOM, M_WAH, M_VIBE, M_ROTARY, M_OCTAVE, M_GTONE, M_SDELAY, M_ENVFILTER, M_PITCH, M_AMP_FIRST, isAmp,
  CAB_TYPES, CAB2_TYPES, CAB3_TYPES, CAB4_TYPES, AMP_VOICING_BASE, driveKind,
} from '../dsp/params.ts';
import { heatColour } from './spine.ts';

export interface VizLive {
  /** The slot's own number (see PedalboardEngine.slotLive). */
  live: number;
  heat: number;
  /** The amp's tubes: preamp stages then the power stage. */
  stages: ArrayLike<number>;
}

// the first amp's four channels, then the second amp's three
const AMP_STAGES = Array.from({ length: 14 }, (_, v) => ampStages(v));

const FS = 48000;
const MONO = '"Geist Mono", monospace';

function fit(c: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}

const logX = (f: number, x0: number, x1: number) => x0 + (x1 - x0) * Math.log(f / 40) / Math.log(12000 / 40);
const rgba = (c: number[], a: number) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;

function grid(ctx: CanvasRenderingContext2D, x0: number, x1: number, h: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  for (const f of [100, 1000, 10000]) { const x = Math.round(logX(f, x0, x1)) + 0.5; ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, h - 6); ctx.stroke(); }
}

/** A response curve, dB from `dbAt`; `centre` pins 0 dB to the middle (else the top follows the peak). */
function curve(ctx: CanvasRenderingContext2D, accent: string, x0: number, x1: number, h: number, dbAt: (f: number) => number, range: number, centre = false): void {
  const pts: [number, number][] = [];
  let top = -Infinity;
  for (let i = 0; i <= 90; i++) { const f = 40 * Math.pow(12000 / 40, i / 90); const d = dbAt(f); pts.push([logX(f, x0, x1), d]); if (d > top) top = d; }
  const yOf = (d: number) => centre ? h / 2 - d / range * (h - 16) : 10 + (top - d) / range * (h - 20);
  if (centre) { ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.moveTo(x0, h / 2 + 0.5); ctx.lineTo(x1, h / 2 + 0.5); ctx.stroke(); }
  ctx.beginPath();
  pts.forEach(([x, d], i) => { const y = Math.max(2, Math.min(h - 2, yOf(d))); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.strokeStyle = accent; ctx.lineWidth = 1.6; ctx.shadowColor = accent; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
  ctx.lineTo(x1, h); ctx.lineTo(x0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, accent + '30'); g.addColorStop(1, accent + '00');
  ctx.fillStyle = g; ctx.fill();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign = 'right'): void {
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = `9px ${MONO}`; ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

export class ModuleViz {
  private hist = new Float32Array(160);
  private hist2 = new Float32Array(160);
  private hi = 0;
  private stack = new ToneStack();
  private eq = new Eq(FS);
  private eq7 = new Eq7(FS);
  private eq2 = new Biquad();
  private dot = 0;

  constructor(private canvas: HTMLCanvasElement, private type: number) {}

  /** `k`: the module's knobs in real units, in knob order. */
  draw(k: number[], live: VizLive, accent: string, now: number): void {
    const [ctx, w, h] = fit(this.canvas);
    if (w === 0) return;
    switch (this.type) {
      default:
        if (isAmp(this.type)) this.drawAmp(ctx, w, h, k, live, accent);
        break;
      case M_GATE: {
        this.hist[this.hi] = 20 * Math.log10(live.live + 1e-9);
        this.hist2[this.hi] = live.heat;
        this.hi = (this.hi + 1) % this.hist.length;
        const n = this.hist.length, yOf = (db: number) => 6 + (h - 12) * (1 - (Math.max(-96, Math.min(0, db)) + 96) / 96);
        for (let i = 0; i < n; i++) {
          const j = (this.hi + i) % n, x = (i / n) * w;
          if (this.hist2[j] > 0.5) { ctx.fillStyle = 'rgba(255, 90, 90, 0.07)'; ctx.fillRect(x, 0, w / n + 1, h); }
        }
        ctx.beginPath();
        for (let i = 0; i < n; i++) { const j = (this.hi + i) % n, x = (i / n) * w, y = yOf(this.hist[j]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
        ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.stroke();
        const ty = yOf(k[0]);
        ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke(); ctx.setLineDash([]);
        label(ctx, live.heat > 0.5 ? 'closed' : 'open', w - 6, 13);
        break;
      }
      case M_COMP: case M_COMP2: {
        // gain reduction over time, hanging from the top
        this.hist[this.hi] = live.live;
        this.hi = (this.hi + 1) % this.hist.length;
        const n = this.hist.length, range = 24;
        ctx.fillStyle = accent; ctx.globalAlpha = 0.75;
        for (let i = 0; i < n; i++) {
          const j = (this.hi + i) % n, d = Math.min(range, this.hist[j]);
          ctx.fillRect((i / n) * w, 4, w / n + 0.5, (h - 8) * d / range);
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        for (const d of [6, 12, 18]) { const y = Math.round(4 + (h - 8) * d / range) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        label(ctx, `−${live.live.toFixed(1)} dB`, w - 6, h - 6);
        break;
      }
      case M_GLOW: case M_RASP: case M_FUZZ: case M_MUFF: case M_BOOST: case M_TRANSPARENT: case M_METAL: case M_OCTAVE: {
        const type = driveKind(this.type), gain = k[0], cx = w / 2, cy = h / 2, R = 0.5;
        let peak = 0;
        for (let i = 0; i <= 100; i++) peak = Math.max(peak, Math.abs(driveCurve(type, gain, -R + (2 * R * i) / 100)));
        const sx = (w * 0.42) / R, sy = (h * 0.4) / Math.max(1e-6, peak);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath(); ctx.moveTo(0, cy + 0.5); ctx.lineTo(w, cy + 0.5); ctx.moveTo(cx + 0.5, 0); ctx.lineTo(cx + 0.5, h); ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i <= 140; i++) { const v = -R + (2 * R * i) / 140; const x = cx + v * sx, y = cy - driveCurve(type, gain, v) * sy; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
        ctx.strokeStyle = accent; ctx.lineWidth = 1.8; ctx.shadowColor = accent; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
        // the signal riding on the curve, swinging between its peaks
        this.dot += (Math.min(R, live.live) - this.dot) * 0.3;
        const v = this.dot * Math.sin(now / 90);
        const col = heatColour(live.heat);
        ctx.beginPath(); ctx.arc(cx + v * sx, cy - driveCurve(type, gain, v) * sy, 3.5 + 3 * live.heat, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, 1); ctx.shadowColor = rgba(col, 1); ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
        break;
      }
      case M_GTONE: {
        // the passive tone control's low-pass, and the volume as a bar
        this.eq2.lowpass(FS, 500 * Math.pow(14, k[0]), 0.5 + 0.5 * k[0]);
        grid(ctx, 6, w - 6, h);
        curve(ctx, accent, 6, w - 6, h, (f) => 20 * Math.log10(this.eq2.mag(FS, f) * k[1] * k[1] + 1e-6), 36, true);
        break;
      }
      case M_EQ7: {
        this.eq7.set(k);
        grid(ctx, 6, w - 6, h);
        curve(ctx, accent, 6, w - 6, h, (f) => 20 * Math.log10(this.eq7.mag(f)) + k[7], 30, true);
        break;
      }
      case M_EQ: {
        this.eq.set(k[0], k[1], k[2], k[3], k[4]);
        grid(ctx, 6, w - 6, h);
        curve(ctx, accent, 6, w - 6, h, (f) => 20 * Math.log10(this.eq.mag(f)) + k[5], 30, true);
        break;
      }
      case M_ROTARY: {
        // the two rotors seen from above: the horn spins with the engine's phase, the drum a little behind
        const cx = w / 2, cy = h / 2, r = Math.min(w * 0.18, h * 0.38), a = 2 * Math.PI * live.live;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
        for (const dx of [-w * 0.2, w * 0.2]) { ctx.beginPath(); ctx.arc(cx + dx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
        [[-w * 0.2, a, 1], [w * 0.2, a * 0.8 + 1, 0.6]].forEach(([dx, ang, s]) => {
          const x = cx + dx + Math.cos(ang) * r * s, y = cy + Math.sin(ang) * r * s * 0.9;
          ctx.beginPath(); ctx.moveTo(cx + dx, cy); ctx.lineTo(x, y);
          ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.shadowColor = accent; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
        });
        label(ctx, 'horn · drum', w - 6, 13);
        break;
      }
      case M_CHORUS: case M_FLANGER: case M_VIBE: case M_TREM: {
        // the LFO across one cycle (two for the tremolo), the cursor where it is now
        const trem = this.type === M_TREM, cycles = trem ? 2 : 1, x0 = 8, x1 = w - 8;
        const depth = k[1], kk = 1 + (trem ? k[2] : 0) * 14, norm = 1 / Math.tanh(kk);
        const val = (u: number, off: number) => trem
          ? 1 - depth * (0.5 - 0.5 * Math.tanh(kk * Math.sin(2 * Math.PI * (u + off))) * norm)
          : 0.5 + 0.5 * depth * Math.sin(2 * Math.PI * (u + off));
        const yOf = (g: number) => h - 8 - (h - 16) * g;
        const traces = trem || this.type === M_VIBE ? [0] : [0, 0.25];
        traces.forEach((off, t) => {
          ctx.beginPath();
          for (let i = 0; i <= 160; i++) { const y = yOf(val((i / 160) * cycles, off)); if (i) ctx.lineTo(x0 + (x1 - x0) * i / 160, y); else ctx.moveTo(x0, y); }
          ctx.strokeStyle = accent; ctx.globalAlpha = t ? 0.45 : 1; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
        });
        const ph = live.live, cx = x0 + (x1 - x0) * (ph / cycles);
        traces.forEach((off) => {
          ctx.beginPath(); ctx.arc(cx, yOf(val(ph, off)), 3.5, 0, Math.PI * 2);
          ctx.fillStyle = accent; ctx.shadowColor = accent; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
        });
        label(ctx, trem || this.type === M_VIBE ? `${k[0].toFixed(1)} Hz` : 'L · R', w - 6, 13);
        break;
      }
      case M_PHASER: {
        // the response at this moment of the sweep (left side): notches that slide with the LFO
        const st = 4 + 2 * Math.round(k[3]), fb = k[2], wet = k[5];
        const u = 0.5 - 0.5 * Math.cos(2 * Math.PI * live.live);
        const fc = 180 * Math.exp(Math.log(2) * k[1] * 4.5 * u);
        const t = Math.tan(Math.PI * fc / FS), a = (t - 1) / (t + 1);
        grid(ctx, 6, w - 6, h);
        curve(ctx, accent, 6, w - 6, h, (f) => {
          const wv = 2 * Math.PI * f / FS;
          // one stage, (a + e^-jw) / (1 + a e^-jw), has unit magnitude: only its phase counts
          const ph = st * (Math.atan2(-Math.sin(wv), a + Math.cos(wv)) - Math.atan2(-a * Math.sin(wv), 1 + a * Math.cos(wv)));
          const ar = Math.cos(ph), ai = Math.sin(ph);
          // the stages inside the feedback loop: A / (1 - fb A)
          const er = 1 - fb * ar, ei = -fb * ai, den = er * er + ei * ei;
          const yr = (ar * er + ai * ei) / den, yi = (ai * er - ar * ei) / den;
          const outR = (1 - wet) + wet * yr, outI = wet * yi;
          return 10 * Math.log10(outR * outR + outI * outI + 1e-9);
        }, 30, true);
        break;
      }
      case M_SDELAY: {
        // the repeats on each side as bars on their own lane: every repeat of a side feeds itself and the other
        // side by the cross-feed, so the bars show where the sound really goes
        const [tL, tR, fbL, fbR, cross, , , lvL, lvR, wet] = k;
        const span = 2.4, x0 = 8, x1 = w - 8, laneH = (h - 20) / 2;
        const lanes = [{ y: 6, level: lvL, name: 'L', t: tL }, { y: 6 + laneH + 8, level: lvR, name: 'R', t: tR }];
        const events: [number, number, number][] = [[0, tL, 1], [1, tR, 1 - cross]];     // [lane, time, level]
        const bars: [number, number, number][] = [];
        for (let i = 0; i < events.length && i < 160; i++) {
          const [ln, t, a] = events[i];
          if (t > span || a < 0.02) continue;
          bars.push([ln, t, a]);
          if (ln === 0) { events.push([0, t + tL, a * fbL * (1 - cross)], [1, t + tR, a * cross * fbR]); }
          else { events.push([1, t + tR, a * fbR * (1 - cross)], [0, t + tL, a * cross * fbL]); }
        }
        lanes.forEach((ln, li) => {
          const base = ln.y + laneH;
          ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.moveTo(x0, base + 0.5); ctx.lineTo(x1, base + 0.5); ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(x0, ln.y + 2, 2, laneH - 2);
          for (const [bl, t, a] of bars) {
            if (bl !== li) continue;
            const top = base - (laneH - 3) * Math.min(1, a * Math.max(0.35, wet * 2) * ln.level);
            ctx.fillStyle = accent; ctx.globalAlpha = 0.3 + 0.7 * Math.min(1, a * 1.5);
            ctx.fillRect(x0 + (x1 - x0) * t / span - 1.5, top, 3, base - top);
          }
          ctx.globalAlpha = 1;
          label(ctx, `${ln.name} ${ln.t >= 1 ? ln.t.toFixed(2) + ' s' : Math.round(ln.t * 1000) + ' ms'}`, w - 6, ln.y + 10);
        });
        break;
      }
      case M_ECHO: {
        const span = 2.4, x0 = 8, x1 = w - 8, base = h - 10;
        const time = k[0], fb = k[1], tone = k[2], wow = k[3], wet = k[4], ping = k[5] >= 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.moveTo(x0, base + 0.5); ctx.lineTo(x1, base + 0.5); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(x0, 8, 2, base - 8);
        let a = wet;
        for (let r = 1; r < 24 && a > 0.01; r++) {
          const t = time * r;
          if (t > span) break;
          const wob = Math.sin(now / 1000 * 2 * Math.PI * 0.55 + r) * wow * 3;
          const x = x0 + (x1 - x0) * t / span + wob, top = base - (base - 8) * Math.min(1, a / Math.max(0.3, wet));
          ctx.fillStyle = accent; ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, a * 2);
          ctx.shadowColor = accent; ctx.shadowBlur = 6 * live.live * 4;
          ctx.fillRect(x - 1.5, top, 3, base - top);
          if (ping) ctx.fillRect(x - 6, top + (r % 2 ? 0 : 4), 3, 2);
          ctx.globalAlpha = 1; ctx.shadowBlur = 0;
          a *= fb * (0.75 + 0.25 * tone);
        }
        break;
      }
      case M_SPRING: {
        // a coil that shivers with what's in the tank
        const x0 = 14, x1 = w - 14, cy = h / 2, turns = 26, jig = Math.min(1, live.live * 3) * 8;
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(x0 - 6, cy - 10, 4, 20); ctx.fillRect(x1 + 2, cy - 10, 4, 20);
        ctx.beginPath();
        for (let i = 0; i <= 400; i++) {
          const u = i / 400, x = x0 + (x1 - x0) * u;
          const y = cy + Math.sin(u * turns * 2 * Math.PI) * 9 + Math.sin(u * 9 + now / 40) * jig * Math.sin(Math.PI * u);
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.strokeStyle = accent; ctx.lineWidth = 1.2; ctx.shadowColor = accent; ctx.shadowBlur = 3 + jig; ctx.stroke(); ctx.shadowBlur = 0;
        label(ctx, `${k[0].toFixed(1)} s`, w - 6, 13);
        break;
      }
      case M_WAH: {
        // the band-pass where the sweep is now
        const f = 350 * Math.pow(2300 / 350, live.live), q = 2 + 6 * k[2];
        this.eq2.bandpass(FS, f, q);
        grid(ctx, 6, w - 6, h);
        curve(ctx, accent, 6, w - 6, h, (fr) => 20 * Math.log10(this.eq2.mag(FS, fr) * 1.4 + 0.3), 30, true);
        label(ctx, `${Math.round(f)} Hz`, w - 6, 13);
        break;
      }
      case M_ENVFILTER: {
        // the filter where the envelope has it now, swept between its closed and open cutoffs
        const top = Math.min(20000, k[1] * Math.pow(2, k[2])), e = k[6] > 0.5 ? 1 - live.live : live.live;
        const f = k[1] * Math.pow(top / k[1], e), q = 1 + k[3] * k[3] * 16, t = Math.round(k[5]);
        if (t === 0) this.eq2.lowpass(FS, f, q); else if (t === 2) this.eq2.highpass(FS, f, q); else this.eq2.bandpass(FS, f, q);
        grid(ctx, 6, w - 6, h);
        curve(ctx, accent, 6, w - 6, h, (fr) => 20 * Math.log10(this.eq2.mag(FS, fr) * (t === 1 ? 1.4 : 1) + 0.05), 30, true);
        label(ctx, `${Math.round(f)} Hz`, w - 6, 13);
        break;
      }
      case M_PITCH: {
        // two bars: the note you play and the note it becomes, on a log frequency scale
        const st = Math.round(k[0]) + k[1] / 100, x0 = 14, x1 = w - 14, mid = h / 2;
        const px = (semi: number) => x0 + (x1 - x0) * (0.5 + semi / 36);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
        for (let o = -24; o <= 24; o += 12) { ctx.beginPath(); ctx.moveTo(px(o), 8); ctx.lineTo(px(o), h - 8); ctx.stroke(); }
        ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(px(0) - 2, mid - 14, 4, 14);
        ctx.globalAlpha = 0.35 + 0.65 * k[2]; ctx.fillStyle = accent; ctx.fillRect(px(st) - 2, mid, 4, 14); ctx.globalAlpha = 1;
        label(ctx, `${st > 0 ? '+' : ''}${st.toFixed(st % 1 ? 1 : 0)} st`, w - 6, 13);
        break;
      }
      case M_HALL: case M_PLATE: case M_ROOM: {
        const hall = this.type === M_HALL, plate = this.type === M_PLATE;
        const x0 = 8, x1 = w - 8, base = h - 8, span = hall ? 10 : 6, decay = hall ? k[0] : plate ? k[0] : k[1], wet = hall ? k[4] : plate ? k[2] : k[3];
        ctx.beginPath(); ctx.moveTo(x0, base);
        for (let i = 0; i <= 120; i++) {
          const t = (i / 120) * span, env = Math.pow(10, -3 * t / decay) * wet / 0.6;
          ctx.lineTo(x0 + (x1 - x0) * i / 120, base - (base - 8) * Math.min(1, env));
        }
        ctx.lineTo(x1, base); ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, accent + 'aa'); g.addColorStop(1, accent + '08');
        ctx.fillStyle = g; ctx.fill();
        if (hall && k[3] > 0.01) {
          // shimmer: sparks drifting over the tail
          ctx.fillStyle = '#ffffff';
          for (let i = 0; i < 12 * k[3]; i++) {
            const u = (i * 0.6180339 + now / 9000) % 1;
            ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(now / 300 + i));
            ctx.fillRect(x0 + (x1 - x0) * u * 0.8, 10 + (i * 13) % Math.max(1, h - 30), 1.5, 1.5);
          }
          ctx.globalAlpha = 1;
        }
        label(ctx, `${decay.toFixed(1)} s`, w - 6, 13);
        break;
      }
    }
  }

  private drawAmp(ctx: CanvasRenderingContext2D, w: number, h: number, k: number[], live: VizLive, accent: string): void {
    // the older amps have a channel knob in front of the others
    const legacy = this.type < M_AMP_FIRST, o = legacy ? 1 : 0;
    const ch = legacy ? Math.round(k[0]) + AMP_VOICING_BASE[this.type] : this.type - M_AMP_FIRST, split = w * 0.6;
    this.stack.set(FS, ampStack(ch).parts, k[o + 3], k[o + 2], k[o + 1], ampStack(ch).rs);
    grid(ctx, 6, split - 6, h);
    curve(ctx, accent, 6, split - 6, h, (f) => 20 * Math.log10(this.stack.mag(FS, f)), 24);
    // the tubes: preamp stages then the power tube, lit by drive
    const n = AMP_STAGES[ch], tw = Math.min(16, (w - split - 16) / (n + 2)), gap = 4;
    let x = split + 6;
    for (let s = 0; s <= n; s++) {
      const power = s === n;
      const heat = live.stages[power ? 4 : s] ?? 0;
      const t = Math.min(1, Math.log2(1 + heat) / 3.2);
      const tw2 = power ? tw * 1.5 : tw, th = power ? h - 26 : h - 34, ty = power ? 8 : 16;
      if (power) x += 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x, ty, tw2, th, [tw2 / 2, tw2 / 2, 2, 2]); ctx.stroke();
      const col = heatColour(0.25 + 0.75 * t);
      const g = ctx.createRadialGradient(x + tw2 / 2, ty + th * 0.55, 1, x + tw2 / 2, ty + th * 0.55, th * 0.6);
      g.addColorStop(0, rgba(col, 0.25 + 0.7 * t)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.fillRect(x, ty, tw2, th);
      ctx.strokeStyle = rgba(col, 0.5 + 0.5 * t); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x + tw2 / 2, ty + th * 0.35); ctx.lineTo(x + tw2 / 2, ty + th * 0.8); ctx.stroke();
      if (power) {
        // the sag: the supply's droop as a bar under the power tube
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x, h - 12, tw2, 4);
        ctx.fillStyle = accent; ctx.fillRect(x, h - 12, tw2 * Math.min(1, live.live * 3), 4);
      }
      x += tw2 + gap;
    }
    label(ctx, 'stack', 8, h - 6, 'left');
    const cab = CAB4_TYPES[Math.round(k[o + 7])];
    label(ctx, cab === 'off' ? 'no cab' : cab, w - 6, h - 1);
  }
}
