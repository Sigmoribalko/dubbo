export const uid = (): string =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const ROLE_COLORS = ["#f2a516", "#4cc9a6", "#ff7b95", "#ffb3c7", "#c08bff", "#ffd84d", "#8ee06b", "#ff9d5c"];
export const colorFor = (i: number) => ROLE_COLORS[i % ROLE_COLORS.length];

/** Only allow plain hex colours from imported packs: they end up in inline styles. */
export const safeColor = (c: unknown, fallback: string) =>
  typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback;

export const fmtTime = (t: number) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  return m + ":" + (t % 60).toFixed(1).padStart(4, "0");
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const safeFileName = (s: string) => String(s || "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const MIME: Record<string, string> = {
  ogv: "video/ogg", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
};
export const VIDEO_EXT = ["ogv", "mp4", "webm", "mov", "m4v", "mkv"];
export const AUDIO_EXT = ["ogg", "mp3", "wav", "m4a", "opus", "flac", "aac", "oga"];

export const extOf = (p: string) => {
  const b = p.split("/").pop() ?? "";
  return b.includes(".") ? (b.split(".").pop() ?? "").toLowerCase() : "";
};
export const baseOf = (p: string) => p.split("/").pop() ?? "";
export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const stemOf = (p: string) => baseOf(p).replace(/\.[^.]+$/, "");

/** Re-wrap a file with a MIME type derived from its extension when the browser didn't provide one. */
export const withMime = (blob: Blob, ext: string): Blob =>
  MIME[ext] && blob.type !== MIME[ext] ? new Blob([blob], { type: MIME[ext] }) : blob;
