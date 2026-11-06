import { describe, expect, it } from "vitest";
import { validateMeta } from "../src/meta";
import { COMB_PITCHES } from "../src/songs/comb";
import metaJson from "../public/musicbox.meta.json";

const raw: unknown = metaJson;

describe("musicbox.meta.json", () => {
  const meta = validateMeta(raw);

  it("has 18 teeth matching the comb pitches", () => {
    expect(meta.comb.teeth).toHaveLength(18);
    expect(meta.comb.teeth.map((t) => t.midi)).toEqual([...COMB_PITCHES]);
  });

  it("tooth length strictly decreases with pitch", () => {
    for (let i = 1; i < meta.comb.teeth.length; i++) {
      expect(meta.comb.teeth[i]!.length).toBeLessThan(meta.comb.teeth[i - 1]!.length);
    }
  });

  it("teeth are spaced 0.0025 apart, bass on -X", () => {
    for (let i = 1; i < meta.comb.teeth.length; i++) {
      expect(meta.comb.teeth[i]!.x - meta.comb.teeth[i - 1]!.x).toBeCloseTo(0.0025, 6);
    }
  });

  it("all teeth lie over the cylinder", () => {
    const { center, length } = meta.cylinder;
    for (const t of meta.comb.teeth) {
      expect(t.x).toBeGreaterThanOrEqual(center[0] - length / 2);
      expect(t.x).toBeLessThanOrEqual(center[0] + length / 2);
    }
  });
});

describe("validateMeta", () => {
  it("rejects an empty object", () => {
    expect(() => validateMeta({})).toThrow();
  });

  it("rejects a missing nested field", () => {
    const broken = JSON.parse(JSON.stringify(raw));
    delete broken.comb.teeth[3].length;
    expect(() => validateMeta(broken)).toThrow(/teeth\[3\]\.length/);
  });
});
