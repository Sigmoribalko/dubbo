import Peer from "peerjs";
import { PUBLIC_PREFIX, PUBLIC_SLOTS, type PublicRoomInfo } from "./room";

/*
 * Finding public rooms without a server of our own: every open room claims one of
 * PUBLIC_SLOTS well-known peer ids and answers a probe with its details. We knock on
 * every slot and collect the answers. Empty slots fail fast with "peer-unavailable".
 */

const PROBE_TIMEOUT = 6000;
const BATCH = 10;

export interface FoundRoom extends PublicRoomInfo {
  slot: number;
}

export const joinable = (r: FoundRoom) => r.phase === "lobby" && r.players < r.capacity;

/** Probe all public slots. Calls `onFound` as rooms answer; resolves when the sweep is done. */
export function findRooms(onFound: (room: FoundRoom) => void): { done: Promise<void>; cancel(): void } {
  let cancelled = false;
  const peer = new Peer({ debug: 0 });
  const pending = new Map<string, () => void>();

  // Errors for unknown ids arrive on the Peer, not the connection: settle that probe.
  peer.on("error", (e) => {
    const id = /(dubbo-v1-pub-\d+)/.exec(String(e.message))?.[1];
    if (id) pending.get(id)?.();
  });

  const probe = (slot: number) =>
    new Promise<void>((resolve) => {
      const id = PUBLIC_PREFIX + slot;
      let settled = false;
      const conn = peer.connect(id, { serialization: "raw", reliable: true });
      const finish = () => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        clearTimeout(timer);
        try { conn.close(); } catch { /* not open */ }
        resolve();
      };
      const timer = setTimeout(finish, PROBE_TIMEOUT);
      pending.set(id, finish);
      conn.on("data", (d) => {
        try {
          const info = JSON.parse(String(d)) as PublicRoomInfo;
          if (info.v === 1 && !cancelled) onFound({ ...info, slot });
        } catch { /* not a room */ }
        finish();
      });
      conn.on("error", finish);
      conn.on("close", finish);
    });

  const done = (async () => {
    await new Promise<void>((res, rej) => {
      peer.on("open", () => res());
      peer.on("error", (e) => { if (e.type !== "peer-unavailable") rej(e); });
    });
    const slots = [...Array(PUBLIC_SLOTS).keys()];
    for (let i = 0; i < slots.length && !cancelled; i += BATCH) {
      await Promise.all(slots.slice(i, i + BATCH).map(probe));
    }
  })().finally(() => { setTimeout(() => peer.destroy(), 200); });

  return {
    done,
    cancel() {
      cancelled = true;
      pending.forEach((f) => f());
      peer.destroy();
    },
  };
}
