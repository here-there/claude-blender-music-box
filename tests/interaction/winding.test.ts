import { describe, it, expect } from "vitest";
import { cssToTargetPixel, pointerAngle, projectToCss, ratchetDelta } from "../../src/interaction/winding";

describe("cssToTargetPixel", () => {
  const rect = { left: 0, top: 0, width: 100, height: 50 };
  it("scales CSS pixels to target pixels and clamps to the last pixel", () => {
    expect(cssToTargetPixel(50, 25, rect, [200, 100])).toEqual([100, 50]);
    expect(cssToTargetPixel(100, 50, rect, [200, 100])).toEqual([199, 99]);
    expect(cssToTargetPixel(1000, 1000, rect, [200, 100])).toEqual([199, 99]);
  });
  it("respects the canvas offset, floors, and clamps below zero", () => {
    expect(cssToTargetPixel(10.9, 20.9, { left: 10, top: 20, width: 100, height: 50 }, [200, 100])).toEqual([1, 1]);
    expect(cssToTargetPixel(-5, -5, rect, [200, 100])).toEqual([0, 0]);
  });
});

describe("pointerAngle", () => {
  it("is atan2 of the offset from the centre (screen y down)", () => {
    expect(pointerAngle(2, 1, 1, 1)).toBeCloseTo(0, 9);
    expect(pointerAngle(1, 2, 1, 1)).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(pointerAngle(0, 1, 1, 1))).toBeCloseTo(Math.PI, 9);
  });
});

describe("ratchetDelta", () => {
  it("passes forward motion", () => {
    expect(ratchetDelta(0.1, 0.3)).toBeCloseTo(0.2, 9);
  });
  it("blocks backward motion", () => {
    expect(ratchetDelta(0.3, 0.1)).toBe(0);
  });
  it("takes the shortest angle across ±π", () => {
    expect(ratchetDelta(3.1, -3.1)).toBeCloseTo(2 * Math.PI - 6.2, 9);
    expect(ratchetDelta(3.1, -3.1)).toBeCloseTo(0.083, 3);
    expect(ratchetDelta(-3.1, 3.1)).toBe(0);
  });
});

describe("projectToCss", () => {
  it("maps clip space through the rect (identity viewProjection)", () => {
    const id = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const rect = { left: 10, top: 20, width: 200, height: 100 };
    expect(projectToCss(id, [0, 0, 0], rect)).toEqual([110, 70]);
    expect(projectToCss(id, [1, 1, 0], rect)).toEqual([210, 20]);
  });
  it("returns null behind the camera", () => {
    const flip = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1]);
    expect(projectToCss(flip, [0, 0, 0], { left: 0, top: 0, width: 1, height: 1 })).toBeNull();
  });
});
