import type { MeshData } from "../gltf/glb";
import type { MusicBoxMeta } from "../meta";

/**
 * Unit tooth: root at z = 0, tip at z = -1 (scaled by instance length), top surface at y = 0,
 * underside at y = -thickness, width centred on x = 0. The last 10% tapers to 80% width, and
 * the tip face is chamfered on the top edge. Flat-shaded.
 */
export function toothMesh(width = 1, thickness = 1): MeshData {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], tan: number[] = [], idx: number[] = [];
  const hw = width / 2, hwTip = hw * 0.8, t = thickness;
  const zTaper = -0.9, zTip = -1;
  const chamfer = Math.min(t * 0.4, 0.5 * t);
  type V = [number, number, number];

  // Quad a,b,c,d counter-clockwise seen from outside; normal = (b-a) x (d-a) normalised.
  // The solid is convex, so each quad is auto-oriented to face away from an interior point.
  const inside: V = [0, -t / 2, -0.5];
  const quad = (a0: V, b0: V, c0: V, d0: V, u0: number, v0: number, u1: number, v1: number) => {
    let [a, b, c, d] = [a0, b0, c0, d0];
    const cross = (p: V, q: V, r: V): V => {
      const x: V = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], y: V = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      return [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    };
    const n0 = cross(a, b, d);
    const toward = [a, b, c, d].reduce((acc, p) => acc + (p[0] - inside[0]) * n0[0] + (p[1] - inside[1]) * n0[1] + (p[2] - inside[2]) * n0[2], 0);
    if (toward < 0) [b, d] = [d, b];
    const e1: V = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: V = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n: V = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(...n) || 1;
    const el = Math.hypot(...e1) || 1;
    const base = pos.length / 3;
    const uvs = [u0, v0, u1, v0, u1, v1, u0, v1];
    [a, b, c, d].forEach((p, k) => {
      pos.push(...p);
      nor.push(n[0] / nl, n[1] / nl, n[2] / nl);
      uv.push(uvs[k * 2]!, uvs[k * 2 + 1]!);
      tan.push(e1[0] / el, e1[1] / el, e1[2] / el, 1);
    });
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const yTop = 0, yBot = -t;
  // Top: root -> taper start -> chamfer start; viewed from +Y, x to the right, z going -Z.
  const zCh = zTip + 0.02;
  const sections: { z: number; hw: number }[] = [
    { z: 0, hw },
    { z: zTaper, hw },
    { z: zCh, hw: hwTip },
  ];
  for (let i = 0; i < sections.length - 1; i++) {
    const s0 = sections[i]!, s1 = sections[i + 1]!;
    const v0 = -s0.z, v1 = -s1.z;
    // top (+Y): order -x@s0, +x@s0, +x@s1, -x@s1 gives n = +Y
    quad([-s0.hw, yTop, s0.z], [-s1.hw, yTop, s1.z], [s1.hw, yTop, s1.z], [s0.hw, yTop, s0.z], 0, v0, 1, v1);
    // bottom (-Y)
    quad([-s0.hw, yBot, s0.z], [s0.hw, yBot, s0.z], [s1.hw, yBot, s1.z], [-s1.hw, yBot, s1.z], 0, v0, 1, v1);
    // +X side
    quad([s0.hw, yBot, s0.z], [s0.hw, yTop, s0.z], [s1.hw, yTop, s1.z], [s1.hw, yBot, s1.z], 0, v0, 1, v1);
    // -X side
    quad([-s0.hw, yBot, s0.z], [-s1.hw, yBot, s1.z], [-s1.hw, yTop, s1.z], [-s0.hw, yTop, s0.z], 0, v0, 1, v1);
  }
  // Tip chamfer (top edge) and tip face and bottom tip strip.
  const yCh = yTop - chamfer;
  quad([-hwTip, yTop, zCh], [-hwTip, yCh, zTip], [hwTip, yCh, zTip], [hwTip, yTop, zCh], 0, 0.98, 1, 1);
  quad([-hwTip, yBot, zCh], [hwTip, yBot, zCh], [hwTip, yBot, zTip], [-hwTip, yBot, zTip], 0, 0.98, 1, 1);
  quad([hwTip, yBot, zCh], [hwTip, yTop, zCh], [hwTip, yCh, zTip], [hwTip, yBot, zTip], 0, 0.98, 1, 1);
  quad([-hwTip, yBot, zCh], [-hwTip, yBot, zTip], [-hwTip, yCh, zTip], [-hwTip, yTop, zCh], 0, 0.98, 1, 1);
  // Tip face (-Z)
  quad([hwTip, yBot, zTip], [hwTip, yCh, zTip], [-hwTip, yCh, zTip], [-hwTip, yBot, zTip], 0, 0, 1, 1);
  // Root face (+Z)
  quad([-hw, yBot, 0], [hw, yBot, 0], [hw, yTop, 0], [-hw, yTop, 0], 0, 0, 1, 1);

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    uvs: new Float32Array(uv),
    tangents: new Float32Array(tan),
    indices: new Uint16Array(idx),
  };
}

/** Per instance: [x, length, toothIndex, 0]. */
export function toothInstances(meta: MusicBoxMeta): Float32Array {
  const out = new Float32Array(meta.comb.teeth.length * 4);
  meta.comb.teeth.forEach((t, i) => {
    out[i * 4] = t.x;
    out[i * 4 + 1] = t.length;
    out[i * 4 + 2] = i;
  });
  return out;
}
