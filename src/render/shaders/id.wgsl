// GPU picking: every pickable draw writes its ID (src/parts.ts encoding) into an rgba8unorm target as
// (id & 255, id >> 8) / 255 — vgpu's Texture.read() cannot read back integer formats. The vertex
// deformation is the lit pass's (shadow.wgsl), so moving lid/key/teeth/pins pick where they are drawn.
import { Scene } from "./common.wgsl";
import { Comb, Model, Pins, modelVertex, pinVertex, toothVertex } from "./shadow.wgsl";

struct Ident {
  id: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> ident: Ident;
@group(0) @binding(3) var<uniform> comb: Comb;
@group(0) @binding(4) var<uniform> pins: Pins;

const TOOTH_ID_BASE: u32 = 100u;
const PIN_ID: u32 = 200u;

struct IdOut {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) id: u32,
}

@vertex fn vs_part(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
) -> IdOut {
  var out: IdOut;
  out.clip = scene.viewProjection * vec4f(modelVertex(model, position, normal, tangent.xyz).world, 1.0);
  out.id = ident.id;
  return out;
}

@vertex fn vs_tooth(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) inst: vec4f,
) -> IdOut {
  var out: IdOut;
  out.clip = scene.viewProjection * vec4f(toothVertex(comb, scene.time, position, normal, inst).world, 1.0);
  out.id = TOOTH_ID_BASE + u32(inst.z);
  return out;
}

@vertex fn vs_pin(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) inst: vec4f,
) -> IdOut {
  var out: IdOut;
  out.clip = scene.viewProjection * vec4f(pinVertex(pins, position, normal, inst).world, 1.0);
  out.id = PIN_ID;
  return out;
}

@fragment fn fs_id(in: IdOut) -> @location(0) vec4f {
  return vec4f(f32(in.id & 255u) / 255.0, f32(in.id >> 8u) / 255.0, 0.0, 1.0);
}
