import Peer, { type DataConnection } from "peerjs";
import { create } from "zustand";
import { t } from "../i18n";
import { EFFECTS, type EffectId } from "../lib/audio/effects";
import { sceneMediaKeys, store } from "../lib/store";
import { playableRoles } from "../state/game";
import type { Pack, Scene } from "../lib/types";
import { Link, type FileMeta, type Json } from "./link";

/*
 * Online rooms. The host's browser is the authority: it owns the room state, streams the
 * selected scene (video, lines, backing track, original clips) to every guest, collects
 * recordings and relays them to everyone. Guests only send requests.
 *
 * Signalling goes through the public PeerJS server; media flows peer-to-peer over WebRTC.
 */

/** lobby: pick a scene and download it · casting: pick roles · recording: line by line · screening: the show and the vote. */
export type Phase = "lobby" | "casting" | "recording" | "screening";

export interface Player {
  id: string;
  name: string;
  host: boolean;
  roleId: string | null;
  /** Has the current scene's media locally. */
  ready: boolean;
  /** Download progress 0…1 while receiving the scene. */
  progress: number | null;
  /** Sent a recording this round. */
  submitted: boolean;
  /** Lines recorded so far this round (shown to others while they wait). */
  linesDone: number;
  online: boolean;
}

export interface Snapshot {
  code: string;
  phase: Phase;
  round: number;
  pack: { id: string; name: string; author?: string } | null;
  scene: Scene | null;
  players: Player[];
  /** voter id → role id. */
  votes: Record<string, string>;
  winners: string[] | null;
  /** Listed in "Find a game": strangers can join and roles are dealt at random. */
  public: boolean;
}

export interface RoundTake {
  roleId: string;
  blob: Blob;
  offset: number;
  effect: EffectId;
}

interface RoomState {
  status: "idle" | "connecting" | "open" | "error";
  /** Lost the link to the host; trying to get back without leaving the screen. */
  reconnecting: boolean;
  error: string | null;
  isHost: boolean;
  myId: string;
  snap: Snapshot | null;
  /** Bumped whenever recordings for the round arrive or change. */
  takesRev: number;
}

export const useRoom = create<RoomState>(() => ({ status: "idle", reconnecting: false, error: null, isHost: false, myId: "", snap: null, takesRev: 0 }));
const setRoom = (patch: Partial<RoomState>) => useRoom.setState(patch);

/* ---------- shared module state ---------- */

let peer: Peer | null = null;
const guests = new Map<string, Link>(); // host side
let hostLink: Link | null = null; // guest side
/** Host side: a player's secret key → their current peer id, so someone who drops can take their seat back. */
let keys = new Map<string, string>();

/* ---------- surviving a closed tab ---------- */

const KEY_STORE = "dubl-player-key";
const HOSTED_STORE = "dubl-hosted";
const LAST_STORE = "dubl-last-room";
const HOST_TAKE = "__host-take";
/** How long a dropped room can be returned to. */
const RESUME_MS = 20 * 60 * 1000;

let memoryKey = "";
/** A random secret per browser, sent only to the host. Proves "it's me again" after a reload. */
function playerKey(): string {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    let k = localStorage.getItem(KEY_STORE);
    if (!k) { k = make(); localStorage.setItem(KEY_STORE, k); }
    return k;
  } catch {
    return (memoryKey ||= make());
  }
}

const readJson = <T,>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) ?? "null") as T | null; } catch { return null; } };
const writeJson = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode / full */ } };
const forget = (key: string) => { try { localStorage.removeItem(key); } catch { /* private mode */ } };

interface Hosted { v: 1; savedAt: number; snap: Snapshot; keys: Array<[string, string]>; wantPublic: boolean; ownTake?: { roleId: string; offset: number; effect: EffectId; round: number } }
interface LastRoom { code: string; host: boolean; at: number; name: string; scene?: string }

function saveHosted() {
  const st = useRoom.getState();
  if (!st.isHost || !st.snap || st.status !== "open") return;
  const prev = readJson<Hosted>(HOSTED_STORE);
  writeJson(HOSTED_STORE, { v: 1, savedAt: Date.now(), snap: st.snap, keys: [...keys], wantPublic, ownTake: prev?.snap.code === st.snap.code ? prev.ownTake : undefined } satisfies Hosted);
  rememberRoom(true);
}
function rememberRoom(host: boolean) {
  const st = useRoom.getState();
  const me = st.snap?.players.find((p) => p.id === st.myId);
  if (st.snap) writeJson(LAST_STORE, { code: st.snap.code, host, at: Date.now(), name: me?.name ?? "", scene: st.snap.scene?.title } satisfies LastRoom);
}
window.addEventListener("pagehide", () => { saveHosted(); if (useRoom.getState().status === "open" && !useRoom.getState().isHost) rememberRoom(false); });

