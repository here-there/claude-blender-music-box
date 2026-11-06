// Shared, binding-free helpers for the music box shaders (WGSL module: exports only).

export const PI: f32 = 3.14159265359;

// Per-frame block shared by every scene draw (one `uniforms()` object bound as `scene`).
export struct Scene {
  viewProjection: mat4x4f,
  lightViewProjection: mat4x4f, // world → key-light clip space (orthographic, fitted to the box incl. open lid)
  cameraPosition: vec3f,
  time: f32,
  lightDirection: vec3f,   // unit vector from the surface toward the key light
  lightIntensity: f32,
  lightColor: vec3f,       // ~3200K warm key light, linear
  envDiffuse: f32,         // irradiance map scale
  envSpecular: f32,        // prefiltered specular map scale
  shadowTexel: f32,        // 1 / shadow map resolution
  shadowNormalBias: f32,   // receiver offset along the normal, metres (≈ 1.5 shadow texels)
  specularLevels: f32,     // prefiltered mip count − 1 (roughness r ↦ lod r · specularLevels)
}

// Image-based lighting already looked up for one shading point.
export struct Ibl {
  irradiance: vec3f,   // cosine-weighted mean radiance around n (E / π)
  prefiltered: vec3f,  // GGX-prefiltered radiance along the reflection vector
}

// GGX / Trowbridge-Reitz normal distribution. `a` = perceptual roughness squared.
export fn distributionGGX(NdotH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

// Height-correlated Smith visibility V = G / (4 NdotL NdotV).
export fn visibilitySmithGGX(NdotV: f32, NdotL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  let gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}

export fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
  let f = pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}

// Analytic split-sum environment BRDF (Karis, "Physically Based Shading on Mobile").
export fn envBRDFApprox(f0: vec3f, roughness: f32, NdotV: f32) -> vec3f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// ACES filmic approximation (Narkowicz 2015), input/output linear.
export fn acesApprox(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

export fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

// Samples the startup-generated environment (see environment.ts): irradiance along n and the
// prefiltered specular mip chain along the reflection vector (mip = roughness · specularLevels).
export fn sampleIbl(
  irradianceMap: texture_cube<f32>,
  specularMap: texture_cube<f32>,
  envSampler: sampler,
  scene: Scene,
  worldPos: vec3f,
  n: vec3f,
  roughness: f32,
) -> Ibl {
  let v = normalize(scene.cameraPosition - worldPos);
  let r = reflect(-v, n);
  var ibl: Ibl;
  ibl.irradiance = textureSampleLevel(irradianceMap, envSampler, n, 0.0).rgb;
  ibl.prefiltered = textureSampleLevel(specularMap, envSampler, r, roughness * scene.specularLevels).rgb;
  return ibl;
}

// Key-light visibility in [0, 1]: normal-offset receiver + 3×3 PCF of hardware 2×2 comparisons
// (each tap is bilinearly filtered, so the kernel is effectively 4×4 texels wide).
// `normal` is the geometric normal (not normal-mapped).
export fn shadowFactor(
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
  scene: Scene,
  worldPos: vec3f,
  normal: vec3f,
) -> f32 {
  let l = normalize(scene.lightDirection);
  let cosL = clamp(dot(normal, l), 0.0, 1.0);
  // Grazing receivers need a larger offset; facing ones barely any.
  let offset = normal * scene.shadowNormalBias * (0.5 + 1.5 * sqrt(1.0 - cosL * cosL));
  let p = scene.lightViewProjection * vec4f(worldPos + offset, 1.0);
  let ndc = p.xyz / p.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z > 1.0) { return 1.0; }
  let depthRef = ndc.z - 0.0002;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y)) * scene.shadowTexel;
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, depthRef);
    }
  }
  return sum / 9.0;
}

// Without a contact-occlusion term the environment lights shadowed corners as brightly as open ones;
// the key-light shadow is a cheap proxy for "the box walls hide most of the room" here.
const SHADOWED_DIFFUSE: f32 = 0.55;
const SHADOWED_SPECULAR: f32 = 0.75;

// Metallic-roughness shading: shadowed warm key light (GGX) + image-based ambient. Returns linear HDR radiance.
// `n` must be normalised and facing the viewer side the caller wants lit.
export fn shadePbr(
  scene: Scene,
  worldPos: vec3f,
  n: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughnessIn: f32,
  ao: f32,
  shadow: f32,
  ibl: Ibl,
) -> vec3f {
  let roughness = clamp(roughnessIn, 0.045, 1.0);
  let v = normalize(scene.cameraPosition - worldPos);
  let l = normalize(scene.lightDirection);
  let h = normalize(v + l);
  let NdotV = max(dot(n, v), 1e-4);
  let NdotL = max(dot(n, l), 0.0);
  let NdotH = max(dot(n, h), 0.0);
  let VdotH = max(dot(v, h), 0.0);

  let a = roughness * roughness;
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let F = fresnelSchlick(VdotH, f0);
  let spec = distributionGGX(NdotH, a) * visibilitySmithGGX(NdotV, NdotL, a) * F;
  let kd = (vec3f(1.0) - F) * (1.0 - metallic);
  let radiance = scene.lightColor * scene.lightIntensity;
  let direct = (kd * albedo / PI + spec) * radiance * NdotL * shadow;

  let envF = envBRDFApprox(f0, roughness, NdotV);
  let diffuseAmbient = (vec3f(1.0) - envF) * (1.0 - metallic) * albedo * ibl.irradiance * scene.envDiffuse;
  let specularAmbient = envF * ibl.prefiltered * scene.envSpecular;
  let ambient = diffuseAmbient * mix(SHADOWED_DIFFUSE, 1.0, shadow)
    + specularAmbient * mix(SHADOWED_SPECULAR, 1.0, shadow);
  return direct + ambient * ao;
}
