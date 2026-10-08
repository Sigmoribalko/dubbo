import workletSource from "./pitch-shifter.worklet.js?raw";
import { settings, useSettings, type Settings } from "../../state/settings";
import { buildEffect, type EffectChain, type EffectId } from "./effects";

let ctx: AudioContext | null = null;
let workletReady: Promise<void> | null = null;

/** The shared AudioContext. Created lazily; call `unlockAudio()` from a user gesture. */
export function audioCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: "interactive" });
  }
  return ctx;
}

/** Load the pitch-shifter worklet into a context (once per context). */
export function loadWorklets(c: BaseAudioContext = audioCtx()): Promise<void> {
  const load = () => {
    const url = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
    return c.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  };
  if (c !== ctx) return load();
  return (workletReady ??= load());
}

export async function unlockAudio() {
  const c = audioCtx();
  if (c.state !== "running") await c.resume().catch(() => {});
  await loadWorklets(c);
}

// Browsers only start audio after a gesture; resume on the first one.
for (const ev of ["pointerdown", "keydown"] as const) {
  window.addEventListener(ev, () => { if (ctx && ctx.state !== "running") ctx.resume().catch(() => {}); }, { capture: true, passive: true });
}

const decoded = new WeakMap<Blob, Promise<AudioBuffer>>();
export function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  let p = decoded.get(blob);
  if (!p) {
    p = blob.arrayBuffer().then((ab) => audioCtx().decodeAudioData(ab));
    decoded.set(blob, p);
  }
  return p;
}

/* ---------- mixing buses ---------- */

/** Every sound belongs to a bus whose level comes from the user's settings. */
export type BusKind = "voice" | "lines" | "bg" | "video";
const BUS_SETTING: Record<BusKind, keyof Settings> = { voice: "voices", lines: "lines", bg: "bg", video: "video" };
const level = (key: keyof Settings) => Number(settings()[key]) / 100;

/** Keep a GainNode in sync with a volume setting. Returns an unsubscribe function. */
export function bindGain(g: GainNode, key: keyof Settings): () => void {
  g.gain.value = level(key);
  return useSettings.subscribe((s, prev) => {
    if (s[key] !== prev[key]) g.gain.setTargetAtTime(Number(s[key]) / 100, g.context.currentTime, 0.03);
  });
}

export interface BusSet {
  input(kind: BusKind): AudioNode;
  dispose(): void;
}

/** A set of per-category level controls feeding `dest`. */
export function createBuses(dest: AudioNode): BusSet {
  const c = dest.context as AudioContext;
  const nodes = {} as Record<BusKind, GainNode>;
  const unbind: Array<() => void> = [];
  for (const kind of Object.keys(BUS_SETTING) as BusKind[]) {
    const g = c.createGain();
    g.connect(dest);
    unbind.push(bindGain(g, BUS_SETTING[kind]));
    nodes[kind] = g;
  }
  return {
    input: (kind) => nodes[kind],
    dispose() {
      unbind.forEach((f) => f());
      Object.values(nodes).forEach((g) => g.disconnect());
    },
  };
}

let master: GainNode | null = null;
let mainBuses: BusSet | null = null;

/** Final output stage (master volume) → speakers. */
export function masterOut(): GainNode {
  if (!master) {
    const c = audioCtx();
    master = c.createGain();
    master.connect(c.destination);
    bindGain(master, "master");
  }
  return master;
}

/** The buses everything on screen plays through. */
export function buses(): BusSet {
  return (mainBuses ??= createBuses(masterOut()));
}

const routed = new WeakMap<HTMLMediaElement, GainNode>();
/**
 * Route a video element's own soundtrack through the "video" bus.
 * (`element.volume` is read-only on iOS; Web Audio gain works everywhere.)
 * The per-element gain in between lets a mixer silence original voices while they're being dubbed.
 */
export function routeVideo(el: HTMLMediaElement, out: BusSet = buses()) {
  if (routed.has(el)) return;
  const c = audioCtx();
  const duck = c.createGain();
  c.createMediaElementSource(el).connect(duck).connect(out.input("video"));
  routed.set(el, duck);
}

/** Time ranges (seconds of video) where the video's own soundtrack is muted. */
export type DuckRanges = Array<[number, number]>;
/** Fade a little before and after each line so the original voice never peeks through. */
const DUCK_PAD = 0.15;

export interface MixTrack {
  buffer: AudioBuffer;
  /** Track time = video time + offset. */
  offset: number;
  bus: Exclude<BusKind, "video">;
  effect?: EffectId;
}

