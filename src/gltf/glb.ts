export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array;
  indices: Uint16Array | Uint32Array;
}
export interface MaterialData {
  baseColorFactor: [number, number, number, number];
  metallic: number;
  roughness: number;
  baseColorImage?: Blob;
  normalImage?: Blob;
  metallicRoughnessImage?: Blob;
  alphaMode: "OPAQUE" | "BLEND";
}
export interface PartData {
  name: string;
  primitives: { mesh: MeshData; material: MaterialData }[];
  /** local-to-parent, column-major */
  matrix: Float32Array;
  parent: string | null;
  extras: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CTOR: Record<number, { new (b: ArrayBuffer, o: number, n: number): ArrayLike<number> }> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function split(buffer: ArrayBuffer): { json: J; bin: ArrayBuffer } {
  if (buffer.byteLength < 20) throw new Error("Not a glTF binary: file too short");
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("Not a glTF binary (bad magic, expected 'glTF')");
  if (dv.getUint32(4, true) !== 2) throw new Error("Unsupported glTF version " + dv.getUint32(4, true));
  let off = 12;
  let json: J = null;
  let bin: ArrayBuffer | null = null;
  const total = Math.min(dv.getUint32(8, true), buffer.byteLength);
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, len)));
    else if (type === 0x004e4942 && !bin) bin = buffer.slice(start, start + len);
    off = start + ((len + 3) & ~3);
  }
  if (!json) throw new Error("glTF: missing JSON chunk");
  if (!bin) throw new Error("glTF: missing BIN chunk");
  return { json, bin };
}

type V3 = [number, number, number];
function composeTRS(t: V3 = [0, 0, 0], q: [number, number, number, number] = [0, 0, 0, 1], s: V3 = [1, 1, 1]): Float32Array {
  const [x, y, z, w] = q;
  const m = new Float32Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

export function parseGlb(buffer: ArrayBuffer): Map<string, PartData> {
  const { json, bin } = split(buffer);
  if ((json.buffers?.length ?? 0) > 1) throw new Error("glTF: multiple buffers are not supported");
  if (json.buffers?.[0]?.uri !== undefined) throw new Error("glTF: external buffer uri is not supported");

  const readAccessor = (idx: number): { data: ArrayLike<number> & { length: number }; comps: number; count: number } => {
    const a = json.accessors[idx];
    if (a.sparse) throw new Error("glTF: sparse accessors are not supported");
    if (a.bufferView === undefined) throw new Error("glTF: accessor without bufferView is not supported");
    const bv = json.bufferViews[a.bufferView];
    if (bv.buffer !== 0) throw new Error("glTF: multiple buffers are not supported");
    const comps = COMPONENTS[a.type];
    const Ctor = CTOR[a.componentType];
    if (!comps || !Ctor) throw new Error(`glTF: unsupported accessor ${a.type}/${a.componentType}`);
    const esize = SIZE[a.componentType]!;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = bv.byteStride ?? comps * esize;
    const n = a.count;
    if (stride === comps * esize) {
      // copy into an aligned buffer
      const out = new Ctor(bin.slice(base, base + n * comps * esize), 0, n * comps);
      return { data: out, comps, count: n };
    }
    const out = new (Ctor as any)(n * comps);
    const dv = new DataView(bin);
    for (let i = 0; i < n; i++) for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * esize;
      out[i * comps + c] = a.componentType === 5126 ? dv.getFloat32(o, true)
        : esize === 4 ? dv.getUint32(o, true) : esize === 2 ? dv.getUint16(o, true) : dv.getUint8(o);
    }
    return { data: out, comps, count: n };
  };

  const imageBlob = (texInfo: J): Blob | undefined => {
    if (!texInfo) return undefined;
    const tex = json.textures[texInfo.index];
    const img = json.images[tex.source];
    if (img.uri !== undefined) throw new Error("glTF: external image uri is not supported");
    const bv = json.bufferViews[img.bufferView];
    const start = bv.byteOffset ?? 0;
    return new Blob([new Uint8Array(bin, start, bv.byteLength)], { type: img.mimeType ?? "image/png" });
  };
  const blobCache = new Map<string, Blob | undefined>();
  const cached = (key: string, texInfo: J) => {
    if (!blobCache.has(key)) blobCache.set(key, imageBlob(texInfo));
    return blobCache.get(key);
  };

  const materials = new Map<number, MaterialData>();
  const material = (idx: number | undefined): MaterialData => {
    const key = idx ?? -1;
    let m = materials.get(key);
    if (m) return m;
    const src = idx === undefined ? {} : json.materials[idx];
    const pbr = src.pbrMetallicRoughness ?? {};
    m = {
      baseColorFactor: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      baseColorImage: cached(`bc${key}`, pbr.baseColorTexture),
      normalImage: cached(`n${key}`, src.normalTexture),
      metallicRoughnessImage: cached(`mr${key}`, pbr.metallicRoughnessTexture),
      alphaMode: src.alphaMode === "BLEND" ? "BLEND" : "OPAQUE",
    };
    materials.set(key, m);
    return m;
  };

  const parents = new Map<number, number>();
  (json.nodes as J[]).forEach((n, i) => (n.children ?? []).forEach((c: number) => parents.set(c, i)));

  const out = new Map<string, PartData>();
  (json.nodes as J[]).forEach((node, i) => {
    if (node.mesh === undefined) return;
    const name: string = node.name ?? `node${i}`;
    const mesh = json.meshes[node.mesh];
    const primitives = (mesh.primitives as J[]).map((p) => {
      if ((p.mode ?? 4) !== 4) throw new Error(`glTF: non-triangle primitive mode ${p.mode} in ${name}`);
      if (p.indices === undefined) throw new Error(`glTF: non-indexed primitive in ${name} is not supported`);
      if (p.attributes.POSITION === undefined) throw new Error(`glTF: primitive without POSITION in ${name}`);
      const pos = readAccessor(p.attributes.POSITION);
      const n = pos.count;
      const f32 = (attr: string, comps: number) => {
        if (p.attributes[attr] === undefined) return new Float32Array(n * comps);
        const a = readAccessor(p.attributes[attr]);
        if (a.comps !== comps || !(a.data instanceof Float32Array)) throw new Error(`glTF: ${attr} must be float VEC${comps} in ${name}`);
        return a.data;
      };
      const idx = readAccessor(p.indices).data;
      const indices = idx instanceof Uint16Array || idx instanceof Uint32Array ? idx : Uint32Array.from(idx as ArrayLike<number>);
      return {
        mesh: {
          positions: pos.data as Float32Array,
          normals: f32("NORMAL", 3),
          uvs: f32("TEXCOORD_0", 2),
          tangents: f32("TANGENT", 4),
          indices,
        } satisfies MeshData,
        material: material(p.material),
      };
    });
    const matrix = node.matrix ? Float32Array.from(node.matrix as number[]) : composeTRS(node.translation, node.rotation, node.scale);
    const pi = parents.get(i);
    out.set(name, {
      name, primitives, matrix,
      parent: pi === undefined ? null : (json.nodes[pi].name ?? `node${pi}`),
      extras: node.extras ?? {},
    });
  });
  return out;
}
