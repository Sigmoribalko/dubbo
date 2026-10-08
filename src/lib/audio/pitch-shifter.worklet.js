/*
 * Real-time pitch shifter (delay-line / granular, after Chris Wilson's "Jungle").
 *
 * Two read taps sweep through a short delay buffer at `ratio` × normal speed, half a
 * window apart. Each tap is faded with a sin² window that is zero exactly where the
 * tap wraps around, and the two windows always sum to 1, so the output is smooth.
 * Duration is preserved; latency is about half a window.
 */
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" }];
  }

  constructor(options) {
    super();
    const ms = (options.processorOptions && options.processorOptions.windowMs) || 60;
    this.win = Math.max(64, Math.round((sampleRate * ms) / 1000));
    let size = 1;
    while (size < this.win * 2 + 8) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    this.w = 0;
    this.phase = 0;
  }

  tap(delay) {
    const p = this.w - delay;
    const i = Math.floor(p);
    const f = p - i;
    return this.buf[i & this.mask] * (1 - f) + this.buf[(i + 1) & this.mask] * f;
  }

  process(inputs, outputs, params) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const input = inputs[0] && inputs[0][0];
    const step = (1 - params.ratio[0]) / this.win;
    for (let n = 0; n < out.length; n++) {
      this.buf[this.w] = input ? input[n] : 0;
      const p1 = this.phase;
      const p2 = p1 + 0.5 < 1 ? p1 + 0.5 : p1 - 0.5;
      const s1 = Math.sin(Math.PI * p1);
      const s2 = Math.sin(Math.PI * p2);
      out[n] = this.tap(1 + p1 * this.win) * s1 * s1 + this.tap(1 + p2 * this.win) * s2 * s2;
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;
      this.w = (this.w + 1) & this.mask;
    }
    return true;
  }
}

registerProcessor("pitch-shifter", PitchShifter);
