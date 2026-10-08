/* Readers for line/timing formats found in community dub packs:
   Godot ConfigFile (.ini/.cfg/.tres), SRT/VTT subtitles and loosely structured JSON. */

type CfgValue = string | number | boolean | null | CfgValue[] | { [k: string]: CfgValue };
export type CfgSection = Record<string, CfgValue>;

/** Tolerant Godot ConfigFile parser: sections, quoted strings, arrays, dicts and constructor calls like PackedFloat32Array(…). */
export function parseCfg(input: string): Record<string, CfgValue> {
  const text = String(input).replace(/^﻿/, "");
  const n = text.length;
  const out: Record<string, CfgValue> = {};
  let sec: Record<string, CfgValue> = out;
  let i = 0;

  const ws = () => {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else if (c === ";" || c === "#") { while (i < n && text[i] !== "\n") i++; }
      else break;
    }
  };
  const list = (close: string): CfgValue[] => {
    const a: CfgValue[] = [];
    for (let guard = 0; guard < 1e5; guard++) {
      ws();
      if (i >= n) break;
      if (text[i] === close) { i++; break; }
      a.push(val());
      ws();
      if (text[i] === ",") i++;
    }
    return a;
  };
  const val = (): CfgValue => {
    ws();
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      let s = "";
      while (i < n && text[i] !== c) {
        if (text[i] === "\\" && i + 1 < n) {
          i++;
          const e = text[i++];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else s += text[i++];
      }
      i++;
      return s;
    }
    if (c === "[") { i++; return list("]"); }
    if (c === "{") {
      i++;
      const o: Record<string, CfgValue> = {};
      for (let guard = 0; guard < 1e5; guard++) {
        ws();
        if (i >= n) break;
        if (text[i] === "}") { i++; break; }
        const k = String(val());
        ws();
        if (text[i] === ":") i++;
        o[k] = val();
        ws();
        if (text[i] === ",") i++;
      }
      return o;
    }
    let s = "";
    while (i < n && !/[\s,\]})(]/.test(text[i])) s += text[i++];
    if (text[i] === "(") { i++; return list(")"); }
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null") return null;
    const num = Number(s);
    return s !== "" && !isNaN(num) ? num : s;
  };

  while (i < n) {
    ws();
    if (i >= n) break;
    if (text[i] === "[") {
      const j = text.indexOf("]", i);
      if (j < 0) break;
      const name = text.slice(i + 1, j).trim();
      const existing = out[name];
      sec = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, CfgValue>) : (out[name] = {}) as Record<string, CfgValue>;
      i = j + 1;
      continue;
    }
    let k = "";
    while (i < n && text[i] !== "=" && text[i] !== "\n") k += text[i++];
    if (text[i] !== "=") { i++; continue; }
    i++;
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
    const c = text[i];
    const nl = text.indexOf("\n", i);
    const eol = nl < 0 ? n : nl;
    const raw = text.slice(i, eol).trim();
    const key = k.trim();
    try {
      if (raw.startsWith('""') && raw.endsWith('""') && raw.length >= 4) {
        sec[key] = raw.slice(2, -2).replace(/""/g, '"');
        i = eol;
        continue;
      }
      const structured = c === '"' || c === "'" || c === "[" || c === "{" || /^[A-Za-z_]\w*\(/.test(raw) ||
        /^-?[\d.]+(e-?\d+)?$/i.test(raw) || raw === "true" || raw === "false";
      if (structured) sec[key] = val();
      else { sec[key] = raw; i = eol; }
    } catch {
      i = eol;
    }
    while (i < n && text[i] !== "\n") i++;
  }
  return out;
}

/** First value under any of `keys` (case-insensitive), searching the root and then each section. */
export function cfgPick(cfg: Record<string, CfgValue>, keys: string[]): CfgValue | undefined {
  const sections = [cfg, ...Object.values(cfg).filter((v): v is Record<string, CfgValue> => !!v && typeof v === "object" && !Array.isArray(v))];
  for (const s of sections) for (const k of Object.keys(s)) if (keys.includes(k.toLowerCase().trim())) return s[k];
  return undefined;
}

export const looksLikeCfg = (t: string) => /^\s*(\[[^\]\n]+\]|[A-Za-z_]+\s*=)/m.test(t) && /=/.test(t);

/** Seconds from a number, "12.5", "1:02.5" or "00:01:02,500". */
export function parseTime(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const s = v.trim().replace(",", ".");
  if (/^-?[\d.]+$/.test(s)) return parseFloat(s);
  const m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  return m ? +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : NaN;
}

