import { useMemo, useRef, useState } from "react";
import { useAnimationFrame } from "../components/useAnimationFrame";
import { VoiceTrack } from "../components/VoiceTrack";
import { ENV_RATE } from "../lib/audio/envelope";
import { Caption } from "./Caption";
import { useT } from "../i18n";
import { colorFor, prefersReducedMotion } from "../lib/util";
import { normalizeCode } from "../net/room";
import { useApp } from "../state/app";

/** The demo character's lines (seconds) and texts index into `home.demo.lines`. */
const DEMO_LINES = [
  { start: 0.6, end: 2.6, text: 0 },
  { start: 4.2, end: 6.4, text: 3 },
  { start: 8.4, end: 9.8, text: 2 },
  { start: 11.6, end: 14.4, text: 5 },
];
const DEMO_LENGTH = 16;
const demoStart = performance.now();
const demoTime = () => (prefersReducedMotion() ? 1.6 : ((performance.now() - demoStart) / 1000) % DEMO_LENGTH);

/** A speech-like loudness envelope: syllables of varying strength inside each line. */
function synthVoice(seed: number, shift: number, scale: number): Float32Array {
  const out = new Float32Array(DEMO_LENGTH * ENV_RATE);
  let r = seed;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (const l of DEMO_LINES) {
    let t = l.start + shift;
    while (t < l.end + shift - 0.05) {
      const len = 0.12 + rnd() * 0.16;
      const peak = (0.04 + rnd() * 0.22) * scale;
      const a = Math.round(t * ENV_RATE), b = Math.min(out.length, Math.round((t + len) * ENV_RATE));
      for (let i = a; i < b; i++) out[i] = peak * Math.sin(((i - a + 0.5) / (b - a)) * Math.PI);
      t += len + rnd() * 0.06;
    }
  }
  return out;
}

/** Two ways in: play with strangers, or with your own friends. */
export function Home() {
  const t = useT();
  const h = t.home;
  const go = useApp((s) => s.go);
  const [code, setCode] = useState("");
  const demo = useMemo(() => ({
    role: { id: "a", name: h.demo.roles[0], color: colorFor(0) },
    lines: DEMO_LINES.map((l, i) => ({ id: String(i), roleId: "a", start: l.start, end: l.end, text: h.demo.lines[l.text] })),
  }), [h]);
  const reference = useMemo(() => ({ values: synthVoice(7, 0, 1) }), []);
  const yours = useMemo(() => synthVoice(11, 0.1, 0.9), []);

  // "Your voice" appears as if being recorded right now, restarting with each loop.
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
    <div className="wrap stack home">
      <header className="hero">
        <h1>{h.title}</h1>
        <p>{h.lead}</p>
      </header>

      <div className="mode-cards">
        <button className="mode-card mode-find" onClick={() => go({ name: "online", intent: "find" })}>
          <span className="mode-kicker">{h.findKicker}</span>
          <span className="mode-title">{h.findGame}</span>
          <span className="mode-text">{h.findText}</span>
          <span className="mode-cta">{h.findCta} <span aria-hidden="true">→</span></span>
        </button>

        <section className="mode-card mode-friends" aria-labelledby="friends-h">
          <span className="mode-kicker">{h.friendsKicker}</span>
          <h2 className="mode-title" id="friends-h">{h.friendsTitle}</h2>
          <span className="mode-text">{h.friendsText}</span>
          <form className="code-form" onSubmit={(e) => { e.preventDefault(); if (code.length === 5) go({ name: "online", code }); }}>
            <input
              className="code-input" value={code} onChange={(e) => setCode(normalizeCode(e.target.value))}
              placeholder="K7MXQ" aria-label={t.online.joinTitle}
              autoCapitalize="characters" autoComplete="off" spellCheck={false} inputMode="text"
            />
            <button className="dark" disabled={code.length !== 5}>{t.online.join}</button>
          </form>
          <button className="link on-color" onClick={() => go({ name: "online", intent: "create" })}>{h.createRoom}</button>
        </section>
      </div>

      <section className="demo panel stack" aria-label={h.demoLabel}>
        <Caption lines={demo.lines} roles={[demo.role]} focusRoleId="a" time={demoTime} />
        <VoiceTrack
          reference={reference}
          mine={null}
          live={live}
          lines={demo.lines}
          color={demo.role.color}
          time={demoTime}
          labels={{ character: t.record.trackCharacter(demo.role.name), you: t.record.trackYou, measuring: "" }}
        />
      </section>

      <section aria-labelledby="how-h">
        <h3 id="how-h" className="section-kicker">{h.howTitle}</h3>
        <ol className="steps">
          {h.steps.map(([title, text]) => <li key={title}><b>{title}</b><span className="muted">{text}</span></li>)}
        </ol>
      </section>
    </div>
  );
}