/** The room this browser was in recently and can go back to (after a closed tab or a crash). */
export function lastRoom(): LastRoom | null {
  const r = readJson<LastRoom>(LAST_STORE);
  if (!r || typeof r.code !== "string" || Date.now() - r.at > RESUME_MS) return null;
  if (r.host && !readJson<Hosted>(HOSTED_STORE)) return null;
  return r;
}
export const forgetLastRoom = () => { forget(LAST_STORE); forget(HOSTED_STORE); };
/** Recordings of the current round, by role. Kept on every device. */
export const roundTakes = new Map<string, RoundTake>();
const playListeners = new Set<() => void>();

export const onPlayAll = (fn: () => void) => { playListeners.add(fn); return () => playListeners.delete(fn); };
export const isOnline = () => useRoom.getState().status === "open";
export const me = (): Player | undefined => { const s = useRoom.getState(); return s.snap?.players.find((p) => p.id === s.myId); };

const PEER_PREFIX = "dubbo-room-";
/** Public rooms advertise themselves on one of these well-known ids so others can find them. */
export const PUBLIC_PREFIX = "dubbo-v1-pub-";
export const PUBLIC_SLOTS = 40;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);

const PEER_OPTIONS = {
  debug: 0,
  config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:global.stun.twilio.com:3478" }] },
};

/* Everything below that comes off the wire is from another player's browser, possibly a stranger's. */
const EFFECT_IDS = new Set<string>(EFFECTS.map((e) => e.id));
const asEffect = (v: unknown): EffectId => (EFFECT_IDS.has(String(v)) ? (v as EffectId) : "none");
const asOffset = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-600, Math.min(600, n)) : 0; };
const isRole = (s: Snapshot, roleId: string) => !!s.scene && playableRoles(s.scene).some((r) => r.id === roleId);
const isScene = (v: unknown): v is Scene => {
  const sc = v as Scene;
  return !!sc && typeof sc === "object" && typeof sc.id === "string" && Array.isArray(sc.roles) && Array.isArray(sc.lines);
};

function bumpTakes() {
  useRoom.setState((s) => ({ takesRev: s.takesRev + 1 }));
}

/* =====================================================================
 * Host
 * ===================================================================== */

let broadcastTimer = 0;

/** Mutate the snapshot and send it to everyone (throttled for chatty updates like progress). */
function hostUpdate(fn: (s: Snapshot) => void, throttle = false) {
  const cur = useRoom.getState().snap;
  if (!cur) return;
  const next = structuredClone(cur);
  fn(next);
  setRoom({ snap: next });
  saveHosted();
  const send = () => { broadcastTimer = 0; const snap = useRoom.getState().snap; guests.forEach((g) => g.send({ t: "state", snap })); };
  if (!throttle) { clearTimeout(broadcastTimer); send(); }
  else if (!broadcastTimer) broadcastTimer = window.setTimeout(send, 250);
}

/** Max players = roles in the scene (a 3-role scene takes the host plus two more). */
export const capacityOf = (s: Snapshot) => (s.scene ? playableRoles(s.scene).length : Infinity);
export const onlinePlayers = (s: Snapshot) => s.players.filter((p) => p.online);

let wantPublic = false;

export function createRoom(name: string, opts: { public?: boolean } = {}, attempt = 0) {
  leaveRoom();
  wantPublic = !!opts.public;
  const code = newCode();
  setRoom({ status: "connecting", error: null, isHost: true });
  const p = new Peer(PEER_PREFIX + code.toLowerCase(), PEER_OPTIONS);
  peer = p;
  p.on("open", (id) => {
    setRoom({
      status: "open",
      myId: id,
      snap: {
        code, phase: "lobby", round: 0, pack: null, scene: null, votes: {}, winners: null, public: false,
        players: [{ id, name, host: true, roleId: null, ready: true, progress: null, submitted: false, linesDone: 0, online: true }],
      },
    });
  });
  p.on("connection", (conn) => hostAccept(conn));
  p.on("error", (e) => {
    if (e.type === "unavailable-id" && attempt < 3) { createRoom(name, opts, attempt + 1); return; }
    if (useRoom.getState().status !== "open") setRoom({ status: "error", error: t().online.errNetwork });
  });
  p.on("disconnected", () => { try { p.reconnect(); } catch { /* destroyed */ } });
}

/**
 * The host closed the tab or crashed: reopen the same room from what was saved. Guests are
 * retrying in the background and take their seats back; whoever already sent a recording sends it again.
 */
