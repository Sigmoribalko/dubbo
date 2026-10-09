import { useEffect } from "react";
import { t } from "../i18n";
import { decodeBlob } from "../lib/audio/engine";
import { store } from "../lib/store";
import { roundTakes, useRoom, type Snapshot } from "../net/room";
import { notify, useApp } from "./app";
import { createGame, type Game } from "./game";

/** Build this device's game for a round: cast from the room's role picks. */
async function buildOnlineGame(snap: Snapshot, myId: string): Promise<Game | null> {
  if (!snap.pack || !snap.scene) return null;
  const pack = await store.getPack(snap.pack.id);
  const scene = pack?.scenes.find((s) => s.id === snap.scene!.id);
  if (!pack || !scene) return null;
  const cast: Record<string, string> = {};
  for (const p of snap.players) if (p.roleId) cast[p.roleId] = p.name;
  const myRoleId = snap.players.find((p) => p.id === myId)?.roleId ?? null;
  const res = await createGame({ pack, scene, round: snap.round, cast, myRoleId });
  if (res?.warnings.length) notify(t().game.clipsUnreadable);
  return res?.game ?? null;
}

/** Copy recordings received from the room into the local game (decoding new ones). */
async function syncTakes(game: Game) {
  let changed = false;
  for (const [roleId, tk] of roundTakes) {
    // Our own recording is managed by the record screen (it may be mid-redo).
    if (roleId === game.myRoleId && game.tracks[roleId]) continue;
    if (game.effects[roleId] !== tk.effect) { game.effects[roleId] = tk.effect; changed = true; }
    if (game.tracks[roleId]?.blob === tk.blob) continue;
    try {
      game.tracks[roleId] = { blob: tk.blob, buffer: await decodeBlob(tk.blob), offset: tk.offset };
      changed = true;
    } catch { /* unreadable recording: skip it */ }
  }
  if (changed) useApp.getState().touch();
}

/** Keeps navigation and the local game in step with the room (mounted once in App). */
export function useRoomDirector() {
  useEffect(() => {
    let building = 0;
    const app = useApp.getState;

    const onPhase = async (snap: Snapshot, myId: string) => {
      const view = app().view.name;
      const game = app().game;
      if (snap.phase === "lobby" || snap.phase === "casting") {
        if (view === "record" || view === "screen") { app().setGame(null); app().go({ name: "online" }); }
        return;
      }
      if (!game || game.round !== snap.round) {
        const ticket = ++building;
        const g = await buildOnlineGame(snap, myId);
        if (ticket !== building) return;
        if (!g) { notify(t().game.videoMissing); return; }
        app().setGame(g);
        await syncTakes(g);
      }
      const g = app().game!;
      if (snap.phase === "recording") {
        if (g.myRoleId && view !== "record") app().go({ name: "record" });
        else if (!g.myRoleId && view !== "online") app().go({ name: "online" });
      } else if (snap.phase === "screening" && view !== "screen") {
        app().go({ name: "screen" });
      }
    };

    const unsub = useRoom.subscribe((s, prev) => {
      if (s.status === "error" && prev.status !== "error") {
        const view = app().view.name;
        if (view === "record" || view === "screen") { app().setGame(null); app().go({ name: "online" }); }
      }
      if (s.snap && (s.snap.phase !== prev.snap?.phase || s.snap.round !== prev.snap?.round)) onPhase(s.snap, s.myId);
      if (s.takesRev !== prev.takesRev) {
        const g = app().game;
        if (g) syncTakes(g);
      }
    });
    return unsub;
  }, []);
}
