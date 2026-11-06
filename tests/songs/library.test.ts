import { describe, expect, it } from "vitest";
import { arrange, findCooldownViolations } from "../../src/songs/arrange";
import { SONGS } from "../../src/songs/library";

describe("SONGS", () => {
  it("has the three songs", () => {
    expect(SONGS.map((s) => s.id)).toEqual(["fur-elise", "canon", "twinkle"]);
  });
  for (const s of SONGS) {
    describe(s.id, () => {
      it("arranges without error", () => {
        expect(() => arrange(s)).not.toThrow();
      });
      it("has no cooldown violations", () => {
        expect(findCooldownViolations(s, arrange(s))).toEqual([]);
      });
      it("beats within revolution", () => {
        for (const n of s.notes) {
          expect(n.beat).toBeGreaterThanOrEqual(0);
          expect(n.beat).toBeLessThan(s.beatsPerRevolution);
        }
      });
      it("revolution lasts 15-25s", () => {
        const sec = (60 * s.beatsPerRevolution) / s.bpm;
        expect(sec).toBeGreaterThanOrEqual(15);
        expect(sec).toBeLessThanOrEqual(25);
      });
    });
  }
});