export function resumeRoom(attempt = 0) {
  const saved = readJson<Hosted>(HOSTED_STORE);
  if (!saved || saved.v !== 1 || Date.now() - saved.savedAt > RESUME_MS) { forgetLastRoom(); return; }
  if (attempt === 0) {
    stopBeacon();
    try { peer?.destroy(); } catch { /* gone */ }
    setRoom({ status: "connecting", reconnecting: false, error: null, isHost: true, snap: null });
  }
  const code = saved.snap.code;
  const p = new Peer(PEER_PREFIX + code.toLowerCase(), PEER_OPTIONS);
  peer = p;
  p.on("open", async (id) => {
    keys = new Map(saved.keys);
    wantPublic = saved.wantPublic;
    const snap = structuredClone(saved.snap);
    roundTakes.clear();
    const own = saved.ownTake;
    const blob = own && own.round === snap.round ? await store.getMedia(HOST_TAKE) : null;
    if (own && blob) roundTakes.set(own.roleId, { roleId: own.roleId, blob, offset: own.offset, effect: own.effect });
    snap.players.forEach((pl) => {
      if (pl.host) {
        pl.online = true;
        // The host's unsent lines were in the closed tab.
        if (!blob && snap.phase === "recording") { pl.submitted = false; pl.linesDone = 0; }
      } else pl.online = false;
    });
    if (snap.phase === "lobby" || snap.phase === "casting") snap.players = snap.players.filter((pl) => pl.host);
    setRoom({ status: "open", myId: id, snap });
    bumpTakes();
    if (snap.public) startBeacon();
  });
  p.on("connection", (conn) => hostAccept(conn));
  p.on("error", (e) => {
    // The server frees the room's id a moment after the old tab is gone.
    if (e.type === "unavailable-id" && attempt < 20) { try { p.destroy(); } catch { /* gone */ } setTimeout(() => { if (peer === p) resumeRoom(attempt + 1); }, 3000); return; }
    if (useRoom.getState().status !== "open") setRoom({ status: "error", error: t().online.errNetwork });
  });
  p.on("disconnected", () => { try { p.reconnect(); } catch { /* destroyed */ } });
}

function hostAccept(conn: DataConnection) {
  const link = new Link(conn);
  link.onMessage = (msg) => hostHandle(link, msg);
  link.onFile = (meta, blob) => hostHandleFile(link, meta, blob);
  link.onClose = () => {
    if (!guests.has(link.peer)) return; // a rejected visitor
    guests.delete(link.peer);
    // A closed tab and a bad connection look the same: keep the seat (and role) for a while.
    hostUpdate((s) => { s.players.forEach((p) => { if (p.id === link.peer) p.online = false; }); });
    const id = link.peer;
    setTimeout(() => {
      const cur = useRoom.getState().snap;
      if (!cur || !(cur.phase === "lobby" || cur.phase === "casting")) return;
      if (cur.players.some((p) => p.id === id && !p.online)) hostUpdate((s) => { s.players = s.players.filter((p) => p.id !== id); });
    }, SEAT_HOLD_MS);
  };
}

function hostHandle(link: Link, msg: Json) {
  const id = link.peer;
  switch (msg.t) {
    case "hello": {
      const cur = useRoom.getState().snap!;
      const key = typeof msg.key === "string" ? msg.key.slice(0, 64) : "";
      const prevId = key ? keys.get(key) : undefined;
      // Same browser back after a closed tab or a crash: give them their seat (and role) back.
      const back = prevId && prevId !== id ? cur.players.find((p) => p.id === prevId && !p.online) : undefined;
      if (!back && !cur.players.some((p) => p.id === id)) {
        // No more players than roles; strangers can't drop into a game already under way.
        // Before the game, seats held for dropped players count too.
        const taken = cur.phase === "lobby" || cur.phase === "casting" ? cur.players.length : onlinePlayers(cur).length;
        if (taken >= capacityOf(cur)) return reject(link, "full");
        if (cur.public && cur.phase !== "lobby" && cur.phase !== "casting") return reject(link, "started");
      }
      guests.set(id, link);
      if (back) { const stale = guests.get(back.id); guests.delete(back.id); stale?.close(); }
      // Never let a second tab of the same browser steal a seat that's still in use.
      if (key && (back || !prevId || !cur.players.some((p) => p.id === prevId && p.online))) keys.set(key, id);
      const name = String(msg.name || "").slice(0, 30) || t().online.guest;
      hostUpdate((s) => {
        if (back) {
          const p = s.players.find((x) => x.id === back.id);
          if (p) p.id = id;
          if (s.votes[back.id] !== undefined) { s.votes[id] = s.votes[back.id]; delete s.votes[back.id]; }
        }
        const existing = s.players.find((p) => p.id === id);
        if (existing) { existing.name = name; existing.online = true; }
        else s.players.push({ id, name, host: false, roleId: null, ready: !s.scene, progress: null, submitted: false, linesDone: 0, online: true });
        // A newcomer takes a free seat; nobody else's role changes (no reshuffling by joining and leaving).
        if (s.public && s.phase === "casting") fillFreeRoles(s);
      });
      const snap = useRoom.getState().snap;
      if (snap?.scene) sendSceneOffer(link, snap);
      // Late joiner: hand over what was recorded so far.
      if (snap && snap.phase !== "lobby") roundTakes.forEach((tk) => sendTake(link, tk, snap.round));
      break;
    }
    case "need": {
      // Only the current scene's media, never other packs in the host's library.
      const scene = useRoom.getState().snap?.scene;
      if (!scene || !Array.isArray(msg.keys)) break;
      const allowed = new Set(sceneMediaKeys(scene));
      sendSceneMedia(link, [...new Set(msg.keys.map(String))].filter((k) => allowed.has(k)));
      break;
    }
      break;
    case "progress":
      hostUpdate((s) => { const p = s.players.find((x) => x.id === id); if (p) p.progress = Math.max(0, Math.min(1, Number(msg.p) || 0)); }, true);
      break;
    case "have":
      hostUpdate((s) => {
        const p = s.players.find((x) => x.id === id);
        if (p && s.scene?.id === msg.sceneId) { p.ready = true; p.progress = null; }
      });
      break;
    default:
      // Actions only from players who said hello and were let in.
      if (guests.get(id) === link) applyAction(id, msg);
  }
}

