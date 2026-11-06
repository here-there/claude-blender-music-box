import { compute, sampler, texture, type Gpu, type Texture } from "vgpu";
import type { Vec3 } from "../meta";
import envShader from "./shaders/environment.wgsl";

/** Cube edge of the irradiance map (one mip). */
export const IRRADIANCE_SIZE = 64;
/** Cube edge of the prefiltered specular map's mip 0. */
export const SPECULAR_SIZE = 128;
/** Prefiltered specular mips: roughness = level / (SPECULAR_LEVELS − 1). */
export const SPECULAR_LEVELS = 5;

const SOURCE_SIZE = 128;
const SOURCE_LEVELS = Math.log2(SOURCE_SIZE) + 1; // full chain down to 1², sampled by the convolutions
const FORMAT: GPUTextureFormat = "rgba16float";
const WORKGROUP = 8;
const SPECULAR_SAMPLES = 512;
const IRRADIANCE_SAMPLES = 1024;

export interface Environment {
  /** 6-layer 2d-array (bind as a cube via `cubeView`): cosine-convolved radiance, E / π. */
  irradiance: Texture;
  /** 6-layer 2d-array with SPECULAR_LEVELS mips (bind as a cube via `cubeView`): GGX-prefiltered radiance. */
  specular: Texture;
}

type BakeValues = { keyDirection: Vec3; size: number; samples: number; roughness: number; sourceSize: number; pad0: number; pad1: number };

/**
 * Bakes the procedural warm-interior environment once at startup with compute (four dispatch kinds,
 * ~14 dispatches total): an analytic radiance cube with a full mip chain, then GGX prefiltering into the
 * specular cube and cosine convolution into the irradiance cube. The BRDF LUT is analytic (Karis) in WGSL.
 */
export function createEnvironment(gpu: Gpu, keyDirection: Vec3 = [-0.3668, 0.8151, 0.4483]): Environment {
  const cube = (size: number, mipLevelCount: number, label: string): Texture =>
    texture(gpu, {
      kind: "2d-array", size: [size, size], layers: 6, format: FORMAT, mipLevelCount, label,
      usage: ["texture_binding", "storage_binding", "copy_src"],
    });
  const source = cube(SOURCE_SIZE, SOURCE_LEVELS, "env-source");
  const specular = cube(SPECULAR_SIZE, SPECULAR_LEVELS, "env-specular");
  const irradiance = cube(IRRADIANCE_SIZE, 1, "env-irradiance");

  const mipView = (t: Texture, level: number): GPUTextureView =>
    t.createView({ dimension: "2d-array", baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 6 });
  const sourceCube = source.createView({ dimension: "cube", label: "env-source.cube" });
  const linear = sampler(gpu, {
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear",
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge",
  });
  const bake = (size: number, samples: number, roughness = 0): BakeValues =>
    ({ keyDirection, size, samples, roughness, sourceSize: SOURCE_SIZE, pad0: 0, pad1: 0 });
  const groups = (size: number): number => Math.ceil(size / WORKGROUP);

  // 1. Analytic radiance, every mip supersampled from the function itself (box-filter footprint ≈ 2^level texels).
  const gen = compute(gpu, envShader, { entry: "cs_source", label: "env-source" });
  for (let level = 0; level < SOURCE_LEVELS; level++) {
    const size = SOURCE_SIZE >> level;
    gen.set({ bake: bake(size, Math.min(8, Math.max(2, 1 << level))), dst: mipView(source, level) });
    gen.dispatch(groups(size), groups(size), 6);
  }

  // 2. GGX prefilter: one roughness per mip.
  const pre = compute(gpu, envShader, { entry: "cs_specular", label: "env-specular", set: { source: sourceCube, sourceSampler: linear } });
  for (let level = 0; level < SPECULAR_LEVELS; level++) {
    const size = SPECULAR_SIZE >> level;
    pre.set({ bake: bake(size, SPECULAR_SAMPLES, level / (SPECULAR_LEVELS - 1)), dst: mipView(specular, level) });
    pre.dispatch(groups(size), groups(size), 6);
  }

  // 3. Diffuse irradiance.
  const irr = compute(gpu, envShader, { entry: "cs_irradiance", label: "env-irradiance", set: { source: sourceCube, sourceSampler: linear } });
  irr.set({ bake: bake(IRRADIANCE_SIZE, IRRADIANCE_SAMPLES), dst: mipView(irradiance, 0) });
  irr.dispatch(groups(IRRADIANCE_SIZE), groups(IRRADIANCE_SIZE), 6);

  gen.dispose();
  pre.dispose();
  irr.dispose();
  source.destroy(); // already-submitted dispatches still complete
  return { irradiance, specular };
}

/** Cube view of a 6-layer environment texture for `texture_cube<f32>` bindings (all mips). */
export function envCubeView(t: Texture): GPUTextureView {
  return t.createView({ dimension: "cube", label: `${t.label ?? "env"}.cube` });
}
