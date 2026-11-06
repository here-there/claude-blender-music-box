// Metallic-roughness PBR for the static music box parts. Outputs linear HDR radiance.
import { Scene, shadePbr } from "./common.wgsl";

struct Model {
  world: mat4x4f,
  baseColor: vec4f,
  metallic: f32,
  roughness: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var baseColorMap: texture_2d<f32>;
@group(0) @binding(3) var normalMap: texture_2d<f32>;
@group(0) @binding(4) var ormMap: texture_2d<f32>;      // R occlusion, G roughness, B metallic
@group(0) @binding(5) var materialSampler: sampler;

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
  // World matrices are rigid (rotation + translation), so the upper 3x3 transforms normals too.
  let m = mat3x3f(model.world[0].xyz, model.world[1].xyz, model.world[2].xyz);
  let wp = model.world * vec4f(position, 1.0);
  var out: VsOut;
  out.clip = scene.viewProjection * wp;
  out.worldPos = wp.xyz;
  out.normal = m * normal;
  out.uv = uv;
  out.tangent = vec4f(m * tangent.xyz, tangent.w);
  return out;
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
  if (!front) { nm = -nm; }

  return vec4f(shadePbr(scene, in.worldPos, nm, albedo, metallic, roughness, ao), 1.0);
}