function reject(link: Link, reason: "full" | "started") {
  link.send({ t: "reject", reason });
  setTimeout(() => link.close(), 500);
}

/** Deal online players onto random roles (extra roles stay free). */
function dealRoles(s: Snapshot) {
  if (!s.scene) return;
  const roles = shuffle(playableRoles(s.scene).map((r) => r.id));
  s.players.forEach((p) => { p.roleId = null; });
  shuffle(onlinePlayers(s)).forEach((p, i) => { p.roleId = roles[i] ?? null; });
}

/** Give players without a role a random free one, leaving everyone else as they are. */
function fillFreeRoles(s: Snapshot) {
  if (!s.scene) return;
  const free = shuffle(playableRoles(s.scene).map((r) => r.id).filter((id) => !s.players.some((p) => p.roleId === id)));
  onlinePlayers(s).forEach((p) => { if (!p.roleId) p.roleId = free.shift() ?? null; });
}

/** A voice track is audio of scene length; anything bigger is not a recording. */
const MAX_TAKE = 64 * 1024 * 1024;

function hostHandleFile(link: Link, meta: FileMeta, blob: Blob) {
  const snap = useRoom.getState().snap;
  if (meta.kind !== "take" || blob.size > MAX_TAKE || !snap || (snap.phase !== "recording" && snap.phase !== "screening") || meta.round !== snap.round || guests.get(link.peer) !== link) return;
  // A player can only send the part they were cast in, not overwrite someone else's.
  const roleId = String(meta.roleId);
  if (snap.players.find((p) => p.id === link.peer)?.roleId !== roleId) return;
  const take: RoundTake = { roleId, blob, offset: asOffset(meta.offset), effect: asEffect(meta.effect) };
  hostAcceptTake(link.peer, take);
}

function hostAcceptTake(playerId: string, take: RoundTake) {
  const snap = useRoom.getState().snap!;
  if (playerId === useRoom.getState().myId) {
    store.putMedia(HOST_TAKE, take.blob);
    const h = readJson<Hosted>(HOSTED_STORE);
    if (h) writeJson(HOSTED_STORE, { ...h, ownTake: { roleId: take.roleId, offset: take.offset, effect: take.effect, round: snap.round } });
  }
  roundTakes.set(take.roleId, take);
  bumpTakes();
  guests.forEach((g) => { if (g.peer !== playerId) sendTake(g, take, snap.round); });
  hostUpdate((s) => {
    const p = s.players.find((x) => x.id === playerId);
    if (p) p.submitted = true;
    // Everyone with a role has sent their part → go watch.
    // Everyone cast has sent their part → go watch. A player who dropped without sending holds the
    // show (they may come back); the host can start it anyway.
    const cast = s.players.filter((x) => x.roleId);
    if (s.phase === "recording" && cast.length && cast.every((x) => x.submitted)) s.phase = "screening";
  });
}

function sendTake(link: Link, take: RoundTake, round: number) {
  link.sendFile({ kind: "take", round, roleId: take.roleId, offset: take.offset, effect: take.effect }, take.blob);
}

async function sendSceneOffer(link: Link, snap: Snapshot) {
  const scene = snap.scene!;
  const files: Array<{ key: string; size: number }> = [];
  for (const key of sceneMediaKeys(scene)) {
    const b = await store.getMedia(key);
    if (b) files.push({ key, size: b.size });
  }
  link.send({ t: "scene", pack: snap.pack, scene, files });
}

