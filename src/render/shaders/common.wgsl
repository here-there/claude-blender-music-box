// Shared, binding-free helpers for the music box shaders (WGSL module: exports only).

export const PI: f32 = 3.14159265359;

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
