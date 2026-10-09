import Peer, { type DataConnection } from "peerjs";
import { create } from "zustand";
import { t } from "../i18n";
import { EFFECTS, type EffectId } from "../lib/audio/effects";
import { sceneMediaKeys, store } from "../lib/store";
import type { Pack, Scene } from "../lib/types";
import { Link, type FileMeta, type Json } from "./link";

/*
 * Online rooms. The host's browser is the authority: it owns the room state, streams the
 * selected scene (video, lines, backing track, original clips) to every guest, collects
 * recordings and relays them to everyone. Guests only send requests.
 *
 * Signalling goes through the public PeerJS server; media flows peer-to-peer over WebRTC.
 */

export type Phase = "lobby" | "recording" | "screening";

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
  error: string | null;
  isHost: boolean;
  myId: string;
  snap: Snapshot | null;
  /** Bumped whenever recordings for the round arrive or change. */
  takesRev: number;
}

export const useRoom = create<RoomState>(() => ({ status: "idle", error: null, isHost: false, myId: "", snap: null, takesRev: 0 }));
const setRoom = (patch: Partial<RoomState>) => useRoom.setState(patch);

/* ---------- shared module state ---------- */

let peer: Peer | null = null;
const guests = new Map<string, Link>(); // host side
let hostLink: Link | null = null; // guest side
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
const isRole = (s: Snapshot, roleId: string) => !!s.scene?.roles.some((r) => r.id === roleId);
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
  const send = () => { broadcastTimer = 0; const snap = useRoom.getState().snap; guests.forEach((g) => g.send({ t: "state", snap })); };
  if (!throttle) { clearTimeout(broadcastTimer); send(); }
  else if (!broadcastTimer) broadcastTimer = window.setTimeout(send, 250);
}

/** Max players = roles in the scene (a 3-role scene takes the host plus two more). */
export const capacityOf = (s: Snapshot) => s.scene?.roles.length ?? Infinity;
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
        players: [{ id, name, host: true, roleId: null, ready: true, progress: null, submitted: false, online: true }],
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

function hostAccept(conn: DataConnection) {
  const link = new Link(conn);
  link.onMessage = (msg) => hostHandle(link, msg);
  link.onFile = (meta, blob) => hostHandleFile(link, meta, blob);
  link.onClose = () => {
    if (!guests.has(link.peer)) return; // a rejected visitor
    guests.delete(link.peer);
    hostUpdate((s) => {
      if (s.phase === "lobby") {
        s.players = s.players.filter((p) => p.id !== link.peer);
        if (s.public) dealRoles(s);
      } else s.players.forEach((p) => { if (p.id === link.peer) p.online = false; });
    });
  };
}

