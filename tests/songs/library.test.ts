import { describe, expect, it } from "vitest";
import { arrange, findCooldownViolations } from "../../src/songs/arrange";
import { SONGS } from "../../src/songs/library";

// 千年等一回 melody, verse to end, as 简谱 digits (· = high octave) in 1=F — guards the transcription.
const QN_JIANPU =
  "3 3 5 3 5 6 i· 6 6 i· 6 i· 2· 5 6 i· 6 3 2 3 2 3 5 6 i· 2· 6 5 6 " +
  "3· 3· 2· 2· 2· 2· 3· i· 6 3· 3· 2· 2· 2· 2· 3· i· 6 " +
  "i· i· 6 6 i· 2· i· 2· 3· 2· 2· i· i· i· i· 2· 3· 2· i· 3· 3· 2· 3· 2· i· 5 " +
  "6 2· 3· 2· i· 5 6 2· 3· 2· i· 5 6 " +
  "5 6 i· 2· 6 5 6 3· 2· 3· 2· i· 5 6 5 6 i· 2· 6 5 6 3· 2· 3· 2· i· 5 6 " +
  "6 i· 2· 3· 6·";
const QN_DEGREE: Record<string, number> = {
  "2": 67, "3": 69, "5": 72, "6": 74, "i·": 77, "2·": 79, "3·": 81, "6·": 86,
};

describe("SONGS", () => {
  it("千年等一回 melody matches the 简谱 transcription", () => {
    const qn = SONGS.find((s) => s.id === "qiannian")!;
    const melody = qn.notes.filter((n) => n.midi >= 67 && !(n.midi === 67 && n.beat % 4 === 2)).map((n) => n.midi);
    expect(melody).toEqual(QN_JIANPU.trim().split(/\s+/).map((d) => QN_DEGREE[d]));
  });
  it("has the four songs", () => {
    expect(SONGS.map((s) => s.id)).toEqual(["fur-elise", "canon", "twinkle", "qiannian"]);
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
      it("revolution lasts 15-80s", () => {
        const sec = (60 * s.beatsPerRevolution) / s.bpm;
        expect(sec).toBeGreaterThanOrEqual(15);
        expect(sec).toBeLessThanOrEqual(80);
      });
    });
  }
});
