import { describe, expect, it } from "vitest";
import { arrange, findCooldownViolations } from "../../src/songs/arrange";
import { COMB_PITCHES, COMB_TOOTH_COUNT, midiToFreq, noteName } from "../../src/songs/comb";
import type { Song } from "../../src/songs/types";

const song = (notes: Song["notes"], bpm = 120, bpr = 8): Song => ({
  id: "t", title: "t", bpm, beatsPerRevolution: bpr, notes,
});

describe("comb", () => {
  it("has 18 pitches, ascending", () => {
    expect(COMB_TOOTH_COUNT).toBe(18);
    expect(COMB_PITCHES).toHaveLength(18);
    for (let i = 1; i < 18; i++) expect(COMB_PITCHES[i]!).toBeGreaterThan(COMB_PITCHES[i - 1]!);
  });
  it("midiToFreq / noteName", () => {
    expect(midiToFreq(69)).toBe(440);
    expect(noteName(75)).toBe("D#5");
    expect(noteName(57)).toBe("A3");
  });
});

describe("arrange", () => {
  it("maps in-comb pitch to its tooth", () => {
    const pins = arrange(song([{ beat: 0, midi: 76 }]));
    expect(pins[0]).toEqual({ tooth: COMB_PITCHES.indexOf(76), beat: 0, midi: 76 });
  });
  it("shifts out-of-comb pitch by octave", () => {
    const pins = arrange(song([{ beat: 0, midi: 88 }]));
    expect(pins[0]!.tooth).toBe(COMB_PITCHES.indexOf(76));
    expect(pins[0]!.midi).toBe(76);
  });
  it("throws when no tooth", () => {
    expect(() => arrange(song([{ beat: 1, midi: 30 }]))).toThrow(/has no tooth/);
  });
  it("sorts by beat", () => {
    const pins = arrange(song([{ beat: 2, midi: 72 }, { beat: 1, midi: 74 }, { beat: 0, midi: 76 }]));
    expect(pins.map((p) => p.beat)).toEqual([0, 1, 2]);
  });
});

describe("findCooldownViolations", () => {
  const two = (b: number) => song([{ beat: 0, midi: 72 }, { beat: b, midi: 72 }]);
  it("flags 100ms gap", () => {
    const s = two(0.2);
    expect(findCooldownViolations(s, arrange(s))).toHaveLength(1);
  });
  it("accepts 125ms gap", () => {
    const s = two(0.25);
    expect(findCooldownViolations(s, arrange(s))).toHaveLength(0);
  });
  it("flags wrap-around gap", () => {
    const s = song([{ beat: 0, midi: 72 }, { beat: 7.9, midi: 72 }]);
    expect(findCooldownViolations(s, arrange(s))).toHaveLength(1);
  });
});
