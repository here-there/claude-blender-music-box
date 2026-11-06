// Metallic-roughness PBR for the static music box parts. Outputs linear HDR radiance.
import { PI, distributionGGX, visibilitySmithGGX, fresnelSchlick, envBRDFApprox } from "./common.wgsl";

// Per-frame block shared by every scene draw (one `uniforms()` object bound as `scene`).
struct Scene {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  lightDirection: vec3f,   // unit vector from the surface toward the key light
  lightIntensity: f32,
  lightColor: vec3f,       // ~3200K warm key light, linear
  envDiffuse: f32,
  skyColor: vec3f,         // constant environment (T10 replaces with irradiance / prefiltered maps)
  envSpecular: f32,
  groundColor: vec3f,
  pad0: f32,
}

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

fn environment(dir: vec3f) -> vec3f {
  return mix(scene.groundColor, scene.skyColor, smoothstep(-0.4, 0.8, dir.y));
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

  let v = normalize(scene.cameraPosition - in.worldPos);
  let l = normalize(scene.lightDirection);
  let h = normalize(v + l);
  let NdotV = max(dot(nm, v), 1e-4);
  let NdotL = max(dot(nm, l), 0.0);
  let NdotH = max(dot(nm, h), 0.0);
  let VdotH = max(dot(v, h), 0.0);

  let a = roughness * roughness;
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let F = fresnelSchlick(VdotH, f0);
  let spec = distributionGGX(NdotH, a) * visibilitySmithGGX(NdotV, NdotL, a) * F;
  let kd = (vec3f(1.0) - F) * (1.0 - metallic);
  let radiance = scene.lightColor * scene.lightIntensity;
  let direct = (kd * albedo / PI + spec) * radiance * NdotL;

  // Constant (hemisphere) environment term.
  let r = reflect(-v, nm);
  let envSpec = envBRDFApprox(f0, roughness, NdotV) * mix(environment(r), environment(nm), roughness * roughness);
  let ambient = (albedo * (1.0 - metallic) * environment(nm) * scene.envDiffuse + envSpec * scene.envSpecular) * ao;

  return vec4f(direct + ambient, 1.0);
}
