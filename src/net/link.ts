import type { DataConnection } from "peerjs";

/*
 * One reliable WebRTC data channel between two players.
 *
 * Control messages are JSON strings. Files (videos, recordings) are streamed as binary frames:
 *   [u32 header length][header JSON {f: fileId, s: seq}][payload ≤ CHUNK bytes]
 * bracketed by "file-begin" / "file-end" JSON messages. Sending respects the channel's
 * buffer so a 100 MB video doesn't blow the SCTP queue.
 */

const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

export type Json = Record<string, unknown> & { t: string };

export interface FileMeta {
  [k: string]: unknown;
  kind: string;
}

interface Incoming {
  meta: FileMeta;
  size: number;
  type: string;
  parts: ArrayBuffer[];
  received: number;
}

let fileSeq = 0;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Link {
  onMessage: (msg: Json) => void = () => {};
  onFile: (meta: FileMeta, blob: Blob) => void = () => {};
  onFileProgress: (meta: FileMeta, received: number, total: number) => void = () => {};
  onClose: () => void = () => {};

  private incoming = new Map<string, Incoming>();
  /** Files go out one at a time so progress is meaningful and memory stays flat. */
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly conn: DataConnection) {
    conn.on("data", (d) => this.receive(d));
    conn.on("close", () => this.onClose());
    conn.on("error", () => this.onClose());
  }

  get peer() {
    return this.conn.peer;
  }

  send(msg: Json) {
    if (this.conn.open) this.conn.send(JSON.stringify(msg));
  }

  sendFile(meta: FileMeta, blob: Blob, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const run = async () => {
      if (!this.conn.open) return;
      const id = `${Date.now().toString(36)}${(fileSeq++).toString(36)}`;
      this.send({ t: "file-begin", id, meta, size: blob.size, type: blob.type });
      let seq = 0;
      for (let off = 0; off < blob.size; off += CHUNK) {
        if (!this.conn.open) return;
        await this.drain();
        const payload = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
        const header = enc.encode(JSON.stringify({ f: id, s: seq++ }));
        const frame = new Uint8Array(4 + header.length + payload.length);
        new DataView(frame.buffer).setUint32(0, header.length);
        frame.set(header, 4);
        frame.set(payload, 4 + header.length);
        this.conn.send(frame.buffer);
        onProgress?.(Math.min(blob.size, off + CHUNK), blob.size);
      }
      this.send({ t: "file-end", id });
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  close() {
    try { this.conn.close(); } catch { /* already closed */ }
  }

  private drain(): Promise<void> {
    const dc = this.conn.dataChannel;
    if (!dc || dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
    dc.bufferedAmountLowThreshold = LOW_WATER;
    return new Promise((res) => {
      const done = () => { dc.removeEventListener("bufferedamountlow", done); res(); };
      dc.addEventListener("bufferedamountlow", done);
      setTimeout(done, 3000); // never hang if the event is missed
    });
  }

  private receive(data: unknown) {
    if (typeof data === "string") {
      let msg: Json;
      try { msg = JSON.parse(data) as Json; } catch { return; }
      if (msg.t === "file-begin") {
        this.incoming.set(String(msg.id), { meta: msg.meta as FileMeta, size: Number(msg.size), type: String(msg.type || ""), parts: [], received: 0 });
      } else if (msg.t === "file-end") {
        const f = this.incoming.get(String(msg.id));
        this.incoming.delete(String(msg.id));
        if (f) this.onFile(f.meta, new Blob(f.parts, { type: f.type }));
      } else {
        this.onMessage(msg);
      }
      return;
    }
    const buf = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : null;
    if (!buf) return;
    const view = new DataView(buf);
    const hlen = view.getUint32(0);
    const header = JSON.parse(dec.decode(new Uint8Array(buf, 4, hlen))) as { f: string; s: number };
    const f = this.incoming.get(header.f);
    if (!f) return;
    const payload = buf.slice(4 + hlen);
    f.parts[header.s] = payload;
    f.received += payload.byteLength;
    this.onFileProgress(f.meta, f.received, f.size);
  }
}
