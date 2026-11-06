import { describe, it, expect } from "vitest";
import { PARTIAL_RATIOS, voiceParams, toAudioTime } from "../../src/audio/voice";

describe("voiceParams", () => {
  it("A4 fundamental is 440 Hz", () => {
    expect(voiceParams(69, 1)[0]!.freq).toBeCloseTo(440, 6);
  });
  it("partial freq ratios match PARTIAL_RATIOS", () => {
    const p = voiceParams(60, 1);
    expect(p).toHaveLength(4);
    p.forEach((v, k) => expect(v.freq / p[0]!.freq).toBeCloseTo(PARTIAL_RATIOS[k]!, 9));
  });
  it("fundamental decay spans 3.0 (midi 57) to 0.8 (midi 86)", () => {
    expect(voiceParams(57, 1)[0]!.decay).toBeCloseTo(3.0, 6);
    expect(voiceParams(86, 1)[0]!.decay).toBeCloseTo(0.8, 6);
  });
  it("partial decay = base / (1 + 1.5k); gain = velocity * weights", () => {
    const p = voiceParams(57, 0.5);
    [0, 1, 2, 3].forEach((k) => {
      expect(p[k]!.decay).toBeCloseTo(3 / (1 + 1.5 * k), 6);
      expect(p[k]!.gain).toBeCloseTo(0.5 * [1, 0.35, 0.15, 0.06][k]!, 9);
    });
  });
  it("drops partials above 16 kHz", () => {
    const p = voiceParams(86, 1); // f0 ~ 1174 Hz; 2.76x=3.2k, 5.4x=6.3k, 8.93x=10.5k
    expect(p).toHaveLength(4);
    const hi = voiceParams(100, 1); // f0 ~ 2637; 8.93x = 23.5k dropped; 5.4x=14.2k kept
    expect(hi).toHaveLength(3);
    expect(hi.every((v) => v.freq <= 16000)).toBe(true);
  });
});

describe("toAudioTime", () => {
  it("maps event time into the audio clock", () => {
    expect(toAudioTime(10.03, 10, 5)).toBeCloseTo(5.03, 9);
  });
  it("returns null for stale events", () => {
    expect(toAudioTime(9, 10, 5)).toBeNull();
  });
  it("allows 5 ms of lateness", () => {
    expect(toAudioTime(9.997, 10, 5)).not.toBeNull();
    expect(toAudioTime(9.99, 10, 5)).toBeNull();
  });
});
