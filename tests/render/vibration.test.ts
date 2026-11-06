import { describe, it, expect } from "vitest";
import { toothDisplacement, visFrequency, decayTau, PUSH_SECONDS, BASE_AMPLITUDE } from "../../src/render/vibration";

describe("toothDisplacement", () => {
  it("is zero at the root (u = 0) for any time", () => {
    for (const t of [-0.1, -0.03, -0.01, 0, 0.013, 0.5, 2]) {
      expect(toothDisplacement(t, 1, 7, 0)).toBe(0);
    }
  });

  it("is zero before the push-up window", () => {
    expect(toothDisplacement(-0.05, 1, 3, 1)).toBe(0);
    expect(toothDisplacement(-1, 1, 3, 1)).toBe(0);
  });

  it("ramps linearly while the pin pushes the tooth up", () => {
    for (const u of [0.25, 0.5, 1]) {
      expect(toothDisplacement(-0.02, 1, 5, u)).toBeCloseTo(0.0006 * 0.5 * u * u, 12);
    }
    expect(PUSH_SECONDS).toBe(0.04);
    expect(BASE_AMPLITUDE).toBe(0.0006);
  });

  it("is continuous at t = 0", () => {
    const left = toothDisplacement(-1e-9, 0.8, 9, 1);
    const right = toothDisplacement(0, 0.8, 9, 1);
    expect(right).toBeCloseTo(0.0006 * 0.8, 12);
    expect(Math.abs(left - right)).toBeLessThan(1e-10);
  });

  it("scales with amplitude", () => {
    expect(toothDisplacement(0.03, 0.5, 2, 1)).toBeCloseTo(0.5 * toothDisplacement(0.03, 1, 2, 1), 12);
  });

  // NOTE: the brief asks for "< 5% at t = 3 s on the bass tooth", but with the verbatim τ = 1.2 s the bass
  // envelope at 3 s is e^-2.5 ≈ 8.2%. The formula is kept verbatim; the bass tooth crosses 5% at 3τ = 3.6 s,
  // and every tooth with τ < 1 s (index ≥ 5, incl. the treble end) is below 5% by 3 s.
  const peakAfter = (tooth: number, from: number): number => {
    let peak = 0;
    for (let t = from; t < from + 0.5; t += 0.0005) peak = Math.max(peak, Math.abs(toothDisplacement(t, 1, tooth, 1)));
    return peak;
  };
  it("decays to a small fraction of the initial value within a few seconds", () => {
    const initial = toothDisplacement(0, 1, 0, 1);
    expect(peakAfter(0, 3)).toBeLessThan(0.1 * initial); // bass: ≈ 8.2% at 3 s
    expect(peakAfter(0, 3.6)).toBeLessThan(0.05 * initial); // bass: < 5% from 3τ = 3.6 s
    for (let tooth = 5; tooth < 18; tooth++) expect(peakAfter(tooth, 3)).toBeLessThan(0.05 * initial);
  });

  it("uses higher visual frequency and shorter decay for treble teeth", () => {
    expect(visFrequency(0)).toBeCloseTo(6);
    expect(visFrequency(17)).toBeCloseTo(16);
    expect(decayTau(0)).toBeCloseTo(1.2);
    expect(decayTau(17)).toBeCloseTo(0.4);
    // first zero crossing comes sooner on the treble tooth
    const firstZero = (tooth: number): number => {
      for (let t = 0; t < 1; t += 1e-4) if (toothDisplacement(t, 1, tooth, 1) <= 0) return t;
      return Infinity;
    };
    expect(firstZero(17)).toBeLessThan(firstZero(0));
    expect(firstZero(0)).toBeCloseTo(1 / (4 * 6), 3);
  });
});