export const toNums = (v: CfgValue | undefined): number[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return (v.flat(3) as unknown[]).map(parseTime).filter((x) => !isNaN(x));
  if (typeof v === "string") return v.split(/[,;\s]+/).map(parseTime).filter((x) => !isNaN(x));
  const x = parseTime(v);
  return isNaN(x) ? [] : [x];
};

export const toStrs = (v: CfgValue | undefined): string[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return (v.flat(3) as unknown[]).map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
};

export function cleanText(t: unknown): string {
  return String(t ?? "")
    .replace(/\r/g, "")
    .trim()
    .replace(/^[“”«»"']+|[“”«»"']+$/g, "")
    .replace(/""/g, '"')
    .trim();
}

export interface RawLine {
  start: number;
  end: number | null;
  role: string;
  text: string;
  clip?: string;
}

export function parseSubtitles(text: string): RawLine[] {
  const out: RawLine[] = [];
  for (const block of String(text).replace(/\r/g, "").split(/\n\s*\n/)) {
    const ls = block.split("\n").map((x) => x.trim()).filter(Boolean);
    const ti = ls.findIndex((x) => x.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = ls[ti].split("-->").map((x) => parseTime(x.trim().split(/\s+/)[0]));
    if (isNaN(a)) continue;
    let txt = ls.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    let role = "";
    const m = txt.match(/^\[([^\]]{1,40})\]\s*(.*)$/) || txt.match(/^([^:]{1,30}):\s+(.*)$/);
    if (m) { role = m[1].trim(); txt = m[2]; }
    out.push({ start: a, end: isNaN(b) ? a + 2 : b, role, text: txt });
  }
  return out;
}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

/** Find the most line-like array of objects anywhere in a JSON document. */
export function linesFromJson(doc: Json): RawLine[] | null {
  const idNames = new Map<string, string>();
  const scanIds = (v: Json) => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (isObj(x) && x.id != null) {
          const nm = x.name ?? x.title;
          if (typeof nm === "string") idNames.set(String(x.id), nm);
        }
      }
      v.forEach(scanIds);
    } else if (isObj(v)) Object.values(v).forEach(scanIds);
  };
  scanIds(doc);

  const norm = (o: Record<string, Json>): RawLine | null => {
    const k: Record<string, Json> = {};
    for (const [a, b] of Object.entries(o)) k[a.toLowerCase().replace(/[\s-]/g, "_")] = b;
    const num = (names: string[]) => {
      for (const x of names) if (k[x] != null && typeof k[x] !== "object") { const t = parseTime(k[x]); if (!isNaN(t)) return t; }
      return null;
    };
    const str = (names: string[]) => {
      for (const x of names) { const v = k[x]; if (typeof v === "string" && v.trim()) return v; }
      return "";
    };
    const start = num(["start", "start_time", "starttime", "begin", "from", "time", "timestamp", "t", "in", "start_ms", "startms", "start_sec"]);
    if (start == null) return null;
    let end = num(["end", "end_time", "endtime", "stop", "to", "out", "end_ms", "endms", "end_sec"]);
    const dur = num(["duration", "dur", "length"]);
    if (end == null && dur != null) end = start + dur;
    let role = str(["character", "role", "speaker", "actor", "char", "voice", "character_name", "role_name", "speaker_name", "name"]);
    for (const x of ["character", "role", "speaker"]) {
      const v = k[x];
      if (!role && isObj(v) && typeof v.name === "string") role = v.name;
    }
    if (!role) {
      const idKey = ["character_id", "characterid", "role_id", "roleid", "speaker_id", "speakerid", "character", "role", "speaker"]
        .find((x) => k[x] != null && typeof k[x] !== "object" && idNames.has(String(k[x])));
      if (idKey) role = idNames.get(String(k[idKey])) ?? "";
    }
    const text = str(["text", "line", "caption", "subtitle", "dialogue", "content", "transcript", "sentence", "words"]);
    return { start, end, role, text };
  };

  let best: RawLine[] | null = null;
  const walk = (v: Json) => {
    if (Array.isArray(v)) {
      const objs = v.filter(isObj);
      if (objs.length && objs.length >= v.length * 0.6) {
        const ls = objs.map(norm).filter((x): x is RawLine => !!x);
        if (ls.length >= Math.max(1, objs.length * 0.6) && (!best || ls.length > best.length)) best = ls;
      }
      v.forEach(walk);
    } else if (isObj(v)) Object.values(v).forEach(walk);
  };
  walk(doc);
  const found = best as RawLine[] | null;
  if (!found) return null;
  // Values that large are almost certainly milliseconds.
  const max = Math.max(...found.map((l) => Math.max(l.start, l.end ?? 0)));
  if (max > 1500) found.forEach((l) => { l.start /= 1000; if (l.end != null) l.end /= 1000; });
  return found;
}
