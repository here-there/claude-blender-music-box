// Startup-only image-based-lighting bake (see environment.ts). The room is procedural:
//   cs_source     — analytic warm interior radiance into a 128² cube with a full mip chain (each mip
//                   supersampled from the analytic function, so no read-back of the cube itself);
//   cs_specular   — GGX-prefiltered radiance, roughness = level / (levels − 1), filtered importance sampling;
//   cs_irradiance — cosine-convolved radiance (E / π) into a 64² cube.
// Cube faces follow WebGPU: +X, −X, +Y, −Y, +Z, −Z, v pointing down.
import { PI } from "./common.wgsl";

struct Bake {
  keyDirection: vec3f,  // LIGHTING.lightDirection: the bright window sits behind the key light
  size: u32,         // destination mip edge in texels
  samples: u32,      // importance samples per texel (cs_specular / cs_irradiance), supersampling edge (cs_source)
  roughness: f32,    // cs_specular
  sourceSize: f32,   // edge of the source cube's mip 0
  pad0: f32,
  pad1: f32,
}

@group(0) @binding(0) var<uniform> bake: Bake;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var source: texture_cube<f32>;
@group(0) @binding(3) var sourceSampler: sampler;

// Faint cool window behind-right of the box, for rim reflections.
const FILL_DIR: vec3f = vec3f(0.6741, 0.3371, -0.6573);

fn cubeDir(face: u32, uv: vec2f) -> vec3f {
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;
  switch face {
    case 0u: { return normalize(vec3f(1.0, -v, -u)); }
    case 1u: { return normalize(vec3f(-1.0, -v, u)); }
    case 2u: { return normalize(vec3f(u, 1.0, v)); }
    case 3u: { return normalize(vec3f(u, -1.0, -v)); }
    case 4u: { return normalize(vec3f(u, -v, 1.0)); }
    default: { return normalize(vec3f(-u, -v, -1.0)); }
  }
}

// Rectangular window with soft edges and a mullion cross, centred on `axis` (gnomonic coordinates).
fn window(d: vec3f, axis: vec3f, halfSize: vec2f, soft: f32) -> f32 {
  let c = dot(d, axis);
  if (c <= 0.05) { return 0.0; }
  let side = normalize(cross(vec3f(0.0, 1.0, 0.0), axis));
  let up = cross(axis, side);
  let p = vec2f(dot(d, side), dot(d, up)) / c;
  let edge = (1.0 - smoothstep(halfSize.x - soft, halfSize.x + soft, abs(p.x)))
    * (1.0 - smoothstep(halfSize.y - soft, halfSize.y + soft, abs(p.y)));
  let bars = min(smoothstep(0.008, 0.02, abs(p.x)), smoothstep(0.008, 0.02, abs(p.y)));
  return edge * mix(0.35, 1.0, bars);
}

// Warm interior: dark brown walls all around, a warm-white ceiling wash above, a bright window behind
// the key light, a faint cool window for rims, and a warm wooden table below.
fn roomRadiance(d: vec3f) -> vec3f {
  let y = d.y;
  let wall = vec3f(0.070, 0.047, 0.032);
  let ceiling = vec3f(1.00, 0.84, 0.66);
  var c = wall;
  // lit band of the walls near eye level, falling off up and down
  c += vec3f(0.07, 0.048, 0.030) * exp(-abs(y - 0.08) * 6.0);
  // ceiling wash
  c = mix(c, ceiling, smoothstep(0.5, 0.98, y));
  // table: dark warm wood, brighter towards the horizon where it reflects the room
  let table = mix(vec3f(0.060, 0.034, 0.018), vec3f(0.13, 0.085, 0.055), exp(y * 7.0));
  c = mix(c, table, smoothstep(0.0, -0.06, y));
  // key window and cool fill window
  c += vec3f(1.0, 0.80, 0.58) * 7.0 * window(d, normalize(bake.keyDirection), vec2f(0.42, 0.30), 0.04);
  c += vec3f(0.55, 0.62, 0.75) * 1.4 * window(d, FILL_DIR, vec2f(0.30, 0.45), 0.08);
  return c;
}

