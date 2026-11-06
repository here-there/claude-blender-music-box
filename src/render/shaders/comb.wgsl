// Instanced steel comb teeth that bend when plucked (deformation shared with the shadow pass in shadow.wgsl).
import { Scene, sampleIbl, shadePbr, shadowFactor } from "./common.wgsl";
import { Comb, lightClip, toothVertex } from "./shadow.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> comb: Comb;
@group(0) @binding(2) var irradianceMap: texture_cube<f32>;
@group(0) @binding(3) var specularMap: texture_cube<f32>;
@group(0) @binding(4) var envSampler: sampler;
@group(0) @binding(5) var shadowMap: texture_depth_2d;
@group(0) @binding(6) var shadowSampler: sampler_comparison;

// Polished spring steel: bright, low roughness so the room's softbox streaks along each tooth.
const STEEL_ALBEDO: vec3f = vec3f(0.80, 0.80, 0.82);
const STEEL_METALLIC: f32 = 1.0;
const STEEL_ROUGHNESS: f32 = 0.15;

struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
}

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) inst: vec4f,
) -> VsOut {
  let d = toothVertex(comb, scene.time, position, normal, inst);
  var out: VsOut;
  out.clip = scene.viewProjection * vec4f(d.world, 1.0);
  out.worldPos = d.world;
  out.normal = normalize(d.normal);
  return out;
}

@vertex fn vs_shadow(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) inst: vec4f,
) -> @builtin(position) vec4f {
  return lightClip(scene, toothVertex(comb, scene.time, position, normal, inst).world);
}

@fragment fn fs_shadow() -> @location(0) vec4f {
  return vec4f(0.0);
}

@fragment fn fs_main(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  let shadow = shadowFactor(shadowMap, shadowSampler, scene, in.worldPos, n);
  let ibl = sampleIbl(irradianceMap, specularMap, envSampler, scene, in.worldPos, n, STEEL_ROUGHNESS);
  return vec4f(shadePbr(scene, in.worldPos, n, STEEL_ALBEDO, STEEL_METALLIC, STEEL_ROUGHNESS, 1.0, shadow, ibl), 1.0);
}
