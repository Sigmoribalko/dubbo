import { t } from "../i18n";
import type { Pack, Scene } from "./types";

/**
 * Packs and media live in IndexedDB. Everything is mirrored in memory so the app
 * keeps working for the session if storage is unavailable or a file is too large.
 */
class Store {
  private db: IDBDatabase | null = null;
  private packs = new Map<string, Pack>();
  private media = new Map<string, Blob>();
  private urls = new Map<string, string>();
  onWarning: (msg: string) => void = () => {};

  async init() {
    try {
      this.db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open("dubl", 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore("packs", { keyPath: "id" });
          r.result.createObjectStore("media");
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch {
      this.db = null;
    }
  }

  private tx<T>(name: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    return new Promise((res, rej) => {
      const t = this.db!.transaction(name, mode);
      const req = fn(t.objectStore(name));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  async listPacks(): Promise<Pack[]> {
    if (this.db) {
      try {
        const all = (await this.tx<Pack[]>("packs", "readonly", (s) => s.getAll())) ?? [];
        all.forEach((p) => this.packs.set(p.id, p));
      } catch { /* fall back to memory */ }
    }
    return [...this.packs.values()].sort((a, b) => b.updated - a.updated);
  }

  async getPack(id: string) {
    return (await this.listPacks()).find((p) => p.id === id) ?? null;
  }

  async putPack(p: Pack) {
    const copy: Pack = structuredClone({ ...p, updated: Date.now() });
    this.packs.set(copy.id, copy);
    if (!this.db) return;
    try {
      await this.tx("packs", "readwrite", (s) => s.put(copy));
    } catch {
      this.onWarning(t().storage.saveFailed);
    }
  }

  async deletePack(p: Pack) {
    for (const s of p.scenes) for (const k of sceneMediaKeys(s)) await this.deleteMedia(k);
    this.packs.delete(p.id);
    if (this.db) try { await this.tx("packs", "readwrite", (s) => s.delete(p.id)); } catch { /* ignore */ }
  }

  async putMedia(key: string, blob: Blob) {
    this.media.set(key, blob);
    this.revoke(key);
    if (!this.db) return;
    try {
      await this.tx("media", "readwrite", (s) => s.put(blob, key));
    } catch {
      this.onWarning(t().storage.tooBig);
    }
  }

  async getMedia(key?: string | null): Promise<Blob | null> {
    if (!key) return null;
    const hit = this.media.get(key);
    if (hit) return hit;
    if (!this.db) return null;
    try {
      const b = await this.tx<Blob>("media", "readonly", (s) => s.get(key));
      if (b) this.media.set(key, b);
      return b ?? null;
    } catch {
      return null;
    }
  }

  async deleteMedia(key?: string) {
    if (!key) return;
    this.media.delete(key);
    this.revoke(key);
    if (this.db) try { await this.tx("media", "readwrite", (s) => s.delete(key)); } catch { /* ignore */ }
  }

  async mediaUrl(key?: string | null): Promise<string | null> {
    if (!key) return null;
    const cached = this.urls.get(key);
    if (cached) return cached;
    const b = await this.getMedia(key);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    this.urls.set(key, u);
    return u;
  }

  private revoke(key: string) {
    const u = this.urls.get(key);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(key);
  }
}

export function sceneMediaKeys(s: Scene): string[] {
  return [s.id, s.bg, ...new Set(s.lines.map((l) => l.clip))].filter((k): k is string => !!k);
}

export const store = new Store();
