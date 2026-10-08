import { store } from "../store";
import type { Scene } from "../types";
import { audioCtx } from "./engine";

/*
 * Loudness envelopes: RMS amplitude in short frames, used to draw how loud a voice is over time.
 */

/** Frames per second. */
export const ENV_RATE = 50;

export interface Envelope {
  /** values[i] is the RMS of video time [i / ENV_RATE, (i + 1) / ENV_RATE). */
  values: Float32Array;
}

/** RMS per frame of a buffer; "mid" averages stereo channels (centred dialogue). */
function rmsFrames(buf: AudioBuffer): Float32Array {
  const frame = Math.max(1, Math.round(buf.sampleRate / ENV_RATE));
  const n = Math.ceil(buf.length / frame);
  const out = new Float32Array(n);
  const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const end = Math.min(buf.length, (i + 1) * frame);
    for (let j = i * frame; j < end; j++) {
      const x = chans.length === 2 ? (chans[0][j] + chans[1][j]) / 2 : chans[0][j];
      sum += x * x;
    }
    out[i] = Math.sqrt(sum / Math.max(1, end - i * frame));
  }
  return out;
}

/** Envelope of a recording placed on the video timeline (track time = video time + offset). */
export function recordingEnvelope(buf: AudioBuffer, offset: number, duration: number): Envelope {
  const frames = rmsFrames(buf);
  const values = new Float32Array(Math.ceil(duration * ENV_RATE));
  const shift = Math.round(offset * ENV_RATE);
  for (let i = 0; i < values.length; i++) values[i] = frames[i + shift] ?? 0;
  return { values };
}

const soundtrackCache = new Map<string, Promise<Float32Array | null>>();
/** Envelope of the scene video's own soundtrack (decoded once per scene). */
function soundtrackFrames(scene: Scene): Promise<Float32Array | null> {
  let p = soundtrackCache.get(scene.id);
  if (!p) {
    p = (async () => {
      const blob = await store.getMedia(scene.id);
      if (!blob || blob.size > 300 * 1024 * 1024) return null; // too big to decode comfortably
      try {
        return rmsFrames(await audioCtx().decodeAudioData(await blob.arrayBuffer()));
      } catch {
        return null; // no audio track or unsupported codec
      }
    })();
    soundtrackCache.set(scene.id, p);
  }
  return p;
}

/**
 * How loud the character speaks over time: from the pack's separate voice clips when it has
 * them, otherwise from the video soundtrack inside the character's lines.
 */
export async function characterEnvelope(opts: {
  scene: Scene;
  roleId: string;
  clips: Record<string, AudioBuffer>;
  hasBackingTrack: boolean;
  duration: number;
}): Promise<Envelope> {
  const { scene, roleId, clips } = opts;
  const lines = scene.lines.filter((l) => l.roleId === roleId);
  const values = new Float32Array(Math.ceil(opts.duration * ENV_RATE));
  const withClip = lines.filter((l) => l.clip && clips[l.clip]);
  for (const l of withClip) {
    const frames = rmsFrames(clips[l.clip!]);
    const start = Math.round(l.start * ENV_RATE);
    for (let i = 0; i < frames.length && start + i < values.length; i++) values[start + i] = Math.max(values[start + i], frames[i]);
  }
  const rest = lines.filter((l) => !withClip.includes(l));
  if (rest.length && !opts.hasBackingTrack) {
    const frames = await soundtrackFrames(scene);
    if (frames) {
      for (const l of rest) {
        const a = Math.max(0, Math.floor((l.start - 0.1) * ENV_RATE));
        const b = Math.min(values.length, Math.ceil((l.end + 0.1) * ENV_RATE));
        for (let i = a; i < b; i++) values[i] = frames[i] ?? 0;
      }
    }
  }
  return { values };
}

/** RMS → 0…1 on a -50…0 dBFS scale. */
export const loudness = (rms: number) => Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-9) + 50) / 50));
