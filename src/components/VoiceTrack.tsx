import { useRef } from "react";
import { ENV_RATE, loudness, type Envelope } from "../lib/audio/envelope";
import type { Line } from "../lib/types";
import { useAnimationFrame } from "./useAnimationFrame";

const PX_PER_SECOND = 140;
/** Playhead a bit left of centre: you see what's coming and what you just said. */
const HEAD = 0.35;
const RULER = 20;
const LANE = 52;
const GAP = 6;
export const VOICE_TRACK_HEIGHT = RULER + LANE * 2 + GAP * 3;

interface Props {
  /** The character's voice over time (null while it's being measured). */
  reference: Envelope | null;
  /** Your finished recording on the same timeline. */
  mine: Envelope | null;
  /** Your voice while recording, filled in frame by frame. */
  live: React.RefObject<Float32Array | null>;
  /** The character's lines, drawn as clips on the top lane. */
  lines: Line[];
  color: string;
  time(): number;
  labels: { character: string; you: string; measuring: string };
}

/** Cheap stable per-frame jitter so bars look like real audio, not a smooth curve. */
const grain = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return 0.72 + (x - Math.floor(x)) * 0.28;
};

/**
 * Two lanes like an editor timeline: the character's original voice on top, your take below,
 * a ruler with seconds and a playhead. Loudness and timing can be compared bar by bar.
 */
export function VoiceTrack({ reference, mine, live, lines, color, time, labels }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useRef<{ rec: string; ink: string; muted: string; line: string; film: string } | null>(null);

  useAnimationFrame(() => {
    const cv = canvas.current;
    if (!cv || !cv.offsetParent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    if (!theme.current) {
      const cs = getComputedStyle(cv);
      const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
      theme.current = { rec: v("--rec", "#e8452c"), ink: "#efeee8", muted: "#8f8e86", line: "rgba(255,255,255,0.06)", film: v("--film", "#141413") };
    }
    const c = theme.current;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const t = time();
    const head = Math.round(w * HEAD);
    const x = (sec: number) => head + (sec - t) * PX_PER_SECOND;
    const first = Math.max(0, Math.floor((t - head / PX_PER_SECOND) * ENV_RATE));
    const last = Math.ceil((t + (w - head) / PX_PER_SECOND) * ENV_RATE);
    const step = PX_PER_SECOND / ENV_RATE;
    const laneTop = [RULER + GAP, RULER + GAP * 2 + LANE];

    // Ruler: ticks every half second, labels every second.
    ctx.fillStyle = c.muted;
    ctx.font = "500 10px Manrope, system-ui, sans-serif";
    ctx.textBaseline = "top";
    const from = Math.floor(t - head / PX_PER_SECOND), to = Math.ceil(t + (w - head) / PX_PER_SECOND);
    for (let s = Math.max(0, from); s <= to; s += 0.5) {
      const px = Math.round(x(s)) + 0.5;
      const whole = s % 1 === 0;
      ctx.fillRect(px, whole ? 12 : 15, 1, whole ? 8 : 5);
      if (whole) ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, px + 3, 2);
    }

    // Lanes.
    for (const top of laneTop) {
      ctx.fillStyle = c.line;
      ctx.fillRect(0, top, w, LANE);
    }

    /** Bars for an envelope inside one lane, optionally only up to a frame. */
    const bars = (values: Float32Array, top: number, fill: string, until = last) => {
      const mid = top + LANE / 2;
      const amp = LANE / 2 - 6;
      ctx.fillStyle = fill;
      for (let i = first; i <= until && i < values.length; i++) {
        const v = loudness(values[i]);
        if (v < 0.04) continue;
        const bh = Math.max(1, v * grain(i) * amp);
        ctx.fillRect(Math.round(x(i / ENV_RATE)), mid - bh, Math.max(1, step - 1), bh * 2);
      }
    };

    // Top lane: the character's lines as clips, with their voice inside.
    const lane1 = laneTop[0];
    for (const l of lines) {
      const a = x(l.start), b = x(l.end);
      if (b < 0 || a > w) continue;
      ctx.fillStyle = withAlpha(color, 0.16);
      roundRect(ctx, a, lane1 + 2, b - a, LANE - 4, 5);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillRect(a, lane1 + 2, b - a, 2);
    }
    if (reference) bars(reference.values, lane1, color);

    // Bottom lane: your take — red while recording, light once it's done.
    const lane2 = laneTop[1];
    const yours = live.current ?? mine?.values;
    if (yours) {
      const recording = !!live.current;
      const until = recording ? Math.floor(t * ENV_RATE) : last;
      let start = yours.findIndex((v) => v > 0);
      if (start < 0) start = recording ? until : -1;
      if (start >= 0) {
        const endFrame = recording ? until : lastNonZero(yours);
        const a = x(start / ENV_RATE), b = x((endFrame + 1) / ENV_RATE);
        ctx.fillStyle = withAlpha(recording ? c.rec : c.ink, 0.12);
        roundRect(ctx, a, lane2 + 2, Math.max(2, b - a), LANE - 4, 5);
        ctx.fill();
        ctx.fillStyle = recording ? c.rec : withAlpha(c.ink, 0.6);
        ctx.fillRect(a, lane2 + 2, Math.max(2, b - a), 2);
      }
      bars(yours, lane2, recording ? c.rec : withAlpha(c.ink, 0.85), until);
    }

    // Lane labels sit on a small tab at the left edge.
    const tab = (text: string, top: number, dot?: string) => {
      ctx.font = "700 10px Manrope, system-ui, sans-serif";
      const tw = ctx.measureText(text).width + (dot ? 14 : 0);
      ctx.fillStyle = withAlpha(c.film, 0.85);
      roundRect(ctx, 6, top + 6, tw + 12, 16, 4);
      ctx.fill();
      if (dot) { ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(15, top + 14, 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = c.ink;
      ctx.textBaseline = "middle";
      ctx.fillText(text, 12 + (dot ? 14 : 0), top + 14.5);
      ctx.textBaseline = "top";
    };
    tab(labels.character.toUpperCase(), lane1);
    tab(labels.you.toUpperCase(), lane2, live.current ? c.rec : undefined);

    if (!reference) {
      ctx.fillStyle = c.muted;
      ctx.font = "600 12px Manrope, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(labels.measuring, head + 12, lane1 + LANE / 2);
      ctx.textBaseline = "top";
    }

    // Playhead with a flag on the ruler.
    ctx.fillStyle = c.rec;
    ctx.fillRect(head - 1, RULER - 2, 2, h - RULER + 2);
    ctx.beginPath();
    ctx.moveTo(head - 6, RULER - 10);
    ctx.lineTo(head + 6, RULER - 10);
    ctx.lineTo(head, RULER - 2);
    ctx.closePath();
    ctx.fill();
  });

  return <canvas ref={canvas} className="voice-track" style={{ height: VOICE_TRACK_HEIGHT }} aria-hidden="true" />;
}

function lastNonZero(a: Float32Array) {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] > 0) return i;
  return 0;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** "#rrggbb" → "rgba(r,g,b,a)"; other colour formats are returned unchanged. */
function withAlpha(col: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
