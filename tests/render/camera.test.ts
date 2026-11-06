import { describe, it, expect } from "vitest";
import { DEFAULT_ORBIT, FIT_ASPECT, LENS, MAX_FOV, clampOrbit, cameraMatrices, framingForAspect, resetOrbit } from "../../src/render/camera";

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
  it("resetOrbit takes the shortest way to the default yaw", () => {
    const turns = 6 * Math.PI;
    const r = resetOrbit({ ...DEFAULT_ORBIT, yaw: DEFAULT_ORBIT.yaw + turns + 0.3, target: [0, 0, 0] });
    expect(r.yaw).toBeCloseTo(DEFAULT_ORBIT.yaw + turns, 9);
    expect(Math.abs(r.yaw - (DEFAULT_ORBIT.yaw + turns + 0.3))).toBeLessThan(0.31);
    expect(r.pitch).toBe(DEFAULT_ORBIT.pitch);
    expect(r.distance).toBe(DEFAULT_ORBIT.distance);
    expect(r.target).toEqual([...DEFAULT_ORBIT.target]);
  });
});

describe("framingForAspect", () => {
  const halfH = (fov: number, aspect: number) => Math.tan((fov / 2) * (Math.PI / 180)) * aspect;
  it("leaves landscape viewports untouched", () => {
    expect(framingForAspect(16 / 9)).toEqual({ fov: LENS.fov, dolly: 1 });
    expect(framingForAspect(FIT_ASPECT)).toEqual({ fov: LENS.fov, dolly: 1 });
  });
  it("keeps the horizontal coverage of FIT_ASPECT on narrower screens", () => {
    const ref = halfH(LENS.fov, FIT_ASPECT);
    for (const aspect of [1.0, 0.75, 0.46, 0.3]) {
      const f = framingForAspect(aspect);
      expect(f.fov).toBeLessThanOrEqual(MAX_FOV + 1e-9);
      expect(f.dolly).toBeGreaterThanOrEqual(1);
      expect(halfH(f.fov, aspect) * f.dolly).toBeCloseTo(ref, 9);
    }
  });
  it("widens the lens before dollying back", () => {
    expect(framingForAspect(1.0).dolly).toBe(1);
    expect(framingForAspect(0.46).fov).toBeCloseTo(MAX_FOV, 9);
    expect(framingForAspect(0.46).dolly).toBeGreaterThan(1);
  });
  it("moves the camera back on a phone in portrait", () => {
    const t = DEFAULT_ORBIT.target;
    const dist = (p: Float32Array) => Math.hypot(p[0]! - t[0], p[1]! - t[1], p[2]! - t[2]);
    const wide = dist(cameraMatrices(DEFAULT_ORBIT, 16 / 9).position);
    const phone = dist(cameraMatrices(DEFAULT_ORBIT, 390 / 844).position);
    expect(wide).toBeCloseTo(DEFAULT_ORBIT.distance, 5);
    expect(phone).toBeCloseTo(DEFAULT_ORBIT.distance * framingForAspect(390 / 844).dolly, 5);
  });
});
