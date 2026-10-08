import { prefersReducedMotion } from "../lib/util";
import { settings } from "../state/settings";

const CONFETTI_COLORS = ["#b5e32b", "#e8452c", "#f2a516", "#4cc9a6", "#ff7b95", "#c08bff", "#ffd84d"];

/** A burst of coloured paper pieces (plain CSS shapes). */
export function confetti() {
  if (prefersReducedMotion()) return;
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 34; i++) {
    const s = document.createElement("span");
    const a = Math.random() * Math.PI * 2, r = 120 + Math.random() * 220;
    s.style.setProperty("--x", `${Math.cos(a) * r}px`);
    s.style.setProperty("--y", `${Math.sin(a) * r - 80}px`);
    s.style.setProperty("--r", `${Math.random() * 720 - 360}deg`);
    s.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    if (i % 3 === 0) s.style.borderRadius = "50%";
    s.style.animationDelay = `${Math.random() * 0.15}s`;
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 1700);
}

let sfx: AudioContext | null = null;
/** Short UI beep for the countdown. Uses its own context so it never ends up in a recording mix. */
export function beep(freq = 660, dur = 0.12, vol = 0.12) {
  vol *= settings().ui / 100;
  if (vol <= 0) return;
  try {
    sfx ??= new AudioContext();
    const o = sfx.createOscillator(), g = sfx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, sfx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, sfx.currentTime + dur);
    o.connect(g).connect(sfx.destination);
    o.start();
    o.stop(sfx.currentTime + dur);
  } catch { /* audio unavailable */ }
}
