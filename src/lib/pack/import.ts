import JSZip from "jszip";
import { t } from "../../i18n";
import { store } from "../store";
import type { Line, Pack, Role, Scene } from "../types";
import { AUDIO_EXT, MIME, VIDEO_EXT, baseOf, colorFor, dirOf, extOf, safeColor, stemOf, uid, withMime } from "../util";
import { cfgPick, cleanText, linesFromJson, looksLikeCfg, parseCfg, parseSubtitles, toNums, toStrs, type RawLine } from "./parsers";

/** A file from a folder pick, a multi-select or the inside of a ZIP. */
interface Entry {
  path: string;
  size: number;
  blob(): Promise<Blob>;
  text(): Promise<string>;
}

export class ImportError extends Error {
  constructor(public kind: "rar" | "zip" | "novideo", public paths: string[] = []) {
    super(kind);
  }
}

async function entriesFrom(files: File[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const f of files) {
    const p = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    const e = extOf(p);
    if (e === "zip" || e === "dubpack") {
      let zip: JSZip;
      try { zip = await JSZip.loadAsync(f); } catch { throw new ImportError("zip"); }
      const root = stemOf(f.name);
      zip.forEach((rp, zf) => {
        if (zf.dir) return;
        const inner = rp.replace(/\\/g, "/");
        out.push({
          path: root + "/" + inner,
          size: (zf as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
          blob: async () => new Blob([await zf.async("arraybuffer")], { type: MIME[extOf(inner)] ?? "" }),
          text: () => zf.async("string"),
        });
      });
    } else if (e === "rar" || e === "7z") {
      throw new ImportError("rar");
    } else {
      out.push({ path: p, size: f.size, blob: async () => withMime(f, e), text: () => f.text() });
    }
  }
  return out.filter((x) => !/(^|\/)(__MACOSX\/|\.)/.test(x.path));
}

function audioDuration(blob: Blob): Promise<number | null> {
  return new Promise((res) => {
    const a = new Audio();
    const u = URL.createObjectURL(blob);
    let done = false;
    const fin = (v: number | null) => { if (done) return; done = true; URL.revokeObjectURL(u); res(v); };
    a.preload = "metadata";
    a.onloadedmetadata = () => fin(isFinite(a.duration) ? a.duration : null);
    a.onerror = () => fin(null);
    setTimeout(() => fin(null), 4000);
    a.src = u;
  });
}

async function readSceneDir(dir: string, es: Entry[]): Promise<{ scene: Scene; author: string }> {
  const vids = es.filter((e) => VIDEO_EXT.includes(extOf(e.path)));
  const video = vids.find((e) => stemOf(e.path).toLowerCase() === "dub_video") ?? [...vids].sort((a, b) => b.size - a.size)[0];
  const find = (pred: (stem: string, ext: string) => boolean) => es.filter((e) => pred(stemOf(e.path).toLowerCase(), extOf(e.path)));
  const ext = extOf(video.path);
  const s: Scene = { id: uid(), title: baseOf(dir) || stemOf(video.path), ext, mediaType: MIME[ext] ?? "video/mp4", duration: 0, roles: [], lines: [] };
  let author = "";

  for (const e of find((st) => st.startsWith("_pack_info") || st === "pack_info")) {
    try {
      const c = parseCfg(await e.text());
      const t = cfgPick(c, ["title", "name"]);
      if (t) s.title = cleanText(t);
      const a = cfgPick(c, ["authors", "author"]);
      if (a) author = toStrs(a).join(", ");
    } catch { /* ignore malformed info */ }
  }
  for (const e of find((st, ex) => st === "_title" && ["txt", ""].includes(ex))) { const t = cleanText(await e.text()); if (t) s.title = t; }
  for (const e of find((st, ex) => st === "_author" && ["txt", ""].includes(ex))) { const t = cleanText(await e.text()); if (t && !author) author = t; }

  await store.putMedia(s.id, await video.blob());

  const bg = find((st, ex) => st === "_backing_track" && AUDIO_EXT.includes(ex))[0];
  if (bg) { s.bg = s.id + "_bg"; s.bgExt = extOf(bg.path); await store.putMedia(s.bg, await bg.blob()); }

  // Clip-per-line packs (The Choicer Voicer / Dub Together): NAME.ogg + NAME.ini|txt
  const groups = new Map<string, { audio?: Entry; ini?: Entry; txt?: Entry }>();
  for (const e of es) {
    const st = stemOf(e.path), ex = extOf(e.path);
    if (st.startsWith("_") || e === video) continue;
    const g = groups.get(st) ?? {};
    groups.set(st, g);
    if (AUDIO_EXT.includes(ex)) g.audio = g.audio && ex !== "wav" ? g.audio : e;
    else if (["ini", "cfg", "tres"].includes(ex)) g.ini = e;
    else if (ex === "txt") g.txt = e;
  }
  const raw: RawLine[] = [];
  let clipIndex = 0;
  for (const [stem, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    if (!g.ini && !g.txt) continue;
    let cfg: ReturnType<typeof parseCfg> = {};
    let caption = "";
    if (g.ini) try { cfg = parseCfg(await g.ini.text()); } catch { /* ignore */ }
    if (g.txt) {
      const t = await g.txt.text();
      if (looksLikeCfg(t) && /dub_|timestamp|caption/i.test(t)) { try { cfg = { ...parseCfg(t), ...cfg }; } catch { /* ignore */ } }
      else caption = cleanText(t);
    }
    const starts = toNums(cfgPick(cfg, ["dub_timestamps", "dub_timestamp", "timestamps", "timestamp", "dub_times", "start", "time"]));
    if (!starts.length) continue;
    const ends = toNums(cfgPick(cfg, ["dub_ends", "dub_end", "ends", "end"]));
    let chars = toStrs(cfgPick(cfg, ["dub_characters", "dub_character", "characters", "character", "speaker", "role"]));
    const cap = cfgPick(cfg, ["caption", "text", "subtitle", "line"]);
    if (cap != null && String(cap).trim()) caption = cleanText(Array.isArray(cap) ? cap.join(" ") : cap);
    const m = caption.match(/^\[([^\]]{1,40})\]\s*(.*)$/s);
    if (m) { if (!chars.length) chars = [m[1]]; caption = m[2]; }
    let clip: string | undefined;
    let dur: number | null = null;
    if (g.audio) {
      clip = `${s.id}_c${clipIndex++}`;
      const b = await g.audio.blob();
      await store.putMedia(clip, b);
      dur = await audioDuration(b);
    }
    const text = caption || stem.replace(/^\d+[_\s-]*/, "").replace(/[_-]+/g, " ");
    starts.forEach((t, k) => raw.push({ start: t, end: ends[k] ?? (dur ? t + dur : null), role: chars[0] ?? "", text, clip }));
  }

  if (!raw.length) {
    for (const e of es.filter((e) => ["srt", "vtt"].includes(extOf(e.path)))) {
      raw.push(...parseSubtitles(await e.text()));
      if (raw.length) break;
    }
  }
  if (!raw.length) {
    for (const e of es.filter((e) => extOf(e.path) === "json")) {
      try {
        const ls = linesFromJson(JSON.parse(await e.text()));
        if (ls?.length) { raw.push(...ls); break; }
      } catch { /* not JSON we understand */ }
    }
  }

  raw.sort((a, b) => a.start - b.start);
  raw.forEach((l, k) => {
    const next = raw.slice(k + 1).find((x) => x.start > l.start);
    if (l.end == null || l.end <= l.start) l.end = Math.min(l.start + 8, next ? next.start : l.start + 3);
    if (l.end - l.start < 0.4) l.end = l.start + 0.4;
  });

  const roleIds = new Map<string, string>();
  const roleFor = (name: string) => {
    name = name.trim() || t().importer.defaultVoice;
    let id = roleIds.get(name);
    if (!id) {
      id = uid();
      roleIds.set(name, id);
      s.roles.push({ id, name, color: colorFor(s.roles.length) });
    }
    return id;
  };
  s.lines = raw.map((l): Line => ({ id: uid(), roleId: roleFor(l.role), start: +l.start.toFixed(3), end: +l.end!.toFixed(3), text: l.text || "", clip: l.clip }));
  if (!s.roles.length) s.roles.push({ id: uid(), name: t().editor.defaultRole(1), color: colorFor(0) });
  return { scene: s, author };
}

interface OwnPackJson {
  format: "dubl-pack";
  name?: string;
  author?: string;
  scenes?: Array<Partial<Scene> & { file: string; bgFile?: string; lines?: Array<Partial<Line> & { clipFile?: string }> }>;
}

async function importOwn(meta: OwnPackJson, entries: Entry[], root: string): Promise<Pack> {
  const get = (p?: string) => (p ? entries.find((e) => e.path === (root ? root + "/" : "") + p) : undefined);
  const pack: Pack = { id: uid(), name: String(meta.name || t().common.pack), author: String(meta.author || ""), scenes: [], updated: Date.now() };
  for (const s of meta.scenes ?? []) {
    const vf = get(s.file);
    if (!vf) continue;
    const roleMap: Record<string, string> = {};
    const roles: Role[] = (s.roles ?? []).map((r, i) => {
      const id = uid();
      roleMap[r.id] = id;
      return { id, name: String(r.name ?? t().common.role), color: safeColor(r.color, colorFor(i)) };
    });
    if (!roles.length) roles.push({ id: uid(), name: t().editor.defaultRole(1), color: colorFor(0) });
    const ext = String(s.ext || extOf(s.file) || "mp4");
    const ns: Scene = { id: uid(), title: String(s.title ?? t().common.scene), mediaType: String(s.mediaType || MIME[ext] || "video/mp4"), ext, duration: Number(s.duration) || 0, roles, lines: [] };
    await store.putMedia(ns.id, await vf.blob());
    const bgEntry = get(s.bgFile);
    if (bgEntry) { ns.bg = ns.id + "_bg"; ns.bgExt = extOf(s.bgFile!); await store.putMedia(ns.bg, await bgEntry.blob()); }
    const clipMap: Record<string, string> = {};
    let ci = 0;
    for (const l of s.lines ?? []) {
      let clip: string | undefined;
      const ce = get(l.clipFile);
      if (ce && l.clipFile) {
        if (!clipMap[l.clipFile]) {
          clipMap[l.clipFile] = `${ns.id}_c${ci++}`;
          await store.putMedia(clipMap[l.clipFile], await ce.blob());
        }
        clip = clipMap[l.clipFile];
      }
      const start = Math.max(0, Number(l.start) || 0);
      ns.lines.push({ id: uid(), roleId: roleMap[l.roleId ?? ""] ?? roles[0].id, start, end: Math.max(start + 0.1, Number(l.end) || 0), text: String(l.text ?? ""), clip });
    }
    pack.scenes.push(ns);
  }
  return pack;
}

/** Import packs from picked files, a folder or ZIP archives. Saves them and returns the new packs. */
export async function importFiles(files: File[]): Promise<Pack[]> {
  const entries = await entriesFrom(files);
  const fallbackName = files.length === 1 ? stemOf(files[0].name) : (files[0]?.webkitRelativePath || "").split("/")[0];

  let packs: Pack[] | null = null;
  const own = entries.find((e) => baseOf(e.path) === "pack.json");
  if (own) {
    try {
      const meta = JSON.parse(await own.text()) as OwnPackJson;
      if (meta.format === "dubl-pack") packs = [await importOwn(meta, entries, dirOf(own.path))];
    } catch { /* not ours — try the folder layout */ }
  }
  if (!packs) {
    const byDir = new Map<string, Entry[]>();
    for (const e of entries) {
      const d = dirOf(e.path);
      byDir.set(d, [...(byDir.get(d) ?? []), e]);
    }
    const sceneDirs = [...byDir].filter(([, es]) => es.some((e) => VIDEO_EXT.includes(extOf(e.path))));
    if (sceneDirs.length) {
      const scenes: Scene[] = [];
      let author = "";
      for (const [d, es] of sceneDirs) {
        const r = await readSceneDir(d, es);
        if (r.author && !author) author = r.author;
        scenes.push(r.scene);
      }
      packs = [{ id: uid(), name: scenes.length === 1 ? scenes[0].title : fallbackName || t().importer.defaultPackName, author, scenes, updated: Date.now() }];
    }
  }
  if (!packs || !packs.some((p) => p.scenes.length)) throw new ImportError("novideo", entries.map((e) => e.path));
  for (const p of packs) await store.putPack(p);
  return packs;
}
