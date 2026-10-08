import { settings, useSettings } from "../../state/settings";
import { audioCtx, bindGain, loadWorklets, masterOut } from "./engine";
import { buildEffect, type EffectChain, type EffectId } from "./effects";

/*
 * Microphone pipeline:
 *
 *   getUserMedia → source → gain (recording volume) ─┬→ analyser (level meter)
 *                                                     ├→ MediaStreamDestination → MediaRecorder
 *                                                     └→ [effect → monitor gain → master]  (optional)
 */

interface MicGraph {
  stream: MediaStream;
  key: string;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  out: MediaStreamAudioDestinationNode;
  unbind: () => void;
}

let mic: MicGraph | null = null;
let pending: Promise<MicGraph> | null = null;

const constraintKey = () => {
  const s = settings();
  return [s.micDevice, s.noiseSuppression, s.echoCancellation, s.autoGain].join("|");
};

async function open(): Promise<MicGraph> {
  const s = settings();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: s.micDevice ? { exact: s.micDevice } : undefined,
      noiseSuppression: s.noiseSuppression,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGain,
    },
  });
  const c = audioCtx();
  const source = c.createMediaStreamSource(stream);
  const gain = c.createGain();
  const analyser = c.createAnalyser();
  analyser.fftSize = 1024;
  const out = c.createMediaStreamDestination();
  out.channelCount = 1;
  source.connect(gain);
  gain.connect(analyser);
  gain.connect(out);
  return { stream, key: constraintKey(), source, gain, analyser, out, unbind: bindGain(gain, "micGain") };
}

function close(g: MicGraph) {
  g.unbind();
  g.source.disconnect();
  g.gain.disconnect();
  g.stream.getTracks().forEach((t) => t.stop());
}

/** Open (or reuse) the microphone with the current settings. Returns the processed stream to record. */
export async function getMic(): Promise<MediaStream> {
  if (mic && mic.key === constraintKey() && mic.stream.getAudioTracks().some((t) => t.readyState === "live")) return mic.out.stream;
  if (!pending) {
    pending = (async () => {
      const effect = monitor?.effect ?? null;
      if (mic) { await setMonitor(null); close(mic); mic = null; }
      mic = await open();
      if (effect) await setMonitor(effect);
      useMicState.notify();
      return mic;
    })().finally(() => { pending = null; });
  }
  return (await pending).out.stream;
}

export const hasMic = () => !!mic;

// Device or processing changes take effect immediately if the mic is already open.
useSettings.subscribe((s, prev) => {
  if (mic && (s.micDevice !== prev.micDevice || s.noiseSuppression !== prev.noiseSuppression || s.echoCancellation !== prev.echoCancellation || s.autoGain !== prev.autoGain)) {
    getMic().catch(() => {});
  }
});

/** Tiny pub/sub so React can re-render when the mic opens. */
export const useMicState = {
  listeners: new Set<() => void>(),
  notify() { this.listeners.forEach((f) => f()); },
};

const buf = new Float32Array(1024);
/** Current (post-gain) mic level, 0…1. */
export function micLevel(): number {
  if (!mic) return 0;
  mic.analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 4.5);
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  } catch {
    return [];
  }
}

let monitor: { effect: EffectId; chain: EffectChain; level: GainNode; unbind: () => void } | null = null;
/** Hear yourself through an effect (headphones only, or it feeds back). */
export async function setMonitor(effect: EffectId | null) {
  if (monitor) {
    monitor.unbind();
    monitor.chain.dispose();
    monitor.level.disconnect();
    monitor = null;
  }
  if (!effect || !mic) return;
  const c = audioCtx();
  await loadWorklets(c);
  const chain = buildEffect(c, effect);
  const level = c.createGain();
  mic.gain.connect(chain.input);
  chain.output.connect(level).connect(masterOut());
  monitor = { effect, chain, level, unbind: bindGain(level, "monitor") };
}

export function pickMime(candidates: string[]): string {
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}