async function sendSceneMedia(link: Link, keys: string[]) {
  for (const key of keys) {
    const b = await store.getMedia(key);
    if (b) await link.sendFile({ kind: "media", key }, b);
  }
}

/** Actions any player can request; executed by the host. */
function applyAction(playerId: string, msg: Json) {
  switch (msg.t) {
    case "pick":
      hostUpdate((s) => {
        if (s.phase !== "casting" || s.public) return; // public rooms deal roles at random
        const roleId = msg.roleId ? String(msg.roleId) : null;
        if (roleId && !isRole(s, roleId)) return;
        if (roleId && s.players.some((p) => p.roleId === roleId && p.id !== playerId)) return; // taken
        const p = s.players.find((x) => x.id === playerId);
        if (p) p.roleId = roleId;
      });
      break;
    case "random":
      hostUpdate((s) => {
        if (s.phase !== "casting") return;
        if (s.public && !s.players.find((p) => p.id === playerId)?.host) return;
        dealRoles(s);
      });
      break;
    case "reset":
      hostUpdate((s) => { if (s.phase === "casting" && !s.public) s.players.forEach((p) => { p.roleId = null; }); });
      break;
    case "vote":
      hostUpdate((s) => {
        const roleId = String(msg.roleId);
        const voter = s.players.find((p) => p.id === playerId);
        if (s.phase !== "screening" || !voter || !isRole(s, roleId) || voter.roleId === roleId) return; // no voting for yourself
        if (s.votes[playerId] === roleId) delete s.votes[playerId];
        else s.votes[playerId] = roleId;
      });
      break;
    case "lines":
      hostUpdate((s) => {
        const p = s.players.find((x) => x.id === playerId);
        if (s.phase !== "recording" || !p?.roleId) return;
        const total = s.scene?.lines.filter((l) => l.roleId === p.roleId).length ?? 0;
        p.linesDone = Math.max(0, Math.min(total, Math.floor(Number(msg.n) || 0)));
      }, true);
      break;
    case "effect": {
      // Only the voice's owner picks its effect.
      const owner = useRoom.getState().snap?.players.find((p) => p.id === playerId);
      const tk = roundTakes.get(String(msg.roleId));
      if (!tk || !owner || owner.roleId !== tk.roleId) return;
      tk.effect = asEffect(msg.effect);
      bumpTakes();
      guests.forEach((g) => { if (g.peer !== playerId) g.send({ t: "effect", roleId: tk.roleId, effect: tk.effect }); });
      break;
    }
  }
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/* ---------- host controls ---------- */

export async function hostSelectScene(pack: Pack, sceneId: string) {
  const scene = pack.scenes.find((s) => s.id === sceneId);
  const cur = useRoom.getState().snap;
  if (!scene || !cur || cur.phase !== "lobby" || playableRoles(scene).length < onlinePlayers(cur).length) return;
  const prevRoles = useRoom.getState().snap?.scene?.roles.map((r) => r.id).join() ?? "";
  hostUpdate((s) => {
    s.pack = { id: pack.id, name: pack.name, author: pack.author };
    s.scene = scene;
    s.players.forEach((p) => {
      if (!p.host) { p.ready = false; p.progress = 0; }
      if (prevRoles !== scene.roles.map((r) => r.id).join()) p.roleId = null;
    });
  });
  const snap = useRoom.getState().snap!;
  guests.forEach((g) => sendSceneOffer(g, snap));
  if (wantPublic && !snap.public) hostSetPublic(true);
}

/* ---------- public listing ---------- */

let beacon: Peer | null = null;

export interface PublicRoomInfo {
  v: 1;
  code: string;
  host: string;
  pack: string;
  scene: string;
  players: number;
  capacity: number;
  phase: Phase;
  lang: string;
}

function beaconInfo(): PublicRoomInfo | null {
  const s = useRoom.getState().snap;
  if (!s?.scene || !s.public) return null;
  return {
    v: 1, code: s.code, host: s.players.find((p) => p.host)?.name ?? "", pack: s.pack?.name ?? "", scene: s.scene.title,
    players: onlinePlayers(s).length, capacity: capacityOf(s), phase: s.phase, lang: document.documentElement.lang,
  };
}

/** Claim a free public slot and answer "who's there?" probes with this room's details. */
function startBeacon() {
  if (beacon) return;
  const slots = shuffle([...Array(PUBLIC_SLOTS).keys()]);
  const claim = (i: number) => {
    if (i >= slots.length || !useRoom.getState().snap?.public) return;
    const b = new Peer(PUBLIC_PREFIX + slots[i], PEER_OPTIONS);
    beacon = b;
    b.on("error", (e) => {
      if (e.type === "unavailable-id" && beacon === b) { b.destroy(); beacon = null; claim(i + 1); }
    });
    b.on("connection", (conn) => {
      conn.on("open", () => {
        const info = beaconInfo();
        if (info) conn.send(JSON.stringify(info));
        setTimeout(() => conn.close(), 1500);
      });
    });
    b.on("disconnected", () => { try { b.reconnect(); } catch { /* destroyed */ } });
  };
  claim(0);
}

function stopBeacon() {
  try { beacon?.destroy(); } catch { /* gone */ }
  beacon = null;
}

export function hostSetPublic(on: boolean) {
  const cur = useRoom.getState().snap;
  if (!cur || (on && !cur.scene)) return;
  wantPublic = on;
  hostUpdate((s) => {
    s.public = on;
    if (on && s.phase === "casting") dealRoles(s);
  });
  if (on) startBeacon();
  else stopBeacon();
}

/** Everyone has the scene: move on to picking roles. */
export function hostCast() {
  hostUpdate((s) => {
    if (s.phase !== "lobby" || !s.scene || !onlinePlayers(s).every((p) => p.ready)) return;
    s.phase = "casting";
    if (s.public) dealRoles(s);
  });
}

/** Every player has a role: recording starts on all devices. */
export function hostStart() {
  const cur = useRoom.getState().snap;
  if (!cur || cur.phase !== "casting" || !everyoneCast(cur)) return;
  roundTakes.clear();
  bumpTakes();
  hostUpdate((s) => {
    s.phase = "recording";
    s.round++;
    s.votes = {};
    s.winners = null;
    s.players.forEach((p) => { p.submitted = false; p.linesDone = 0; });
  });
}

/** Every role is voiced by someone here: the dub has no holes and no original voices. */
export const everyoneCast = (s: Snapshot) =>
  !!s.scene && onlinePlayers(s).every((p) => p.roleId && p.ready) &&
  playableRoles(s.scene).every((r) => onlinePlayers(s).some((p) => p.roleId === r.id));
/** Players still missing for every role to be taken. */
export const playersNeeded = (s: Snapshot) => Math.max(0, capacityOf(s) - onlinePlayers(s).length);

export const hostToScreening = () => hostUpdate((s) => { s.phase = "screening"; });
export const hostToLobby = () => hostUpdate((s) => {
  s.phase = "lobby";
  s.votes = {};
  s.winners = null;
  s.players = s.players.filter((p) => p.online);
});

export function hostReveal() {
  hostUpdate((s) => {
    const counts = voteCounts(s);
    const max = Math.max(0, ...Object.values(counts));
    s.winners = max > 0 ? Object.keys(counts).filter((k) => counts[k] === max) : [];
  });
}

export function hostPlayAll() {
  guests.forEach((g) => g.send({ t: "play" }));
  playListeners.forEach((f) => f());
}

export function voteCounts(s: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const roleId of Object.values(s.votes)) out[roleId] = (out[roleId] ?? 0) + 1;
  return out;
}

