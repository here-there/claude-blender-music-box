import { describe, it, expect } from "vitest";
import { createMusicBoxAudio } from "../../src/audio/engine";

class Param {
  value = 0;
  calls: [string, number, number?][] = [];
  setValueAtTime(v: number, t: number) { this.calls.push(["set", v, t]); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(["lin", v, t]); return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(["exp", v, t]); return this; }
  cancelScheduledValues(t: number) { this.calls.push(["cancel", NaN, t]); return this; }
}
class Node {
  connections: unknown[] = [];
  disconnected = false;
  connect(n: unknown) { this.connections.push(n); return n; }
  disconnect() { this.disconnected = true; }
}
class Osc extends Node {
  type = "sine"; frequency = new Param(); onended: (() => void) | null = null;
  startT: number | null = null; stopTs: number[] = [];
  start(t: number) { this.startT = t; }
  stop(t: number) { this.stopTs.push(t); }
}
class Src extends Osc { buffer: unknown = null; loop = false; }
class FakeCtx {
  gains: (Node & { gain: Param })[] = [];
  currentTime = 10; state = "suspended"; sampleRate = 48000;
  destination = new Node();
  oscs: Osc[] = [];
  resumed = 0;
  createOscillator() { const o = new Osc(); this.oscs.push(o); return o; }
  createBufferSource() { return new Src(); }
  createGain() { const g = new Node() as Node & { gain: Param }; g.gain = new Param(); this.gains.push(g); return g; }
  createBiquadFilter() { const f = new Node() as Node & { type: string; frequency: Param; gain: Param; Q: Param }; f.type = ""; f.frequency = new Param(); f.gain = new Param(); f.Q = new Param(); return f; }
  createConvolver() { return Object.assign(new Node(), { buffer: null as unknown }); }
  createDynamicsCompressor() { const c = new Node() as Node & Record<string, Param>; for (const k of ["threshold", "knee", "ratio", "attack", "release"]) c[k] = new Param(); return c; }
  createBuffer(ch: number, len: number, sr: number) {
    const data = new Float32Array(len);
    return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => data };
  }
  async resume() { this.resumed++; this.state = "running"; }
}
const make = () => { const ctx = new FakeCtx(); return { ctx, audio: createMusicBoxAudio(ctx as unknown as BaseAudioContext) }; };

describe("createMusicBoxAudio", () => {
  it("drops events while suspended", () => {
    const { ctx, audio } = make();
    expect(audio.running).toBe(false);
    audio.play(69, 1, 10.03, 10);
    expect(ctx.oscs).toHaveLength(0);
  });
  it("resume() starts the context", async () => {
    const { ctx, audio } = make();
    await audio.resume();
    expect(ctx.resumed).toBe(1);
    expect(audio.running).toBe(true);
  });
  it("schedules 4 oscillators at currentTime + 0.03", async () => {
    const { ctx, audio } = make();
    await audio.resume();
    audio.play(69, 1, 10.03, 10);
    expect(ctx.oscs).toHaveLength(4);
    for (const o of ctx.oscs) expect(o.startT).toBeCloseTo(10.03, 6);
    expect(ctx.oscs[0]!.frequency.value).toBeCloseTo(440, 6);
  });
  it("drops stale events", async () => {
    const { ctx, audio } = make();
    await audio.resume();
    audio.play(69, 1, 9, 10);
    expect(ctx.oscs).toHaveLength(0);
  });
  it("oscillators get a bounded stop time (cleanup)", async () => {
    const { ctx, audio } = make();
    await audio.resume();
    audio.play(57, 1, 10.03, 10);
    expect(ctx.oscs[0]!.stopTs[0]).toBeCloseTo(10.03 + 5 * 3, 6);
  });
  it("cancelAll fades every voice out over 10-20 ms, then stops it", async () => {
    const { ctx, audio } = make();
    await audio.resume();
    const before = ctx.gains.length;
    audio.play(69, 1, 10.03, 10);
    audio.play(72, 1, 10.1, 10);
    const voiceGains = ctx.gains.slice(before);
    expect(voiceGains).toHaveLength(8);
    ctx.currentTime = 10.5;
    audio.cancelAll();
    expect(ctx.oscs).toHaveLength(8);
    for (const o of ctx.oscs) {
      // the last stop() call is the cancel, well before the natural end (10.03 + 15 s)
      const stop = o.stopTs[o.stopTs.length - 1]!;
      expect(stop).toBeGreaterThanOrEqual(10.5 + 0.01);
      expect(stop).toBeLessThanOrEqual(10.5 + 0.02 + 1e-9);
    }
    for (const g of voiceGains) {
      const calls = g.gain.calls;
      const cancelIdx = calls.findIndex((c) => c[0] === "cancel" && c[2] === 10.5);
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      const ramp = calls.slice(cancelIdx).find((c) => c[0] === "lin" && c[1] === 0);
      expect(ramp).toBeDefined();
      expect(ramp![2]!).toBeGreaterThanOrEqual(10.51);
      expect(ramp![2]!).toBeLessThanOrEqual(10.52 + 1e-9);
      // not cut off before the fade finishes
      expect(g.disconnected).toBe(false);
    }
  });
  it("cancelAll releases the nodes once the faded voice has ended", async () => {
    const { ctx, audio } = make();
    await audio.resume();
    audio.play(69, 1, 10.03, 10);
    audio.cancelAll();
    const o = ctx.oscs[0] as Osc & { onended: (() => void) | null };
    o.onended?.();
    expect(ctx.oscs.every((x) => x.disconnected)).toBe(true);
    // a second cancelAll has nothing left to stop
    const stops = ctx.oscs.map((x) => x.stopTs.length);
    audio.cancelAll();
    expect(ctx.oscs.map((x) => x.stopTs.length)).toEqual(stops);
  });
  it("click does nothing while suspended and does not throw when running", async () => {
    const { audio } = make();
    expect(() => audio.click()).not.toThrow();
    await audio.resume();
    expect(() => audio.click()).not.toThrow();
  });
});

describe("createMusicBoxAudio without AudioContext", () => {
  it("returns a silent no-op when the constructor throws", async () => {
    const g = globalThis as unknown as { AudioContext?: unknown };
    const prev = g.AudioContext;
    g.AudioContext = class { constructor() { throw new Error("blocked"); } };
    try {
      const audio = createMusicBoxAudio();
      expect(audio.running).toBe(false);
      await audio.resume();
      audio.play(69, 1, 1, 0);
      audio.click();
      audio.cancelAll();
      expect(audio.running).toBe(false);
    } finally {
      g.AudioContext = prev;
    }
  });
});