function hostHandle(link: Link, msg: Json) {
  const id = link.peer;
  switch (msg.t) {
    case "hello": {
      const cur = useRoom.getState().snap!;
      if (!cur.players.some((p) => p.id === id)) {
        // No more players than roles; strangers can't drop into a game already under way.
        if (onlinePlayers(cur).length >= capacityOf(cur)) return reject(link, "full");
        if (cur.public && cur.phase !== "lobby") return reject(link, "started");
      }
      guests.set(id, link);
      const name = String(msg.name || "").slice(0, 30) || t().online.guest;
      hostUpdate((s) => {
        const existing = s.players.find((p) => p.id === id);
        if (existing) { existing.name = name; existing.online = true; }
        else s.players.push({ id, name, host: false, roleId: null, ready: !s.scene, progress: null, submitted: false, online: true });
        if (s.public && s.phase === "lobby") dealRoles(s);
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
  const roles = shuffle(s.scene.roles.map((r) => r.id));
  s.players.forEach((p) => { p.roleId = null; });
  shuffle(onlinePlayers(s)).forEach((p, i) => { p.roleId = roles[i] ?? null; });
}

function hostHandleFile(link: Link, meta: FileMeta, blob: Blob) {
  const snap = useRoom.getState().snap;
  if (meta.kind !== "take" || !snap || snap.phase === "lobby" || meta.round !== snap.round || guests.get(link.peer) !== link) return;
  // A player can only send the part they were cast in, not overwrite someone else's.
  const roleId = String(meta.roleId);
  if (snap.players.find((p) => p.id === link.peer)?.roleId !== roleId) return;
  const take: RoundTake = { roleId, blob, offset: asOffset(meta.offset), effect: asEffect(meta.effect) };
  hostAcceptTake(link.peer, take);
}

function hostAcceptTake(playerId: string, take: RoundTake) {
  const snap = useRoom.getState().snap!;
  roundTakes.set(take.roleId, take);
  bumpTakes();
  guests.forEach((g) => { if (g.peer !== playerId) sendTake(g, take, snap.round); });
  hostUpdate((s) => {
    const p = s.players.find((x) => x.id === playerId);
    if (p) p.submitted = true;
    // Everyone with a role has sent their part → go watch.
    const cast = s.players.filter((x) => x.roleId && x.online);
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
        if (s.phase !== "lobby" || s.public) return; // public rooms deal roles at random
        const roleId = msg.roleId ? String(msg.roleId) : null;
        if (roleId && !isRole(s, roleId)) return;
        if (roleId && s.players.some((p) => p.roleId === roleId && p.id !== playerId)) return; // taken
        const p = s.players.find((x) => x.id === playerId);
        if (p) p.roleId = roleId;
      });
      break;
    case "random":
      hostUpdate((s) => {
        if (s.phase !== "lobby") return;
        if (s.public && !s.players.find((p) => p.id === playerId)?.host) return;
        dealRoles(s);
      });
      break;
    case "reset":
      hostUpdate((s) => { if (s.phase === "lobby" && !s.public) s.players.forEach((p) => { p.roleId = null; }); });
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
  if (!scene || !cur || scene.roles.length < onlinePlayers(cur).length) return;
  const prevRoles = useRoom.getState().snap?.scene?.roles.map((r) => r.id).join() ?? "";
  hostUpdate((s) => {
    s.pack = { id: pack.id, name: pack.name, author: pack.author };
    s.scene = scene;
    s.players.forEach((p) => {
      if (!p.host) { p.ready = false; p.progress = 0; }
      if (prevRoles !== scene.roles.map((r) => r.id).join()) p.roleId = null;
    });
    if (s.public) dealRoles(s);
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
    if (on && s.phase === "lobby") dealRoles(s);
  });
  if (on) startBeacon();
  else stopBeacon();
}

export function hostStart() {
  roundTakes.clear();
  bumpTakes();
  hostUpdate((s) => {
    s.phase = "recording";
    s.round++;
    s.votes = {};
    s.winners = null;
    s.players.forEach((p) => { p.submitted = false; });
  });
}

export const hostToScreening = () => hostUpdate((s) => { s.phase = "screening"; });
export const hostToLobby = () => hostUpdate((s) => { s.phase = "lobby"; s.votes = {}; s.winners = null; });

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

export function joinRoom(code: string, name: string) {
  leaveRoom();
  code = normalizeCode(code);
  setRoom({ status: "connecting", error: null, isHost: false });
  const p = new Peer(PEER_OPTIONS);
  peer = p;
  const timeout = setTimeout(() => {
    if (useRoom.getState().status === "connecting") { setRoom({ status: "error", error: t().online.errNotFound }); peer?.destroy(); }
  }, 35000);
  let attempts = 0;
  const connect = () => {
    hostLink?.close();
    const conn = p.connect(PEER_PREFIX + code.toLowerCase(), { serialization: "raw", reliable: true });
    const link = new Link(conn);
    hostLink = link;
    conn.on("open", () => link.send({ t: "hello", name }));
    link.onMessage = (msg) => { clearTimeout(timeout); guestHandle(msg); };
    link.onFile = (meta, blob) => guestHandleFile(meta, blob);
    link.onFileProgress = (meta, received) => {
      if (meta.kind !== "media" || !download) return;
      const total = download.total || 1;
      const p01 = Math.min(1, (download.done + received) / total);
      if (performance.now() - lastProgressSent > 300) { lastProgressSent = performance.now(); link.send({ t: "progress", p: p01 }); }
    };
    link.onClose = () => {
      if (hostLink === link && useRoom.getState().status === "open") setRoom({ status: "error", error: t().online.errHostLeft, snap: null });
    };
  };
  p.on("open", (id) => { setRoom({ myId: id }); connect(); });
  p.on("error", (e) => {
    // The signalling server sometimes needs a moment to see a fresh room: retry before giving up.
    if (e.type === "peer-unavailable" && attempts++ < 14 && useRoom.getState().status === "connecting") {
      setTimeout(connect, 2000);
      return;
    }
    clearTimeout(timeout);
    setRoom({ status: "error", error: e.type === "peer-unavailable" ? t().online.errNotFound : t().online.errNetwork });
  });
}

function guestHandle(msg: Json) {
  switch (msg.t) {
    case "state": {
      const snap = msg.snap as Snapshot;
      if (!snap || typeof snap !== "object" || !Array.isArray(snap.players) || typeof snap.round !== "number") break;
      const prev = useRoom.getState().snap;
      if (prev && snap.round !== prev.round) { roundTakes.clear(); bumpTakes(); }
      setRoom({ status: "open", snap });
      break;
    }
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
  } else if (meta.kind === "take") {
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
  guests.forEach((g) => g.close());
  guests.clear();
  hostLink?.close();
  hostLink = null;
  download = null;
  roundTakes.clear();
  try { peer?.destroy(); } catch { /* already gone */ }
  peer = null;
  setRoom({ status: "idle", error: null, isHost: false, myId: "", snap: null });
}

export function inviteLink(code: string) {
  if (location.protocol === "file:") return null;
  return `${location.origin}${location.pathname}?room=${code}`;
}