fn radicalInverse(i: u32) -> f32 {
  return f32(reverseBits(i)) * 2.3283064365386963e-10;
}

fn tangentFrame(n: vec3f) -> mat3x3f {
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let t = normalize(cross(up, n));
  let b = cross(n, t);
  return mat3x3f(t, b, n);
}

fn inBounds(id: vec3u) -> bool {
  return id.x < bake.size && id.y < bake.size && id.z < 6u;
}

@compute @workgroup_size(8, 8, 1)
fn cs_source(@builtin(global_invocation_id) id: vec3u) {
  if (!inBounds(id)) { return; }
  let n = max(bake.samples, 1u);
  var sum = vec3f(0.0);
  for (var j = 0u; j < n; j++) {
    for (var i = 0u; i < n; i++) {
      let sub = (vec2f(f32(i), f32(j)) + 0.5) / f32(n);
      let uv = (vec2f(id.xy) + sub) / f32(bake.size);
      sum += roomRadiance(cubeDir(id.z, uv));
    }
  }
  textureStore(dst, id.xy, id.z, vec4f(sum / f32(n * n), 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_specular(@builtin(global_invocation_id) id: vec3u) {
  if (!inBounds(id)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(bake.size);
  let n = cubeDir(id.z, uv);
  if (bake.roughness <= 0.0) {
    textureStore(dst, id.xy, id.z, vec4f(textureSampleLevel(source, sourceSampler, n, 0.0).rgb, 1.0));
    return;
  }
  // Split-sum prefilter with N = V = R (Karis 2013), source lod from the sample's solid angle.
  let a = bake.roughness * bake.roughness;
  let a2 = a * a;
  let frame = tangentFrame(n);
  let texelSolidAngle = 4.0 * PI / (6.0 * bake.sourceSize * bake.sourceSize);
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0u; i < bake.samples; i++) {
    let xi = vec2f(f32(i) / f32(bake.samples), radicalInverse(i));
    let phi = 2.0 * PI * xi.x;
    let cosT = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    let sinT = sqrt(1.0 - cosT * cosT);
    let h = frame * vec3f(sinT * cos(phi), sinT * sin(phi), cosT);
    let l = 2.0 * dot(n, h) * h - n;
    let NdotL = dot(n, l);
    if (NdotL > 0.0) {
      let NdotH = max(dot(n, h), 0.0);
      let dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
      let D = a2 / (PI * dd * dd);
      let pdf = D / 4.0;   // D·NdotH / (4·VdotH) with V = N
      let sampleSolidAngle = 1.0 / (f32(bake.samples) * pdf + 1e-6);
      let lod = max(0.5 * log2(sampleSolidAngle / texelSolidAngle) + 1.0, 0.0);
      sum += textureSampleLevel(source, sourceSampler, l, lod).rgb * NdotL;
      weight += NdotL;
    }
  }
  textureStore(dst, id.xy, id.z, vec4f(sum / max(weight, 1e-4), 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_irradiance(@builtin(global_invocation_id) id: vec3u) {
  if (!inBounds(id)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(bake.size);
  let n = cubeDir(id.z, uv);
  let frame = tangentFrame(n);
  let texelSolidAngle = 4.0 * PI / (6.0 * bake.sourceSize * bake.sourceSize);
  // Cosine-weighted hemisphere: the plain mean of the samples is E / π.
  var sum = vec3f(0.0);
  for (var i = 0u; i < bake.samples; i++) {
    let xi = vec2f(f32(i) / f32(bake.samples), radicalInverse(i));
    let phi = 2.0 * PI * xi.x;
    let cosT = sqrt(1.0 - xi.y);
    let sinT = sqrt(xi.y);
    let l = frame * vec3f(sinT * cos(phi), sinT * sin(phi), cosT);
    let pdf = max(cosT, 1e-3) / PI;
    let lod = max(0.5 * log2(1.0 / (f32(bake.samples) * pdf) / texelSolidAngle) + 1.0, 0.0);
    sum += textureSampleLevel(source, sourceSampler, l, lod).rgb;
  }
  textureStore(dst, id.xy, id.z, vec4f(sum / f32(bake.samples), 1.0));
}
