import { describe, expect, it } from "vitest";
import { validateMeta } from "../../src/meta";
import { arrange } from "../../src/songs/arrange";
import { SONGS } from "../../src/songs/library";
import { toothInstances, toothMesh } from "../../src/geometry/comb";
import { pinInstances, pinMesh } from "../../src/geometry/pins";
import type { MeshData } from "../../src/gltf/glb";
import metaJson from "../../public/musicbox.meta.json";

const meta = validateMeta(metaJson as unknown);
const song = SONGS[0]!;
const pins = arrange(song);
const TAU = Math.PI * 2;

function checkMesh(m: MeshData) {
  const n = m.positions.length / 3;
  expect(n).toBeGreaterThan(0);
  expect(m.normals.length).toBe(n * 3);
  expect(m.uvs.length).toBe(n * 2);
  expect(m.tangents.length).toBe(n * 4);
  expect(m.indices.length % 3).toBe(0);
  for (const i of m.indices) expect(i).toBeLessThan(n);
  for (let i = 0; i < n; i++) {
    expect(Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!)).toBeCloseTo(1, 4);
    expect(Math.hypot(m.tangents[i * 4]!, m.tangents[i * 4 + 1]!, m.tangents[i * 4 + 2]!)).toBeCloseTo(1, 4);
    expect(Math.abs(m.tangents[i * 4 + 3]!)).toBe(1);
  }
  for (const v of [...m.positions, ...m.normals, ...m.uvs, ...m.tangents]) expect(Number.isFinite(v)).toBe(true);
}

describe("comb teeth", () => {
  it("instances: 18 x 4 floats with lengths from meta", () => {
    const inst = toothInstances(meta);
    expect(inst.length).toBe(18 * 4);
    meta.comb.teeth.forEach((t, i) => {
      expect(inst[i * 4]).toBeCloseTo(t.x, 6);
      expect(inst[i * 4 + 1]).toBeCloseTo(t.length, 6);
      expect(inst[i * 4 + 2]).toBe(i);
      expect(inst[i * 4 + 3]).toBe(0);
    });
  });
  it("mesh is valid, z in [-1,0], top at y=0", () => {
    const m = toothMesh();
    checkMesh(m);
    let zmin = Infinity, zmax = -Infinity, ymax = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      zmin = Math.min(zmin, m.positions[i + 2]!);
      zmax = Math.max(zmax, m.positions[i + 2]!);
      ymax = Math.max(ymax, m.positions[i + 1]!);
    }
    expect(zmin).toBeCloseTo(-1);
    expect(zmax).toBeCloseTo(0);
    expect(ymax).toBeCloseTo(0);
  });
  it("normals face outward", () => {
    const m = toothMesh();
    for (let i = 0; i < m.positions.length / 3; i++) {
      // centroid of the box is roughly (0,-0.5*t,-0.5); only check sign vs. a point inside
      const d =
        (m.positions[i * 3]! - 0) * m.normals[i * 3]! +
        (m.positions[i * 3 + 1]! + 0.5) * m.normals[i * 3 + 1]! +
        (m.positions[i * 3 + 2]! + 0.5) * m.normals[i * 3 + 2]!;
      expect(d).toBeGreaterThan(-1e-6);
    }
  });
});

function windingMatchesNormals(m: MeshData) {
  const P = m.positions, N = m.normals;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const e1 = [0, 1, 2].map((k) => P[b * 3 + k]! - P[a * 3 + k]!);
    const e2 = [0, 1, 2].map((k) => P[c * 3 + k]! - P[a * 3 + k]!);
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (Math.hypot(...n) < 1e-9) continue; // degenerate
    const d = n[0]! * N[a * 3]! + n[1]! * N[a * 3 + 1]! + n[2]! * N[a * 3 + 2]!;
    expect(d).toBeGreaterThan(0);
  }
}

describe("winding", () => {
  it("triangle winding agrees with normals", () => {
    windingMatchesNormals(toothMesh());
    windingMatchesNormals(pinMesh());
  });
});

describe("pins", () => {
  it("instances: one per arranged pin, 4 floats", () => {
    const inst = pinInstances(meta, song, pins);
    expect(inst.length).toBe(pins.length * 4);
    pins.forEach((p, i) => {
      expect(inst[i * 4]).toBeCloseTo(meta.comb.teeth[p.tooth]!.x, 6);
      expect(inst[i * 4 + 2]).toBe(p.tooth);
    });
  });
  it("beat 0 pin has angle0 === pluckAngle", () => {
    const i = pins.findIndex((p) => p.beat === 0);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(pinInstances(meta, song, pins)[i * 4 + 1]).toBeCloseTo(meta.pluckAngle, 5);
  });
  it("world angle at phase beat/bpr is pluckAngle mod 2pi (cylinderAngle = -2pi*phase)", () => {
    const inst = pinInstances(meta, song, pins);
    pins.forEach((p, i) => {
      const phase = p.beat / song.beatsPerRevolution;
      const world = inst[i * 4 + 1]! + -TAU * phase;
      const diff = (((world - meta.pluckAngle) % TAU) + TAU) % TAU;
      expect(Math.min(diff, TAU - diff)).toBeLessThan(1e-4);
    });
  });
  it("mesh is valid, 8 segments, +Y radial", () => {
    const m = pinMesh();
    checkMesh(m);
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 1; i < m.positions.length; i += 3) {
      ymin = Math.min(ymin, m.positions[i]!);
      ymax = Math.max(ymax, m.positions[i]!);
    }
    expect(ymin).toBeCloseTo(0);
    expect(ymax).toBeCloseTo(1);
  });
});
