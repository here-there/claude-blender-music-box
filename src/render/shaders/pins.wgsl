// Instanced steel pins on the rotating cylinder (axis +X through pins.center).
import { Scene, shadePbr } from "./common.wgsl";

struct Pins {
  center: vec3f,         // cylinder centre (meta.cylinder.center)
  cylinderAngle: f32,    // RenderState.cylinderAngle (−2π·phase)
  radius: f32,           // cylinder radius: pin base sits here
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> pins: Pins;

const STEEL_ALBEDO: vec3f = vec3f(0.78, 0.78, 0.80);
const STEEL_METALLIC: f32 = 1.0;
const STEEL_ROUGHNESS: f32 = 0.3;

struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
}

// Mesh: pinMesh(pinRadius, pinHeight) in metres, axis +Y, base y = 0.
// Instance: [x, angle0, tooth, 0]; world angle a = angle0 + cylinderAngle, pin direction (0, cos a, sin a).
@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) inst: vec4f,
) -> VsOut {
  let a = inst.y + pins.cylinderAngle;
  let c = cos(a);
  let s = sin(a);
  // Rotation about +X taking +Y to (0, cos a, sin a). Columns: X, Y, Z images.
  let r = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, c, s), vec3f(0.0, -s, c));
  // Sink the base slightly into the drum so no seam shows on the curved surface.
  let local = position + vec3f(0.0, pins.radius - 0.0001, 0.0);
  let world = vec3f(inst.x, pins.center.y, pins.center.z) + r * local;

  var out: VsOut;
  out.clip = scene.viewProjection * vec4f(world, 1.0);
  out.worldPos = world;
  out.normal = r * normal;
  return out;
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  return vec4f(shadePbr(scene, in.worldPos, n, STEEL_ALBEDO, STEEL_METALLIC, STEEL_ROUGHNESS, 1.0), 1.0);
}