/* =====================================================================
 * Guest
 * ===================================================================== */

interface Download { sceneId: string; pack: Snapshot["pack"]; scene: Scene; waiting: Set<string>; total: number; done: number }
let download: Download | null = null;
let lastProgressSent = 0;

/** Before a game starts, a dropped player's seat is kept this long, then freed for someone else. */
const SEAT_HOLD_MS = 60_000;
/** How long a guest keeps trying to get back to a host that vanished (network blip, host reloading). */
const RECONNECT_MS = 90_000;
/** A connection that hasn't opened by now is retried (the signalling server sometimes drops the first try). */
const OPEN_TIMEOUT = 8000;

export function joinRoom(code: string, name: string) {
  leaveRoom();
  code = normalizeCode(code);
  setRoom({ status: "connecting", error: null, isHost: false });
  const p = new Peer(PEER_OPTIONS);
  peer = p;
  const key = playerKey();
  const timeout = setTimeout(() => {
    if (useRoom.getState().status === "connecting") { setRoom({ status: "error", error: t().online.errNotFound }); peer?.destroy(); }
  }, 35000);
  let attempts = 0;
  let giveUpAt = 0;
  let retryTimer = 0;
  const alive = () => peer === p && !p.destroyed;
  const retryLater = () => {
    clearTimeout(retryTimer);
    if (!alive()) return;
    const st = useRoom.getState();
    if (st.reconnecting && Date.now() > giveUpAt) {
      setRoom({ status: "error", reconnecting: false, error: t().online.errHostLeft, snap: null });
      return;
    }
    retryTimer = window.setTimeout(connect, st.reconnecting ? 3000 : 2000);
  };
  const lostHost = () => {
    if (!alive()) return;
    const st = useRoom.getState();
    if (st.status === "open" && !st.reconnecting) { setRoom({ reconnecting: true }); giveUpAt = Date.now() + RECONNECT_MS; }
    if (useRoom.getState().reconnecting || st.status === "connecting") retryLater();
  };
  function connect() {
    if (!alive()) return;
    if (p.disconnected) { try { p.reconnect(); } catch { /* destroyed */ } }
    const old = hostLink;
    hostLink = null;
    old?.close();
    const conn = p.connect(PEER_PREFIX + code.toLowerCase(), { serialization: "raw", reliable: true });
    const link = new Link(conn);
    hostLink = link;
    const openTimer = setTimeout(() => { if (hostLink === link && !conn.open) lostHost(); }, OPEN_TIMEOUT);
    conn.on("open", () => { clearTimeout(openTimer); link.send({ t: "hello", name, key }); });
    link.onMessage = (msg) => { clearTimeout(timeout); guestHandle(msg); };
    link.onFile = (meta, blob) => guestHandleFile(meta, blob);
    link.onFileProgress = (meta, received) => {
      if (meta.kind !== "media" || !download) return;
      const total = download.total || 1;
      const p01 = Math.min(1, (download.done + received) / total);
      if (performance.now() - lastProgressSent > 300) { lastProgressSent = performance.now(); link.send({ t: "progress", p: p01 }); }
    };
    link.onClose = () => { clearTimeout(openTimer); if (hostLink === link) lostHost(); };
  }
  p.on("open", (id) => { setRoom({ myId: id }); connect(); });
  p.on("disconnected", () => { try { p.reconnect(); } catch { /* destroyed */ } });
  p.on("error", (e) => {
    // The host isn't reachable (yet): a fresh room the server hasn't seen, or a host that's reloading.
    if (e.type === "peer-unavailable" && (useRoom.getState().reconnecting || (attempts++ < 14 && useRoom.getState().status === "connecting"))) {
      retryLater();
      return;
    }
    if (useRoom.getState().reconnecting) { retryLater(); return; }
    clearTimeout(timeout);
    setRoom({ status: "error", error: e.type === "peer-unavailable" ? t().online.errNotFound : t().online.errNetwork });
  });
}

