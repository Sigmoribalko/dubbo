import JSZip from "jszip";
import { saveFile } from "../download";
import { store } from "../store";
import type { Pack } from "../types";
import { safeFileName } from "../util";

const clipExt = (type: string) => (type.includes("mpeg") ? "mp3" : type.includes("wav") ? "wav" : type.includes("mp4") ? "m4a" : "ogg");

/** Bundle a pack (media + pack.json) into a ZIP that `importFiles` can read back. */
export async function exportPack(p: Pack) {
  const zip = new JSZip();
  const scenes = [];
  for (const s of p.scenes) {
    const video = await store.getMedia(s.id);
    if (!video) continue;
    const file = `media/${s.id}.${s.ext || "mp4"}`;
    zip.file(file, video);
    const { bg: _bg, lines: _lines, ...rest } = s;
    const out: Record<string, unknown> = { ...rest, file, lines: [] as unknown[] };
    if (s.bg) {
      const b = await store.getMedia(s.bg);
      if (b) { out.bgFile = `media/${s.bg}.${s.bgExt || "ogg"}`; zip.file(out.bgFile as string, b); }
    }
    const written: Record<string, string> = {};
    for (const l of s.lines) {
      const { clip, ...line } = l;
      const L: Record<string, unknown> = { ...line };
      if (clip) {
        if (!written[clip]) {
          const b = await store.getMedia(clip);
          if (b) { written[clip] = `media/${clip}.${clipExt(b.type || "")}`; zip.file(written[clip], b); }
        }
        if (written[clip]) L.clipFile = written[clip];
      }
      (out.lines as unknown[]).push(L);
    }
    scenes.push(out);
  }
  zip.file("pack.json", JSON.stringify({ format: "dubl-pack", version: 2, name: p.name, author: p.author ?? "", scenes }, null, 1));
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return saveFile(safeFileName(p.name || "pack") + ".zip", blob);
}