interface Voice {
  track: MixTrack;
  chain: EffectChain;
  level: GainNode;
  source: AudioBufferSourceNode | null;
}

const DRIFT_TOLERANCE = 0.06;

/**
 * Plays audio buffers in lock-step with a <video>. Sources are scheduled sample-accurately
 * on the AudioContext clock and re-anchored whenever the video seeks, stalls or drifts.
 */
export interface MixerOptions {
  out?: BusSet;
  /** Mute the video's soundtrack during these ranges (the lines being dubbed). */
  duck?: DuckRanges;
}

export class VideoMixer {
  private voices: Voice[] = [];
  private anchor: { ctx: number; video: number } | null = null;
  private timer = 0;
  private readonly ctx = audioCtx();
  private readonly off: Array<() => void> = [];

  private readonly out: BusSet;
  private readonly duck: DuckRanges;
  private duckTimer = 0;
  private ducked = false;

  constructor(private video: HTMLVideoElement, tracks: MixTrack[], opts: MixerOptions = {}) {
    this.out = opts.out ?? buses();
    this.duck = opts.duck ?? [];
    this.voices = tracks.map((t) => this.makeVoice(t));
    if (this.duck.length) {
      this.duckTimer = window.setInterval(() => this.updateDuck(), 30);
      this.updateDuck();
    }
    const on = (ev: string, fn: () => void) => {
      video.addEventListener(ev, fn);
      this.off.push(() => video.removeEventListener(ev, fn));
    };
    on("playing", () => this.start());
    on("seeked", () => { if (!video.paused) this.start(); });
    for (const ev of ["pause", "waiting", "seeking", "ended", "emptied"]) on(ev, () => this.stop());
    on("ratechange", () => { if (!video.paused) this.start(); });
    if (!video.paused && video.readyState >= 3) this.start();
  }

  private updateDuck() {
    const g = routed.get(this.video);
    if (!g) return;
    const t = this.video.currentTime;
    const inLine = this.duck.some(([a, b]) => t >= a - DUCK_PAD && t <= b + DUCK_PAD);
    if (inLine === this.ducked) return;
    this.ducked = inLine;
    g.gain.setTargetAtTime(inLine ? 0 : 1, this.ctx.currentTime, 0.015);
  }

  private makeVoice(track: MixTrack): Voice {
    const chain = buildEffect(this.ctx, track.effect ?? "none");
    const level = this.ctx.createGain();
    chain.output.connect(level).connect(this.out.input(track.bus));
    return { track, chain, level, source: null };
  }

  /** Swap the effect on one track without rebuilding the others. */
  setEffect(index: number, effect: EffectId) {
    const v = this.voices[index];
    if (!v) return;
    this.stopVoice(v);
    v.chain.dispose();
    v.level.disconnect();
    this.voices[index] = this.makeVoice({ ...v.track, effect });
    if (this.anchor) this.start();
  }

  private start() {
    this.stop();
    const now = this.ctx.currentTime + 0.02;
    const vt = this.video.currentTime;
    const rate = this.video.playbackRate || 1;
    this.anchor = { ctx: now, video: vt };
    for (const v of this.voices) {
      const at = vt + v.track.offset + v.chain.latency;
      if (at >= v.track.buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = v.track.buffer;
      src.playbackRate.value = rate;
      src.connect(v.chain.input);
      if (at >= 0) src.start(now, at);
      else src.start(now - at / rate);
      v.source = src;
    }
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.checkDrift(), 250);
  }

  private checkDrift() {
    if (!this.anchor || this.video.paused) return;
    const expected = this.anchor.video + (this.ctx.currentTime - this.anchor.ctx) * (this.video.playbackRate || 1);
    if (Math.abs(this.video.currentTime - expected) > DRIFT_TOLERANCE) this.start();
  }

  private stopVoice(v: Voice) {
    if (!v.source) return;
    try { v.source.stop(); } catch { /* not started */ }
    v.source.disconnect();
    v.source = null;
  }

  stop() {
    clearInterval(this.timer);
    this.anchor = null;
    this.voices.forEach((v) => this.stopVoice(v));
  }

  destroy() {
    this.stop();
    clearInterval(this.duckTimer);
    const g = routed.get(this.video);
    if (g && this.ducked) g.gain.setTargetAtTime(1, this.ctx.currentTime, 0.015);
    this.off.forEach((f) => f());
    for (const v of this.voices) { v.chain.dispose(); v.level.disconnect(); }
    this.voices = [];
  }
}