function guestHandle(msg: Json) {
  switch (msg.t) {
    case "state": {
      const snap = cleanSnapshot(msg.snap);
      if (!snap) break;
      const st = useRoom.getState();
      const prev = st.snap;
      if (prev && snap.round !== prev.round) { roundTakes.clear(); bumpTakes(); }
      setRoom({ status: "open", reconnecting: false, snap });
      rememberRoom(false);
      // Back after a drop: the host may have restarted and lost my recording, so send it again.
      if (st.reconnecting && (snap.phase === "recording" || snap.phase === "screening")) {
        const me = snap.players.find((p) => p.id === st.myId);
        const mine = me?.roleId ? roundTakes.get(me.roleId) : undefined;
        if (mine) hostLink?.sendFile({ kind: "take", round: snap.round, roleId: mine.roleId, offset: mine.offset, effect: mine.effect }, mine.blob);
      }
      break;
    }
    case "bye":
      // The host closed the room on purpose: no point waiting.
      setRoom({ status: "error", reconnecting: false, error: t().online.errHostLeft, snap: null });
      forget(LAST_STORE);
      break;
    case "scene":
      if (!isScene(msg.scene) || !Array.isArray(msg.files)) break;
      guestOffer(msg.pack as Snapshot["pack"], msg.scene, msg.files as Array<{ key: string; size: number }>);
      break;
    case "effect": {
      const tk = roundTakes.get(String(msg.roleId));
      if (tk) { tk.effect = asEffect(msg.effect); bumpTakes(); }
      break;
    }
    case "play":
      playListeners.forEach((f) => f());
      break;
    case "reject":
      setRoom({ status: "error", error: msg.reason === "full" ? t().online.errFull : t().online.errStarted, snap: null });
      hostLink = null;
      setTimeout(() => { try { peer?.destroy(); } catch { /* gone */ } }, 100);
      break;
  }
}

/** The host may be a stranger: keep only a well-formed snapshot so a bad one can't break the page. */
function cleanSnapshot(v: unknown): Snapshot | null {
  const s = v as Snapshot;
  if (!s || typeof s !== "object" || !Array.isArray(s.players) || !Number.isFinite(s.round)) return null;
  if (!["lobby", "casting", "recording", "screening"].includes(s.phase)) return null;
  if (s.scene != null && !isScene(s.scene)) return null;
  if (s.scene && !s.scene.lines.every((l) => l && typeof l.id === "string" && Number.isFinite(l.start) && Number.isFinite(l.end))) return null;
  const str = (x: unknown, n: number) => String(x ?? "").slice(0, n);
  return {
    ...s,
    code: str(s.code, 5),
    votes: s.votes && typeof s.votes === "object" ? s.votes : {},
    winners: Array.isArray(s.winners) ? s.winners.map((w) => str(w, 64)) : null,
    public: !!s.public,
    players: s.players.slice(0, 64).filter((p) => p && typeof p === "object").map((p) => ({
      id: str(p.id, 64),
      name: str(p.name, 30),
      host: !!p.host,
      roleId: p.roleId == null ? null : str(p.roleId, 64),
      ready: !!p.ready,
      progress: p.progress == null ? null : Math.max(0, Math.min(1, Number(p.progress) || 0)),
      submitted: !!p.submitted,
      linesDone: Math.max(0, Math.floor(Number(p.linesDone) || 0)),
      online: !!p.online,
    })),
  };
}

