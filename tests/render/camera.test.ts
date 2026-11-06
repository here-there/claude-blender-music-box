import { describe, it, expect } from "vitest";
import { DEFAULT_ORBIT, clampOrbit, cameraMatrices } from "../../src/render/camera";

describe("camera", () => {
  it("clamps pitch and distance to the upper limits", () => {
    const c = clampOrbit({ ...DEFAULT_ORBIT, pitch: 3, distance: 5 });
    expect(c.pitch).toBe(1.45);
    expect(c.distance).toBe(0.6);
  });
  it("clamps pitch and distance to the lower limits", () => {
    const c = clampOrbit({ ...DEFAULT_ORBIT, pitch: -3, distance: 0.01 });
    expect(c.pitch).toBe(-1.3);
    expect(c.distance).toBe(0.12);
  });
  it("leaves in-range values and does not mutate the input", () => {
    const s = { ...DEFAULT_ORBIT, target: [0, 0, 0] as [number, number, number] };
    const c = clampOrbit(s);
    expect(c).toEqual(s);
    expect(c).not.toBe(s);
  });
  it("default orbit is a 3/4 top-down view inside the limits", () => {
    expect(clampOrbit(DEFAULT_ORBIT)).toEqual(DEFAULT_ORBIT);
    expect(DEFAULT_ORBIT.pitch).toBeGreaterThan(0.3);
    expect(Math.abs(DEFAULT_ORBIT.yaw)).toBeGreaterThan(0.2);
  });
  it("camera position sits at distance from the target, above it", () => {
    const { view, viewProjection, position } = cameraMatrices(DEFAULT_ORBIT, 16 / 9);
    expect(view.length).toBe(16);
    expect(viewProjection.length).toBe(16);
    const t = DEFAULT_ORBIT.target;
    const d = Math.hypot(position[0]! - t[0], position[1]! - t[1], position[2]! - t[2]);
    expect(d).toBeCloseTo(DEFAULT_ORBIT.distance, 4);
    expect(position[1]!).toBeGreaterThan(t[1]);
  });
  it("cameraMatrices clamps out-of-range orbit", () => {
    const { position } = cameraMatrices({ ...DEFAULT_ORBIT, distance: 50 }, 1);
    const t = DEFAULT_ORBIT.target;
    expect(Math.hypot(position[0]! - t[0], position[1]! - t[1], position[2]! - t[2])).toBeCloseTo(0.6, 4);
  });
});

describe("dampOrbit", () => {
  it("moves toward the goal by 1 − e^(−dt/τ) and leaves dt = 0 untouched", async () => {
    const { dampOrbit } = await import("../../src/render/camera");
    const cur = { yaw: 0, pitch: 0, distance: 0.2, target: [0, 0, 0] as [number, number, number] };
    const goal = { yaw: 1, pitch: 0.5, distance: 0.4, target: [1, 2, 3] as [number, number, number] };
    dampOrbit(cur, goal, 0);
    expect(cur.yaw).toBe(0);
    dampOrbit(cur, goal, 0.12, 0.12);
    const k = 1 - Math.exp(-1);
    expect(cur.yaw).toBeCloseTo(k, 9);
    expect(cur.distance).toBeCloseTo(0.2 + 0.2 * k, 9);
    expect(cur.target[2]).toBeCloseTo(3 * k, 9);
    for (let i = 0; i < 200; i++) dampOrbit(cur, goal, 1 / 60, 0.12);
    expect(cur.pitch).toBeCloseTo(0.5, 6);
  });
});
