// Metallic-roughness PBR for the static music box parts. Outputs linear HDR radiance.
// vs_shadow / fs_shadow render the same deformation into the key-light shadow map.
import { Scene, sampleIbl, shadePbr, shadowFactor } from "./common.wgsl";
import { Model, lightClip, modelVertex } from "./shadow.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var baseColorMap: texture_2d<f32>;
@group(0) @binding(3) var normalMap: texture_2d<f32>;
@group(0) @binding(4) var ormMap: texture_2d<f32>;      // R occlusion, G roughness, B metallic
@group(0) @binding(5) var materialSampler: sampler;
@group(0) @binding(6) var irradianceMap: texture_cube<f32>;
@group(0) @binding(7) var specularMap: texture_cube<f32>;
@group(0) @binding(8) var envSampler: sampler;
@group(0) @binding(9) var shadowMap: texture_depth_2d;
@group(0) @binding(10) var shadowSampler: sampler_comparison;

struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
}

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
) -> VsOut {
  let d = modelVertex(model, position, normal, tangent.xyz);
  var out: VsOut;
  out.clip = scene.viewProjection * vec4f(d.world, 1.0);
  out.worldPos = d.world;
  out.normal = d.normal;
  out.uv = uv;
  out.tangent = vec4f(d.tangent, tangent.w);
  return out;
}

@vertex fn vs_shadow(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
) -> @builtin(position) vec4f {
  return lightClip(scene, modelVertex(model, position, normal, tangent.xyz).world);
}

@fragment fn fs_shadow() -> @location(0) vec4f {
  return vec4f(0.0);
}

@fragment fn fs_main(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let base = textureSample(baseColorMap, materialSampler, in.uv) * model.baseColor;
  let orm = textureSample(ormMap, materialSampler, in.uv);
  let tn = textureSample(normalMap, materialSampler, in.uv).xyz * 2.0 - 1.0;

  let ao = orm.r;
  let roughness = clamp(orm.g * model.roughness, 0.045, 1.0);
  let metallic = clamp(orm.b * model.metallic, 0.0, 1.0);
  let albedo = base.rgb;

  // Tangent-space normal mapping (glTF convention: bitangent = cross(N, T) * w).
  var n = normalize(in.normal);
  var t = in.tangent.xyz - n * dot(n, in.tangent.xyz);
  let tl = length(t);
  var nm = n;
  if (tl > 1e-5) {
    t = t / tl;
    let b = cross(n, t) * select(-1.0, 1.0, in.tangent.w >= 0.0);
    nm = normalize(t * tn.x + b * tn.y + n * max(tn.z, 1e-3));
  }
  // Double-sided safety: shade back faces with the flipped normal.
  if (!front) { nm = -nm; n = -n; }

  let shadow = shadowFactor(shadowMap, shadowSampler, scene, in.worldPos, n);
  let ibl = sampleIbl(irradianceMap, specularMap, envSampler, scene, in.worldPos, nm, roughness);
  return vec4f(shadePbr(scene, in.worldPos, nm, albedo, metallic, roughness, ao, shadow, ibl), 1.0);
}
