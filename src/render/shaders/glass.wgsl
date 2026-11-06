// Glass panel under the lid: drawn last, blended (premultiplied), depth-tested without depth writes.
// Pure reflection layer: colour = prefiltered environment · F, alpha = 0.08 + 0.6·F with F = Schlick(0.04),
// so it darkens what is behind it only slightly and shows bright Fresnel edges at grazing angles.
import { Scene, fresnelSchlick, distributionGGX, visibilitySmithGGX } from "./common.wgsl";
import { Model, modelVertex } from "./shadow.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var specularMap: texture_cube<f32>;
@group(0) @binding(3) var envSampler: sampler;

const GLASS_ROUGHNESS: f32 = 0.04;

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
) -> VsOut {
  let d = modelVertex(model, position, normal, tangent.xyz);
  var out: VsOut;
  out.clip = scene.viewProjection * vec4f(d.world, 1.0);
  out.worldPos = d.world;
  out.normal = d.normal;
  return out;
}

@fragment fn fs_main(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  let v = normalize(scene.cameraPosition - in.worldPos);
  let NdotV = max(dot(n, v), 1e-4);
  let F = fresnelSchlick(NdotV, vec3f(0.04)).x;
  let r = reflect(-v, n);
  let env = textureSampleLevel(specularMap, envSampler, r, GLASS_ROUGHNESS * scene.specularLevels).rgb * scene.envSpecular;

  // Sharp key-light glint on the panel (same GGX lobe as the opaque parts).
  let l = normalize(scene.lightDirection);
  let h = normalize(v + l);
  let NdotL = max(dot(n, l), 0.0);
  let a = GLASS_ROUGHNESS * GLASS_ROUGHNESS;
  let glint = distributionGGX(max(dot(n, h), 0.0), a) * visibilitySmithGGX(NdotV, NdotL, a)
    * fresnelSchlick(max(dot(v, h), 0.0), vec3f(0.04)) * scene.lightColor * scene.lightIntensity * NdotL;

  let color = env * F + min(glint, vec3f(24.0));
  let alpha = 0.08 + 0.6 * F;
  return vec4f(color, alpha);   // premultiplied: dst · (1 − alpha) + color
}
