import { decodeBlob, type MixTrack } from "../lib/audio/engine";
import type { EffectId } from "../lib/audio/effects";
import { store } from "../lib/store";
import type { Pack, RecordedTrack, Role, Scene } from "../lib/types";

/**
 * This device's view of one online round: the scene, who voices which role,
 * and every recording received so far.
 */
export interface Game {
  pack: Pack;
  scene: Scene;
  round: number;
  videoUrl: string;
  bg: AudioBuffer | null;
  /** clip media key → decoded original line. */
  clips: Record<string, AudioBuffer>;
  /** roleId → player name, for roles somebody took. */
  cast: Record<string, string>;
  /** roleId → recording. */
  tracks: Record<string, RecordedTrack>;
  /** roleId → voice effect. Non-destructive: applied at playback and export. */
  effects: Record<string, EffectId>;
  /** The role this device records, or null for a spectator. */
  myRoleId: string | null;
}

export async function createGame(opts: {
  pack: Pack;
  scene: Scene;
  round: number;
  cast: Record<string, string>;
  myRoleId: string | null;
}): Promise<{ game: Game; warnings: string[] } | null> {
  const { scene } = opts;
  const videoUrl = await store.mediaUrl(scene.id);
  if (!videoUrl) return null;
  const warnings: string[] = [];
  const decode = async (key?: string) => {
    const b = await store.getMedia(key);
    if (!b) return null;
    try { return await decodeBlob(b); } catch { warnings.push(key!); return null; }
  };
  const clips: Record<string, AudioBuffer> = {};
  for (const key of new Set(scene.lines.map((l) => l.clip).filter((k): k is string => !!k))) {
    const buf = await decode(key);
    if (buf) clips[key] = buf;
  }
  const bg = await decode(scene.bg);
  return { game: { ...opts, videoUrl, bg, clips, tracks: {}, effects: {} }, warnings };
}

/** Roles somebody is voicing, in scene order. */
export const castRoles = (g: Game): Role[] => g.scene.roles.filter((r) => g.cast[r.id]);
export const effectOf = (g: Game, roleId: string): EffectId => g.effects[roleId] ?? "none";

/**
 * What plays under the scene: players' recordings (with effects), the pack's original lines
 * for roles nobody took, and the backing track. `exclude` leaves one role out (while recording it).
 */
export function mixFor(g: Game, exclude: string | null = null): MixTrack[] {
  const out: MixTrack[] = [];
  for (const r of castRoles(g)) {
    const t = g.tracks[r.id];
    if (t && r.id !== exclude) out.push({ buffer: t.buffer, offset: t.offset, bus: "voice", effect: effectOf(g, r.id) });
  }
  for (const l of g.scene.lines) {
    const buf = l.clip ? g.clips[l.clip] : undefined;
    if (buf && !g.cast[l.roleId]) out.push({ buffer: buf, offset: -l.start, bus: "lines" });
  }
  if (g.bg) out.push({ buffer: g.bg, offset: 0, bus: "bg" });
  return out;
}

/** The pack's own voices, for comparison. */
export function originalMix(g: Game): MixTrack[] {
  const out: MixTrack[] = [];
  for (const l of g.scene.lines) {
    const buf = l.clip ? g.clips[l.clip] : undefined;
    if (buf) out.push({ buffer: buf, offset: -l.start, bus: "lines" });
  }
  if (g.bg) out.push({ buffer: g.bg, offset: 0, bus: "bg" });
  return out;
}

export const hasAnyRecording = (g: Game | null) => !!g && Object.keys(g.tracks).length > 0;
