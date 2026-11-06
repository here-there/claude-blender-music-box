import { describe, expect, it } from "vitest";
import { pickMatrix } from "../../src/render/pick";

/** Column-major 4x4 times vec4. */
function apply(m: Float32Array, v: [number, number, number, number]): [number, number, number, number] {
  const r: [number, number, number, number] = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) r[row] = r[row]! + m[col * 4 + row]! * v[col]!;
  return r;
}
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ndc = (c: [number, number, number, number]) => [c[0] / c[3], c[1] / c[3], c[2] / c[3]];

describe("pickMatrix", () => {
  // target 200x100 px, picking pixel (30, 70): its centre in NDC is x = 2*30.5/200-1, y = 1-2*70.5/100
  const W = 200, H = 100, px = 30, py = 70;
  const cx = (2 * (px + 0.5)) / W - 1, cy = 1 - (2 * (py + 0.5)) / H;

  it("maps the picked pixel's centre to the centre of the 1x1 target", () => {
    const m = pickMatrix(px, py, W, H, identity, new Float32Array(16));
    const p = ndc(apply(m, [cx, cy, 0.3, 1]));
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(0.3, 6); // depth untouched
  });

  it("maps the picked pixel's edges to the 1x1 target's edges", () => {
    const m = pickMatrix(px, py, W, H, identity, new Float32Array(16));
    expect(ndc(apply(m, [cx - 1 / W, cy, 0, 1]))[0]).toBeCloseTo(-1, 5);
    expect(ndc(apply(m, [cx + 1 / W, cy, 0, 1]))[0]).toBeCloseTo(1, 5);
    expect(ndc(apply(m, [cx, cy + 1 / H, 0, 1]))[1]).toBeCloseTo(1, 5);
    expect(ndc(apply(m, [cx, cy - 1 / H, 0, 1]))[1]).toBeCloseTo(-1, 5);
  });

  it("composes with the camera's viewProjection (works with perspective w != 1)", () => {
    const vp = new Float32Array([1.2, 0.1, 0, 0.2, -0.3, 0.9, 0.05, 0.1, 0.4, 0.2, 1.1, -1, 0.5, -0.2, 0.3, 2]);
    const world: [number, number, number, number] = [0.3, -0.7, 0.2, 1];
    const clip = apply(vp, world);
    const [x, y] = ndc(clip);
    // pixel containing this world point, and its offset from that pixel's centre in pixels
    const fx = ((x! + 1) / 2) * W - 0.5, fy = ((1 - y!) / 2) * H - 0.5;
    const m = pickMatrix(Math.round(fx), Math.round(fy), W, H, vp, new Float32Array(16));
    const q = ndc(apply(m, world));
    expect(q[0]).toBeCloseTo((fx - Math.round(fx)) * 2, 4);
    expect(q[1]).toBeCloseTo(-(fy - Math.round(fy)) * 2, 4);
  });

  it("writes into and returns the out array", () => {
    const out = new Float32Array(16);
    expect(pickMatrix(0, 0, 10, 10, identity, out)).toBe(out);
  });
});
