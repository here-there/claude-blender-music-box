// Instanced steel comb teeth that bend when plucked. Displacement mirrors src/render/vibration.ts.
import { PI, Scene, shadePbr } from "./common.wgsl";

struct Comb {
  // [i].x = pluck (release) time on the scene.time base, [i].y = amplitude (0 = never plucked)
  plucks: array<vec4f, 18>,
  tipZ: f32,      // tooth tip z (root at tipZ + length)
  combY: f32,     // tooth top surface height
  pad0: f32,
  pad1: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> comb: Comb;

const BASE_AMPLITUDE: f32 = 0.0006;
const PUSH_SECONDS: f32 = 0.04;
const STEEL_ALBEDO: vec3f = vec3f(0.80, 0.80, 0.82);
const STEEL_METALLIC: f32 = 1.0;
const STEEL_ROUGHNESS: f32 = 0.22;

// Displacement at the tip (u = 1); the displacement at u is envelope · u².
fn tipDisplacement(t: f32, amplitude: f32, tooth: f32) -> f32 {
  let a = BASE_AMPLITUDE * amplitude;
  if (t < 0.0) {
    if (t < -PUSH_SECONDS) { return 0.0; }
    return a * (1.0 + t / PUSH_SECONDS);
  }
  let f = 6.0 + 10.0 * tooth / 17.0;
  let tau = 1.2 - 0.8 * tooth / 17.0;
  return a * exp(-t / tau) * cos(2.0 * PI * f * t);
}

struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
}

// Mesh: toothMesh(toothWidth, toothThickness) — x/y in metres, z ∈ [-1, 0] (root 0 → tip -1).
// Instance: [x, length, toothIndex, 0].
@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) inst: vec4f,
) -> VsOut {
  let len = inst.y;
  let tooth = inst.z;
  let pluck = comb.plucks[u32(tooth)];
  let env = tipDisplacement(scene.time - pluck.x, pluck.y, tooth);
  let u = clamp(-position.z, 0.0, 1.0);   // root → tip fraction

  let world = vec3f(
    inst.x + position.x,
    comb.combY + position.y + env * u * u,
    comb.tipZ + len * (1.0 + position.z),
  );
  // Map (x, y, z) → (x, y + d(z), tipZ + L(1+z)) with d = env·u², u = -z.
  // Jacobian J = [[1,0,0],[0,1,d'(z)],[0,0,L]] with d'(z) = -2·env·u; normals use (J⁻¹)ᵀ.
  let dd = -2.0 * env * u;
  let n = vec3f(normal.x, normal.y, (normal.z - dd * normal.y) / len);

  var out: VsOut;
  out.clip = scene.viewProjection * vec4f(world, 1.0);
  out.worldPos = world;
  out.normal = normalize(n);
  return out;
}

@fragment fn fs_main(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  return vec4f(shadePbr(scene, in.worldPos, n, STEEL_ALBEDO, STEEL_METALLIC, STEEL_ROUGHNESS, 1.0), 1.0);
}
