import type { Line, RecordedTrack } from "../types";

/*
 * Line-by-line recording: every line is its own short take. On "submit" the takes are laid out
 * on the scene timeline and rendered into one voice track, so the rest of the game (sending,
 * mixing, export) keeps dealing with a single recording per role.
 */

/** Recording window around a line: some lead-in to catch the cue, a tail for late finishes. */
export const REC_PRE = 1.5;
export const REC_POST = 0.8;
/** What is kept of each take on the final track. Neighbouring windows are split halfway. */
const KEEP_PRE = 0.4;
const KEEP_POST = 0.8;
const FADE = 0.02;
const RATE = 24000;

export function recordWindow(line: Line, duration: number): [number, number] {
  return [Math.max(0, line.start - REC_PRE), Math.min(duration, line.end + REC_POST)];
}

/** Render this role's line takes (track time = video time + offset) into one voice track starting at 0. */
export async function composeLines(lines: Line[], takes: Record<string, RecordedTrack>, duration: number): Promise<RecordedTrack> {
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  const length = Math.max(1, Math.ceil((duration + 1) * RATE));
  const oc = new OfflineAudioContext(1, length, RATE);
  sorted.forEach((l, i) => {
    const tk = takes[l.id];
    if (!tk) return;
    const prev = sorted[i - 1], next = sorted[i + 1];
    let a = Math.max(0, l.start - KEEP_PRE, prev ? (prev.end + l.start) / 2 : 0);
    const b = Math.min(duration + 1, l.end + KEEP_POST, next ? (l.end + next.start) / 2 : Infinity);
    let from = a + tk.offset;
    if (from < 0) { a -= from; from = 0; }
    const dur = Math.min(b - a, tk.buffer.duration - from);
    if (dur <= FADE * 2) return;
    const src = oc.createBufferSource();
    src.buffer = tk.buffer;
    const g = oc.createGain();
    g.gain.setValueAtTime(0, a);
    g.gain.linearRampToValueAtTime(1, a + FADE);
    g.gain.setValueAtTime(1, a + dur - FADE);
    g.gain.linearRampToValueAtTime(0, a + dur);
    src.connect(g).connect(oc.destination);
    src.start(a, from, dur);
  });
  const buffer = await oc.startRendering();
  return { blob: encodeWav(buffer), buffer, offset: 0 };
}

/** 16-bit PCM mono WAV. */
function encodeWav(buf: AudioBuffer): Blob {
  const data = buf.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + data.length * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  out.setUint32(4, 36 + data.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const x = Math.max(-1, Math.min(1, data[i]));
    out.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}
