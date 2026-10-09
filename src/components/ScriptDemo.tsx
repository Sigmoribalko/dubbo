import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/util";

/** One line of the demo script: who speaks, when (seconds), which text. */
const SCRIPT = [
  { role: 0, start: 0.6, end: 2.6, text: 0 },
  { role: 1, start: 3.0, end: 5.0, text: 1 },
  { role: 2, start: 5.4, end: 6.8, text: 2 },
  { role: 0, start: 7.2, end: 9.6, text: 3 },
  { role: 2, start: 10.0, end: 12.4, text: 4 },
  { role: 1, start: 12.8, end: 15.0, text: 5 },
];
const LENGTH = 16;
const FPS = 24;
/** Where the clip "starts" on the studio timeline, so timecodes look real. */
const OFFSET = 3 * 60 + 41;

const timecode = (sec: number) => {
  const s = sec + OFFSET;
  const f = Math.floor((s % 1) * FPS);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
};

interface Props {
  roles: string[];
  lines: string[];
  scene: string;
  take: string;
  label: string;
}

/**
 * A dubbing "cue sheet" that reads itself: timecodes, character names and lines, with the
 * current line marked as it's being spoken.
 */
export function ScriptDemo({ roles, lines, scene, take, label }: Props) {
  const [t, setT] = useState(3.6);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const start = performance.now();
    const id = setInterval(() => setT(((performance.now() - start) / 1000) % LENGTH), 1000 / FPS);
    return () => clearInterval(id);
  }, []);

  return (
    <figure className="script" aria-label={label}>
      <figcaption className="script-head">
        <span>{scene}</span>
        <span>{take}</span>
        <span className="script-rec"><i aria-hidden="true" />REC {timecode(t)}</span>
      </figcaption>
      <ol className="script-lines">
        {SCRIPT.map((l, i) => {
          const text = lines[l.text];
          const state = t >= l.end ? "done" : t >= l.start ? "now" : "next";
          const shown = state === "now" ? Math.ceil(((t - l.start) / (l.end - l.start)) * text.length) : state === "done" ? text.length : 0;
          return (
            <li key={i} className={state}>
              <span className="script-tc">{timecode(l.start)}</span>
              <span className="script-who">{roles[l.role]}</span>
              <span className="script-say">
                <mark>{text.slice(0, shown)}</mark>
                {text.slice(shown)}
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
