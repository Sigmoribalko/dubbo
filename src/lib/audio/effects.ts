/*
 * Voice effects. Each effect is a small Web Audio graph with one input and one output,
 * so the same chain is used for live monitoring, playback and video export.
 * Effects are non-destructive: recordings stay clean and can be re-styled any time.
 * Display names live in the i18n dictionaries (`effects.<id>`).
 */

export const EFFECTS = [
  { id: "none" },
  { id: "chipmunk" },
  { id: "giant" },
  { id: "demon" },
  { id: "robot" },
  { id: "radio" },
  { id: "phone" },
  { id: "echo" },
  { id: "cave" },
  { id: "underwater" },
] as const;

export type EffectId = (typeof EFFECTS)[number]["id"];

export interface EffectChain {
  input: AudioNode;
  output: AudioNode;
  /** Processing delay in seconds; playback starts this much earlier to stay in sync. */
  latency: number;
  dispose(): void;
}

function distortionCurve(amount: number) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
/** Synthetic room impulse: decaying stereo noise. Cheap and needs no asset files. */
function impulse(ctx: BaseAudioContext, seconds: number, decay: number) {
  const key = `${seconds}:${decay}`;
  let byCtx = irCache.get(ctx);
  if (!byCtx) irCache.set(ctx, (byCtx = new Map()));
  const hit = byCtx.get(key);
  if (hit) return hit;
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  byCtx.set(key, buf);
  return buf;
}

const PITCH_WINDOW_MS = 60;

export function buildEffect(ctx: BaseAudioContext, id: EffectId): EffectChain {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const oscillators: OscillatorNode[] = [];
  const nodes: AudioNode[] = [input, output];
  const own = <T extends AudioNode>(n: T) => (nodes.push(n), n);
  let latency = 0;

  const filter = (type: BiquadFilterType, frequency: number, Q = 0.7, gain = 0) => {
    const f = own(ctx.createBiquadFilter());
    Object.assign(f, { type });
    f.frequency.value = frequency;
    f.Q.value = Q;
    f.gain.value = gain;
    return f;
  };
  const shaper = (amount: number) => {
    const s = own(ctx.createWaveShaper());
    s.curve = distortionCurve(amount);
    s.oversample = "2x";
    return s;
  };
  const gain = (v: number) => {
    const g = own(ctx.createGain());
    g.gain.value = v;
    return g;
  };
  const lfo = (freq: number, depth: number, target: AudioParam) => {
    const o = own(ctx.createOscillator());
    o.frequency.value = freq;
    const g = gain(depth);
    o.connect(g).connect(target);
    o.start();
    oscillators.push(o);
    return o;
  };
  const pitch = (ratio: number): AudioNode => {
    let node: AudioWorkletNode;
    try {
      node = own(new AudioWorkletNode(ctx, "pitch-shifter", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { windowMs: PITCH_WINDOW_MS },
      }));
    } catch {
      // Worklet not loaded (or unsupported): keep the rest of the effect, skip the pitch shift.
      return gain(1);
    }
    node.parameters.get("ratio")!.value = ratio;
    latency += PITCH_WINDOW_MS / 2000;
    return node;
  };
  const delay = (seconds: number, max = 1) => {
    const d = own(ctx.createDelay(max));
    d.delayTime.value = seconds;
    return d;
  };
  const reverb = (seconds: number, decay: number) => {
    const c = own(ctx.createConvolver());
    c.buffer = impulse(ctx, seconds, decay);
    return c;
  };
  /** Wire nodes in series; returns the last one. */
  const chain = (...nodes: AudioNode[]) => {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  };

  switch (id) {
    case "chipmunk":
      chain(input, pitch(1.75), filter("highshelf", 3000, 0.7, 3), output);
      break;
    case "giant":
      chain(input, pitch(0.7), filter("lowshelf", 220, 0.7, 5), gain(1.1), output);
      break;
    case "demon": {
      const body = chain(input, pitch(0.55), filter("lowshelf", 180, 0.7, 6), shaper(6), gain(0.8));
      body.connect(output);
      chain(body, reverb(1.6, 3), gain(0.35), output);
      break;
    }
    case "robot": {
      // Ring modulation: the voice gain swings with a 55 Hz sine.
      const ring = gain(0);
      lfo(55, 1, ring.gain);
      const comb = delay(0.006, 0.05);
      const fb = gain(0.55);
      chain(input, ring, comb, fb, comb);
      ring.connect(output);
      comb.connect(gain(0.7)).connect(output);
      break;
    }
    case "radio":
      chain(input, filter("highpass", 600), filter("lowpass", 2800), shaper(25), filter("peaking", 1800, 1, 6), gain(0.55), output);
      break;
    case "phone":
      chain(input, filter("highpass", 420), filter("lowpass", 3300), filter("peaking", 1100, 1.2, 5), shaper(4), gain(0.9), output);
      break;
    case "echo": {
      input.connect(output);
      const d = delay(0.32, 2);
      const fb = gain(0.42);
      chain(input, d, filter("lowpass", 3200), fb, d);
      d.connect(gain(0.6)).connect(output);
      break;
    }
    case "cave": {
      chain(input, gain(0.75), output);
      const pre = delay(0.04, 0.2);
      chain(input, pre, reverb(3.2, 2.2), filter("lowpass", 5000), gain(0.55), output);
      break;
    }
    case "underwater": {
      const lp = filter("lowpass", 650, 6);
      lfo(0.7, 260, lp.frequency);
      const wobble = delay(0.02, 0.1);
      lfo(1.3, 0.004, wobble.delayTime);
      chain(input, wobble, lp, gain(0.9), output);
      break;
    }
    default:
      input.connect(output);
  }

  return {
    input,
    output,
    latency,
    dispose() {
      oscillators.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } });
      // Disconnect every node so feedback loops (echo, comb) don't keep the graph alive.
      nodes.forEach((n) => { try { n.disconnect(); } catch { /* ignore */ } });
    },
  };
}
