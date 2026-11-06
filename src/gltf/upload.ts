import { geometry, texture, type Gpu, type Geometry, type Texture } from "vgpu";
import type { PartData } from "./glb";

export interface GpuPrimitive {
  geometry: Geometry;
  textures: { baseColor: Texture; normal: Texture; metallicRoughness: Texture };
  factors: { baseColor: [number, number, number, number]; metallic: number; roughness: number };
  blend: boolean;
}
export interface GpuPart {
  primitives: GpuPrimitive[];
  matrix: Float32Array;
  extras: Record<string, unknown>;
}
export interface UploadOptions {
  /** Return null when decoding is unavailable (Node/mock): 1x1 default textures are used. */
  decodeImage?: (blob: Blob) => Promise<ImageBitmap | null>;
}

const defaultDecode = async (blob: Blob): Promise<ImageBitmap | null> =>
  typeof createImageBitmap === "function" ? createImageBitmap(blob, { colorSpaceConversion: "none" }) : null;

type Kind = "baseColor" | "normal" | "metallicRoughness";
const FORMAT: Record<Kind, GPUTextureFormat> = {
  baseColor: "rgba8unorm-srgb", normal: "rgba8unorm", metallicRoughness: "rgba8unorm",
};
// white / flat normal / ORM (occlusion 1, roughness 1, metallic 1: factors then control)
const DEFAULT_PIXEL: Record<Kind, [number, number, number, number]> = {
  baseColor: [255, 255, 255, 255], normal: [128, 128, 255, 255], metallicRoughness: [255, 255, 255, 255],
};
const USAGE = ["texture_binding", "copy_dst", "render_attachment"] as const;

function defaultTexture(gpu: Gpu, kind: Kind): Texture {
  const t = texture(gpu, { kind: "2d", size: [1, 1], format: FORMAT[kind], usage: USAGE, label: `default-${kind}` });
  gpu.gpu.queue.writeTexture({ texture: t.gpu }, new Uint8Array(DEFAULT_PIXEL[kind]), { bytesPerRow: 4 }, [1, 1]);
  return t;
}

async function imageTexture(gpu: Gpu, bmp: ImageBitmap, kind: Kind, label: string): Promise<Texture> {
  const w = bmp.width, h = bmp.height;
  const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
  const t = texture(gpu, { kind: "2d", size: [w, h], format: FORMAT[kind], usage: USAGE, mipLevelCount: levels, label });
  // No built-in mip generation in vgpu: downscale the bitmap per level with the browser's resizer.
  for (let level = 0; level < levels; level++) {
    const lw = Math.max(1, w >> level), lh = Math.max(1, h >> level);
    const src = level === 0 ? bmp
      : await createImageBitmap(bmp, { resizeWidth: lw, resizeHeight: lh, resizeQuality: "high", colorSpaceConversion: "none" });
    gpu.gpu.queue.copyExternalImageToTexture({ source: src }, { texture: t.gpu, mipLevel: level }, [lw, lh]);
    if (src !== bmp) src.close();
  }
  bmp.close();
  return t;
}

export async function uploadModel(
  gpu: Gpu,
  parts: Map<string, PartData>,
  opts: UploadOptions = {},
): Promise<Map<string, GpuPart>> {
  const decode = opts.decodeImage ?? defaultDecode;
  const defaults = {} as Record<Kind, Texture>;
  for (const k of ["baseColor", "normal", "metallicRoughness"] as const) defaults[k] = defaultTexture(gpu, k);
  const cache = new Map<Blob, Texture>();

  const load = async (blob: Blob | undefined, kind: Kind, label: string): Promise<Texture> => {
    if (!blob) return defaults[kind];
    const hit = cache.get(blob);
    if (hit) return hit;
    const bmp = await decode(blob);
    const t = bmp ? await imageTexture(gpu, bmp, kind, label) : defaults[kind];
    cache.set(blob, t);
    return t;
  };

  const out = new Map<string, GpuPart>();
  for (const [name, part] of parts) {
    const primitives: GpuPrimitive[] = [];
    for (const [i, { mesh, material }] of part.primitives.entries()) {
      const n = mesh.positions.length / 3;
      const interleaved = new Float32Array(n * 12);
      for (let v = 0; v < n; v++) {
        interleaved.set(mesh.positions.subarray(v * 3, v * 3 + 3), v * 12);
        interleaved.set(mesh.normals.subarray(v * 3, v * 3 + 3), v * 12 + 3);
        interleaved.set(mesh.uvs.subarray(v * 2, v * 2 + 2), v * 12 + 6);
        interleaved.set(mesh.tangents.subarray(v * 4, v * 4 + 4), v * 12 + 8);
      }
      const geo = geometry(gpu, {
        label: `${name}.${i}`,
        buffers: [{
          data: interleaved,
          stride: 48,
          attributes: {
            position: { format: "float32x3", offset: 0, location: 0 },
            normal: { format: "float32x3", offset: 12, location: 1 },
            uv: { format: "float32x2", offset: 24, location: 2 },
            tangent: { format: "float32x4", offset: 32, location: 3 },
          },
        }],
        indices: mesh.indices,
      });
      primitives.push({
        geometry: geo,
        textures: {
          baseColor: await load(material.baseColorImage, "baseColor", `${name}.${i}.baseColor`),
          normal: await load(material.normalImage, "normal", `${name}.${i}.normal`),
          metallicRoughness: await load(material.metallicRoughnessImage, "metallicRoughness", `${name}.${i}.mr`),
        },
        factors: { baseColor: material.baseColorFactor, metallic: material.metallic, roughness: material.roughness },
        blend: material.alphaMode === "BLEND",
      });
    }
    out.set(name, { primitives, matrix: part.matrix, extras: part.extras });
  }
  return out;
}
