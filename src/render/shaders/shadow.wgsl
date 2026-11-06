// Shadow casters: the vertex deformation of every opaque draw kind, shared by its lit entry (vs_main)
// and its shadow-map entry (vs_shadow) so both passes see exactly the same geometry (pure module).
import { PI, Scene } from "./common.wgsl";

// ---- Static / articulated glTF parts (pbr.wgsl) ----
export struct Model {
  world: mat4x4f,
  baseColor: vec4f,
  metallic: f32,
  roughness: f32,
}

// ---- Comb teeth (comb.wgsl) ----
export struct Comb {
  // [i].x = pluck (release) time on the scene.time base, [i].y = amplitude (0 = never plucked)
  plucks: array<vec4f, 18>,
  tipZ: f32,      // tooth tip z (root at tipZ + length)
  combY: f32,     // tooth top surface height
  pad0: f32,
  pad1: f32,
}

// ---- Pins on the rotating cylinder (pins.wgsl) ----
export struct Pins {
  center: vec3f,         // cylinder centre (meta.cylinder.center)
  cylinderAngle: f32,    // RenderState.cylinderAngle (−2π·phase)
  radius: f32,           // cylinder radius: pin base sits here
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

export struct Deformed {
  world: vec3f,
  normal: vec3f,   // not normalised
  tangent: vec3f,  // not normalised
}

// Key-light clip position for the shadow pass.
export fn lightClip(scene: Scene, world: vec3f) -> vec4f {
  return scene.lightViewProjection * vec4f(world, 1.0);
}

// World matrices are rigid (rotation + translation), so the upper 3x3 transforms normals too.
export fn modelVertex(model: Model, position: vec3f, normal: vec3f, tangent: vec3f) -> Deformed {
  let m = mat3x3f(model.world[0].xyz, model.world[1].xyz, model.world[2].xyz);
  var out: Deformed;
  out.world = (model.world * vec4f(position, 1.0)).xyz;
  out.normal = m * normal;
  out.tangent = m * tangent;
  return out;
}

// Displacement mirrors src/render/vibration.ts.
const BASE_AMPLITUDE: f32 = 0.0006;
const PUSH_SECONDS: f32 = 0.04;

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

// Mesh: toothMesh(toothWidth, toothThickness) — x/y in metres, z ∈ [-1, 0] (root 0 → tip -1).
// Instance: [x, length, toothIndex, 0].
export fn toothVertex(comb: Comb, time: f32, position: vec3f, normal: vec3f, inst: vec4f) -> Deformed {
  let len = inst.y;
  let tooth = inst.z;
  let pluck = comb.plucks[u32(tooth)];
  let env = tipDisplacement(time - pluck.x, pluck.y, tooth);
  let u = clamp(-position.z, 0.0, 1.0);   // root → tip fraction

  var out: Deformed;
  out.world = vec3f(
    inst.x + position.x,
    comb.combY + position.y + env * u * u,
    comb.tipZ + len * (1.0 + position.z),
  );
  // Map (x, y, z) → (x, y + d(z), tipZ + L(1+z)) with d = env·u², u = -z.
  // Jacobian J = [[1,0,0],[0,1,d'(z)],[0,0,L]] with d'(z) = -2·env·u; normals use (J⁻¹)ᵀ.
  let dd = -2.0 * env * u;
  out.normal = vec3f(normal.x, normal.y, (normal.z - dd * normal.y) / len);
  out.tangent = vec3f(1.0, 0.0, 0.0);
  return out;
}

// Mesh: pinMesh(pinRadius, pinHeight) in metres, axis +Y, base y = 0.
// Instance: [x, angle0, tooth, 0]; world angle a = angle0 + cylinderAngle, pin direction (0, cos a, sin a).
export fn pinVertex(pins: Pins, position: vec3f, normal: vec3f, inst: vec4f) -> Deformed {
  let a = inst.y + pins.cylinderAngle;
  let c = cos(a);
  let s = sin(a);
  // Rotation about +X taking +Y to (0, cos a, sin a). Columns: X, Y, Z images.
  let r = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, c, s), vec3f(0.0, -s, c));
  // Sink the base slightly into the drum so no seam shows on the curved surface.
  let local = position + vec3f(0.0, pins.radius - 0.0001, 0.0);
  var out: Deformed;
  out.world = vec3f(inst.x, pins.center.y, pins.center.z) + r * local;
  out.normal = r * normal;
  out.tangent = vec3f(1.0, 0.0, 0.0);
  return out;
}
