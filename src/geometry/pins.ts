import type { MeshData } from "../gltf/glb";
import type { MusicBoxMeta } from "../meta";
import type { ArrangedPin, Song } from "../songs/types";

const SEGMENTS = 8;

/** Cylinder along +Y (radially outward), base at y = 0, rounded dome top ending at y = height. */
export function pinMesh(radius = 1, height = 1): MeshData {
  const dome = Math.min(radius, height * 0.5);
  const yb = height - dome;
  // Rings: [y, ringRadius, normalRadialComponent, normalYComponent]
  const rings: [number, number, number, number][] = [[0, radius, 1, 0], [yb, radius, 1, 0]];
  for (const deg of [30, 60, 90]) {
    const th = (deg * Math.PI) / 180;
    const nr = Math.cos(th) / radius, ny = Math.sin(th) / dome;
    const l = Math.hypot(nr, ny);
    rings.push([yb + dome * Math.sin(th), radius * Math.cos(th), nr / l, ny / l]);
  }
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], tan: number[] = [], idx: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    const [y, rr, nr, ny] = rings[r]!;
    for (let s = 0; s <= SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      pos.push(rr * c, y, rr * sn);
      nor.push(nr * c, ny, nr * sn);
      uv.push(s / SEGMENTS, y / height);
      tan.push(-sn, 0, c, 1);
    }
  }
  const stride = SEGMENTS + 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = r * stride + s, b = a + 1, c = a + stride, d = c + 1;
      // outward-facing CCW; the final ring has radius 0 so its triangle degenerates harmlessly
      idx.push(a, c, b, b, c, d);
    }
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    uvs: new Float32Array(uv),
    tangents: new Float32Array(tan),
    indices: new Uint16Array(idx),
  };
}

/**
 * Per instance: [x, angle0, tooth, 0]. Per Ruling R6 the renderer uses cylinderAngle = -2*pi*phase,
 * so world angle = angle0 + cylinderAngle equals pluckAngle (mod 2pi) at phase = beat / bpr.
 */
export function pinInstances(meta: MusicBoxMeta, song: Song, pins: readonly ArrangedPin[]): Float32Array {
  const out = new Float32Array(pins.length * 4);
  pins.forEach((p, i) => {
    out[i * 4] = meta.comb.teeth[p.tooth]!.x;
    out[i * 4 + 1] = meta.pluckAngle + (2 * Math.PI * p.beat) / song.beatsPerRevolution;
    out[i * 4 + 2] = p.tooth;
  });
  return out;
}
