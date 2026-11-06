import { toAudioTime, voiceParams } from "./voice";

export interface MusicBoxAudio {
  /** Call from a user gesture. */
  resume(): Promise<void>;
  readonly running: boolean;
  /** eventTime/now in the same (wall) clock; dropped unless running. */
  play(midi: number, velocity: number, eventTime: number, now: number): void;
  /** Ratchet click: 5 ms band-passed noise pulse. */
  click(): void;
  cancelAll(): void;
}

const ATTACK = 0.002;
const SILENCE = 0.001;
const LIFETIME_DECAYS = 5;
const MASTER_GAIN = 0.35;
const REVERB_SECONDS = 0.6;
const WET = 0.18;
/** cancelAll fade-out: long enough to avoid a click, short enough to feel immediate. */
const CANCEL_FADE = 0.015;

/** mulberry32: deterministic PRNG so the reverb IR is identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeImpulse(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * REVERB_SECONDS));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const rnd = mulberry32(0x6d62 + c);
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

interface Voice { oscs: OscillatorNode[]; gains: GainNode[]; }

function silentAudio(): MusicBoxAudio {
  return {
    async resume() {},
    get running() { return false; },
    play() {},
    click() {},
    cancelAll() {},
  };
}

export function createMusicBoxAudio(injected?: BaseAudioContext): MusicBoxAudio {
  let ctx: BaseAudioContext;
  try {
    ctx = injected ?? new AudioContext({ latencyHint: "interactive" });
  } catch {
    return silentAudio(); // spec §4: visuals keep running without sound
  }

  // bus -> peaks -> (dry + convolver->wet) -> compressor -> destination
  const bus = ctx.createGain();
  bus.gain.value = MASTER_GAIN;
  const peak1 = ctx.createBiquadFilter();
  peak1.type = "peaking"; peak1.frequency.value = 250; peak1.gain.value = 4; peak1.Q.value = 1.2;
  const peak2 = ctx.createBiquadFilter();
  peak2.type = "peaking"; peak2.frequency.value = 1200; peak2.gain.value = 3; peak2.Q.value = 1.5;
  const dry = ctx.createGain();
  dry.gain.value = 1 - WET;
  const wet = ctx.createGain();
  wet.gain.value = WET;
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  bus.connect(peak1); peak1.connect(peak2);
  peak2.connect(dry); peak2.connect(conv);
  conv.connect(wet);
  dry.connect(comp); wet.connect(comp);
  comp.connect(ctx.destination);

  const voices = new Set<Voice>();
  let noise: AudioBuffer | null = null;

  const dispose = (v: Voice): void => {
    if (!voices.delete(v)) return;
    for (const o of v.oscs) o.disconnect();
    for (const g of v.gains) g.disconnect();
  };

  return {
    async resume() {
      if (ctx.state !== "running") await (ctx as AudioContext).resume();
    },
    get running() {
      return ctx.state === "running";
    },
    play(midi, velocity, eventTime, now) {
      if (ctx.state !== "running") return;
      const t = toAudioTime(eventTime, now, ctx.currentTime);
      if (t === null) return;
      const v: Voice = { oscs: [], gains: [] };
      for (const p of voiceParams(midi, velocity)) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = p.freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(p.gain, t + ATTACK);
        g.gain.exponentialRampToValueAtTime(p.gain * SILENCE, t + ATTACK + p.decay);
        osc.connect(g);
        g.connect(bus);
        osc.start(t);
        osc.stop(t + LIFETIME_DECAYS * p.decay);
        v.oscs.push(osc);
        v.gains.push(g);
      }
      voices.add(v);
      const last = v.oscs[0];
      if (last) last.onended = () => dispose(v);
    },
    click() {
      if (ctx.state !== "running") return;
      if (!noise) {
        const len = Math.max(1, Math.floor(ctx.sampleRate * 0.005));
        noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const rnd = mulberry32(0xc11c);
        const d = noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * (1 - i / len);
      }
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 2500; bp.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      src.connect(bp); bp.connect(g); g.connect(bus);
      src.onended = () => { src.disconnect(); bp.disconnect(); g.disconnect(); };
      src.start(ctx.currentTime);
    },
    cancelAll() {
      const now = ctx.currentTime;
      const end = now + CANCEL_FADE;
      for (const v of [...voices]) {
        // Forget the voice now (a later cancelAll has nothing to do); its nodes are released by the
        // oscillator's onended once the fade has played out.
        voices.delete(v);
        const release = (): void => {
          for (const o of v.oscs) o.disconnect();
          for (const g of v.gains) g.disconnect();
        };
        const first = v.oscs[0];
        if (first) first.onended = release;
        for (const g of v.gains) {
          const p = g.gain;
          const held = p.value;
          p.cancelScheduledValues(now);
          p.setValueAtTime(held, now);
          p.linearRampToValueAtTime(0, end);
        }
        for (const o of v.oscs) { try { o.stop(end); } catch { /* already stopped */ } }
      }
    },
  };
}
