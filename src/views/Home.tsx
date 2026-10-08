import { useMemo, useState } from "react";
import { Band } from "../components/Band";
import { useT } from "../i18n";
import { colorFor, prefersReducedMotion } from "../lib/util";
import { normalizeCode } from "../net/room";
import { useApp } from "../state/app";

const DEMO_TIMING = [
  { roleId: "a", start: 0.6, end: 2.6 },
  { roleId: "b", start: 3, end: 5 },
  { roleId: "c", start: 5.4, end: 6.8 },
  { roleId: "a", start: 7.2, end: 9.6 },
  { roleId: "c", start: 10, end: 12.4 },
  { roleId: "b", start: 12.8, end: 15 },
];
const demoStart = performance.now();
const demoTime = () => (prefersReducedMotion() ? 3.6 : ((performance.now() - demoStart) / 1000) % 16);

/** Two ways in: play with strangers, or with your own friends. */
export function Home() {
  const t = useT();
  const h = t.home;
  const go = useApp((s) => s.go);
  const [code, setCode] = useState("");
  const demo = useMemo(() => ({
    roles: h.demo.roles.map((name, i) => ({ id: "abc"[i], name, color: colorFor(i) })),
    lines: DEMO_TIMING.map((l, i) => ({ ...l, id: String(i), text: h.demo.lines[i] })),
  }), [h]);

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

      <Band lines={demo.lines} roles={demo.roles} duration={16} time={demoTime} label={h.demoLabel} />

      <section aria-labelledby="how-h">
        <h3 id="how-h" className="section-kicker">{h.howTitle}</h3>
        <ol className="steps">
          {h.steps.map(([title, text]) => <li key={title}><b>{title}</b><span className="muted">{text}</span></li>)}
        </ol>
      </section>
    </div>
  );
}
