import { useMemo, useRef } from "react";
import { ENV_RATE } from "../lib/audio/envelope";
import type { Line, Role } from "../lib/types";
import { colorFor, prefersReducedMotion } from "../lib/util";
import { Caption } from "../views/Caption";
import { useAnimationFrame } from "./useAnimationFrame";
import { VoiceTrack } from "./VoiceTrack";

/** The demo character's lines (seconds); `text` indexes the localized demo lines. */
const LINES = [
  { start: 0.6, end: 2.6, text: 0 },
  { start: 5.0, end: 7.4, text: 3 },
  { start: 10.4, end: 13.0, text: 5 },
];
const LENGTH = 16;
const started = performance.now();
const demoTime = () => (prefersReducedMotion() ? 1.7 : ((performance.now() - started) / 1000) % LENGTH);

/**
 * A rough speech envelope: uneven syllables, short pauses, the odd louder stressed word and
 * frame-to-frame noise, so it reads like a real recording.
 */
function speech(seed: number, shift: number, scale: number): Float32Array {
  const out = new Float32Array(LENGTH * ENV_RATE);
  let r = seed;
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  for (const l of LINES) {
    let t = l.start + shift + rnd() * 0.05;
    while (t < l.end + shift - 0.08) {
      const len = 0.08 + rnd() * 0.2;
      const stress = rnd() < 0.2 ? 1.6 : 1;
      const peak = (0.03 + rnd() * 0.12) * stress * scale;
      const a = Math.round(t * ENV_RATE), b = Math.min(out.length, Math.round((t + len) * ENV_RATE));
      for (let i = a; i < b; i++) {
        const shape = Math.pow(Math.sin(((i - a + 0.5) / (b - a)) * Math.PI), 0.6);
        out[i] = peak * shape * (0.55 + rnd() * 0.45);
      }
      t += len + (rnd() < 0.15 ? 0.12 + rnd() * 0.15 : rnd() * 0.04);
    }
  }
  return out;
}

export function HomeDemo({ roleName, lines, label, youLabel, originalLabel }: { roleName: string; lines: string[]; label: string; youLabel: string; originalLabel: string }) {
  const role: Role = useMemo(() => ({ id: "a", name: roleName, color: colorFor(0) }), [roleName]);
  const demoLines: Line[] = useMemo(
    () => LINES.map((l, i) => ({ id: String(i), roleId: "a", start: l.start, end: l.end, text: lines[l.text] })),
    [lines],
  );
  const reference = useMemo(() => ({ values: speech(7, 0, 1) }), []);
  const yours = useMemo(() => speech(19, 0.12, 0.85), []);

  // "Your" take appears as if being recorded right now, starting over with each loop.
  const live = useRef<Float32Array | null>(new Float32Array(yours.length));
  const lastT = useRef(0);
  useAnimationFrame(() => {
    const t = demoTime(), buf = live.current!;
    if (t < lastT.current) buf.fill(0);
    lastT.current = t;
    const upTo = Math.min(buf.length, Math.floor(t * ENV_RATE));
    for (let i = 0; i < upTo; i++) buf[i] = yours[i];
  });

  return (
    <section className="home-demo" aria-label={label}>
      <Caption lines={demoLines} roles={[role]} focusRoleId="a" time={demoTime} />
      <VoiceTrack
        reference={reference}
        mine={null}
        live={live}
        lines={demoLines}
        color={role.color}
        time={demoTime}
        labels={{ character: originalLabel, you: youLabel, measuring: "" }}
      />
    </section>
  );
}