async function guestOffer(pack: Snapshot["pack"], scene: Scene, files: Array<{ key: string; size: number }>) {
  // Accept only the files this scene actually uses.
  const wanted = new Set(sceneMediaKeys(scene));
  const missing: Array<{ key: string; size: number }> = [];
  for (const f of files) {
    if (!f || !wanted.has(String(f.key))) continue;
    if (!(await store.getMedia(String(f.key)))) missing.push({ key: String(f.key), size: Math.max(0, Number(f.size) || 0) });
  }
  download = { sceneId: scene.id, pack, scene, waiting: new Set(missing.map((f) => f.key)), total: missing.reduce((n, f) => n + f.size, 0), done: 0 };
  if (!missing.length) return finishDownload();
  hostLink?.send({ t: "need", keys: missing.map((f) => f.key) });
}

async function guestHandleFile(meta: FileMeta, blob: Blob) {
  if (meta.kind === "media" && download?.waiting.has(String(meta.key))) {
    await store.putMedia(String(meta.key), blob);
    download.waiting.delete(String(meta.key));
    download.done += blob.size;
    if (!download.waiting.size) await finishDownload();
  } else if (meta.kind === "take" && blob.size <= MAX_TAKE) {
    const snap = useRoom.getState().snap;
    if (snap && meta.round !== snap.round) return;
    if (!snap || !isRole(snap, String(meta.roleId))) return;
    roundTakes.set(String(meta.roleId), { roleId: String(meta.roleId), blob, offset: asOffset(meta.offset), effect: asEffect(meta.effect) });
    bumpTakes();
  }
}

/** Save the received scene into a local copy of the host's pack so it also works offline later. */
async function finishDownload() {
  const d = download;
  if (!d || !d.pack) return;
  download = null;
  const existing = await store.getPack(d.pack.id);
  const copy: Pack = existing ?? { id: d.pack.id, name: d.pack.name, author: d.pack.author, scenes: [], updated: Date.now() };
  copy.scenes = [...copy.scenes.filter((s) => s.id !== d.scene.id), d.scene];
  await store.putPack(copy);
  hostLink?.send({ t: "have", sceneId: d.sceneId });
}

/* =====================================================================
 * Actions available to everyone
 * ===================================================================== */

function request(msg: Json) {
  const s = useRoom.getState();
  if (s.isHost) applyAction(s.myId, msg);
  else hostLink?.send(msg);
}

export const pickRole = (roleId: string | null) => request({ t: "pick", roleId });
export const randomizeRoles = () => request({ t: "random" });
export const resetRoles = () => request({ t: "reset" });
export const vote = (roleId: string) => request({ t: "vote", roleId });
/** How many of my lines are recorded, so others see how far along I am. */
export const reportLines = (n: number) => request({ t: "lines", n });

export function submitTake(take: RoundTake) {
  const s = useRoom.getState();
  if (!s.snap) return;
  if (s.isHost) { hostAcceptTake(s.myId, take); return; }
  roundTakes.set(take.roleId, take);
  bumpTakes();
  hostLink?.sendFile({ kind: "take", round: s.snap.round, roleId: take.roleId, offset: take.offset, effect: take.effect }, take.blob);
}

export function setTakeEffect(roleId: string, effect: EffectId) {
  const tk = roundTakes.get(roleId);
  if (tk) { tk.effect = effect; bumpTakes(); }
  request({ t: "effect", roleId, effect });
}

export function leaveRoom() {
  stopBeacon();
  wantPublic = false;
  if (useRoom.getState().status !== "idle") forgetLastRoom();
  guests.forEach((g) => { g.send({ t: "bye" }); });
  const closing = [...guests.values()];
  setTimeout(() => closing.forEach((g) => g.close()), 300);
  keys = new Map();
  guests.clear();
  hostLink?.close();
  hostLink = null;
  download = null;
  roundTakes.clear();
  try { peer?.destroy(); } catch { /* already gone */ }
  peer = null;
  setRoom({ status: "idle", reconnecting: false, error: null, isHost: false, myId: "", snap: null });
}

export function inviteLink(code: string) {
  if (location.protocol === "file:") return null;
  return `${location.origin}${location.pathname}?room=${code}`;
}
