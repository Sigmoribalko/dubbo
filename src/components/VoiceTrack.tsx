import { useRef } from "react";
import { ENV_RATE, loudness, type Envelope } from "../lib/audio/envelope";
import type { Line } from "../lib/types";
import { useAnimationFrame } from "./useAnimationFrame";

const PX_PER_SECOND = 140;
/** Playhead a bit left of centre: you see what's coming and what you just said. */
const HEAD = 0.35;

interface Props {
  /** The character's voice over time (null while it's being measured). */
  reference: Envelope | null;
  /** Your finished recording on the same timeline. */
  mine: Envelope | null;
  /** Your voice while recording, filled in frame by frame. */
  live: React.RefObject<Float32Array | null>;
  /** The character's lines, drawn as faint lanes. */
  lines: Line[];
  color: string;
  time(): number;
  labels: { character: string; you: string; measuring: string };
}

/**
 * One scrolling loudness lane: the character's voice as a waveform-like envelope, with your
 * voice drawn on top, so loudness and timing can be compared at a glance.
 */
export function VoiceTrack({ reference, mine, live, lines, color, time, labels }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const colors = useRef<{ you: string; head: string } | null>(null);

  useAnimationFrame(() => {
    const cv = canvas.current;
    if (!cv || !cv.offsetParent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    if (!colors.current) {
      const cs = getComputedStyle(cv);
      colors.current = { you: cs.getPropertyValue("--accent").trim() || "#c6f135", head: cs.getPropertyValue("--rec").trim() || "#e8452c" };
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const t = time();
    const head = w * HEAD;
    const x = (sec: number) => head + (sec - t) * PX_PER_SECOND;
    const mid = h / 2;
    const amp = mid - 10;
    const first = Math.max(0, Math.floor((t - head / PX_PER_SECOND) * ENV_RATE));
    const last = Math.ceil((t + (w - head) / PX_PER_SECOND) * ENV_RATE);

    // Lanes for the character's lines.
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    for (const l of lines) {
      const a = x(l.start), b = x(l.end);
      if (b < 0 || a > w) continue;
      ctx.fillRect(a, 6, b - a, h - 12);
    }

    // Centre line.
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, mid - 0.5, w, 1);

    /** Envelope as a smooth shape mirrored around the centre line. */
    const shape = (values: Float32Array, until = last + 1) => {
      const top: Array<[number, number]> = [];
      for (let i = first; i <= until && i < values.length; i++) top.push([x((i + 0.5) / ENV_RATE), loudness(values[i]) * amp]);
      ctx.beginPath();
      top.forEach(([px, a], k) => (k ? ctx.lineTo(px, mid - a) : ctx.moveTo(px, mid - a)));
      for (let k = top.length - 1; k >= 0; k--) ctx.lineTo(top[k][0], mid + top[k][1]);
      ctx.closePath();
    };

    // The character: solid fill in the role colour.
    if (reference) {
      shape(reference.values);
      ctx.fillStyle = hexAlpha(color, 0.85);
      ctx.fill();
    }
    // You: an outline on top, so where you're louder or quieter is obvious.
    const yours = live.current ?? mine?.values;
    if (yours) {
      // While recording, nothing exists ahead of the playhead yet.
      shape(yours, live.current ? Math.floor(t * ENV_RATE) : last + 1);
      ctx.fillStyle = hexAlpha(colors.current.you, 0.18);
      ctx.fill();
      ctx.strokeStyle = colors.current.you;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // Playhead: "speak now".
    ctx.fillStyle = colors.current.head;
    ctx.shadowColor = colors.current.head;
    ctx.shadowBlur = 10;
    ctx.fillRect(head - 1.5, 0, 3, h);
    ctx.shadowBlur = 0;

    if (!reference) {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "600 13px Manrope, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(labels.measuring, w / 2 + head / 2, mid + 4);
    }
  });

  return (
    <div className="voice-track">
      <canvas ref={canvas} aria-hidden="true" />
      <div className="voice-legend">
        <span><i style={{ background: color }} />{labels.character}</span>
        <span><i className="you" />{labels.you}</span>
      </div>
    </div>
  );
}

/** "#rrggbb" → "rgba(r,g,b,a)"; other colour formats are returned unchanged. */
function hexAlpha(c: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
