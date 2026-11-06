import { draw, effect, frame, geometry, sampler, target, uniforms, type Draw, type FramePass, type Geometry, type Gpu, type Target } from "vgpu";
import { composeMatrix, multiplyMatrices, orthographic } from "vgpu/scene";
import type { MeshData } from "../gltf/glb";
import type { GpuPart } from "../gltf/upload";
import { toothInstances, toothMesh } from "../geometry/comb";
import { pinMesh } from "../geometry/pins";
import type { MusicBoxMeta, Vec3 } from "../meta";
import { PART_NAMES, partId, type PartName } from "../parts";
import { cameraMatrices, type CameraMatrices, type OrbitState } from "./camera";
import { createEnvironment, envCubeView, SPECULAR_LEVELS } from "./environment";
import combShader from "./shaders/comb.wgsl";
import glassShader from "./shaders/glass.wgsl";
import idShader from "./shaders/id.wgsl";
import pbrShader from "./shaders/pbr.wgsl";
import pinsShader from "./shaders/pins.wgsl";
import postShader from "./shaders/post.wgsl";

export interface RenderState {
  time: number;
  /** Signed cylinder angle in radians (main computes −2π·phase). Parts turn by extras.ratio · cylinderAngle. */
  cylinderAngle: number;
  keyAngle: number;
  /** Already eased 0..1 (see easeLid). */
  lidOpen01: number;
  orbit: OrbitState;
  /** 18×2: [pluckTime, amplitude] per tooth, pluckTime on the same base as `time` (release moment). */
  plucks: Float32Array;
}

export interface Renderer {
  /** Per pin [x, angle0, tooth, 0] (pinInstances); replaces the previous set. */
  setPins(instances: Float32Array): void;
  render(state: RenderState): void;
  /**
   * ID (src/parts.ts encoding, 0 = nothing) under one output-target pixel, as of the last render().
   * Convert pointer CSS coordinates with interaction/winding.ts `cssToTargetPixel`. Glass is not pickable.
   */
  pick(px: number, py: number): Promise<number>;
  dispose(): void;
}

/** Smoothstep easing for the lid; main feeds the result to RenderState.lidOpen01. */
export function easeLid(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// ---- Lighting / grading constants (tunable) ----
// Warm ~3200K key light (linear RGB), from upper front-left.
export const LIGHTING = {
  lightDirection: normalize3([-0.45, 1.0, 0.55]),
  lightColor: [1.0, 0.6, 0.32] as Vec3,
  lightIntensity: 3.2,
  /** Scales of the baked environment (environment.ts) in diffuse / specular ambient. */
  envDiffuse: 0.55,
  envSpecular: 0.8,
  exposure: 1.0,
  vignette: 0.55,
  clear: [0.018, 0.014, 0.012, 1] as [number, number, number, number],
};

// ---- Key-light shadow map ----
export const SHADOW = {
  size: 2048,
  format: "depth32float" as GPUTextureFormat,
  /** World-space box the light frustum must contain: case, movement and the fully open lid (+ margin). */
  bounds: { min: [-0.085, -0.003, -0.085] as Vec3, max: [0.085, 0.185, 0.06] as Vec3 },
  /** Receiver offset along the normal in shadow texels (scaled by the texel's world size). */
  normalBiasTexels: 1.5,
  /** Rasterised slope-scaled depth bias for the casters. */
  biasSlopeScale: 1.5,
};

/** Mirrors `struct Scene` in common.wgsl. */
type SceneValues = {
  viewProjection: Float32Array;
  lightViewProjection: Float32Array;
  cameraPosition: Float32Array;
  time: number;
  lightDirection: Vec3;
  lightIntensity: number;
  lightColor: Vec3;
  envDiffuse: number;
  envSpecular: number;
  shadowTexel: number;
  shadowNormalBias: number;
  specularLevels: number;
};

/** Mirrors `struct Model` in shadow.wgsl. */
type ModelValues = { world: Float32Array; baseColor: [number, number, number, number]; metallic: number; roughness: number };

const HDR_FORMAT: GPUTextureFormat = "rgba16float";

/**
 * Orthographic key-light view-projection fitted tightly around `bounds` (all 8 corners), looking along
 * −lightDirection. Returns the matrix and the world size of one shadow texel (larger of x/y).
 */
export function fitLightFrustum(
  lightDirection: Vec3, bounds: { min: Vec3; max: Vec3 }, mapSize: number, out = new Float32Array(16),
): { viewProjection: Float32Array; texelWorld: number } {
  const z = normalize3(lightDirection);
  const x = normalize3([z[2], 0, -z[0]]); // cross(+Y, z)
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const c: Vec3 = [0, 1, 2].map((i) => (bounds.min[i]! + bounds.max[i]!) / 2) as Vec3;
  const radius = Math.hypot(bounds.max[0] - c[0], bounds.max[1] - c[1], bounds.max[2] - c[2]);
  const eye: Vec3 = [c[0] + z[0] * (radius + 0.01), c[1] + z[1] * (radius + 0.01), c[2] + z[2] * (radius + 0.01)];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const view = new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
  let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity, n = Infinity, f = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [i & 1 ? bounds.max[0] : bounds.min[0], i & 2 ? bounds.max[1] : bounds.min[1], i & 4 ? bounds.max[2] : bounds.min[2]];
    const rel: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const vx = dot(rel, x), vy = dot(rel, y), vz = dot(rel, z);
    l = Math.min(l, vx); r = Math.max(r, vx); b = Math.min(b, vy); t = Math.max(t, vy);
    n = Math.min(n, -vz); f = Math.max(f, -vz);
  }
  const proj = orthographic({ left: l, right: r, bottom: b, top: t, near: Math.max(0, n - 0.002), far: f + 0.002 }, new Float32Array(16));
  multiplyMatrices(proj, view, out);
  return { viewProjection: out, texelWorld: Math.max(r - l, t - b) / mapSize };
}

function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function vec3Extra(extras: Record<string, unknown>, key: string): Vec3 | null {
  const v = extras[key];
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number")) return null;
  const [x, y, z] = v as number[];
  return [x!, y!, z!];
}

/** Interleaved 48-byte mesh stream (upload.ts layout) plus a per-instance vec4f stream at location 4. */
function instancedGeometry(gpu: Gpu, mesh: MeshData, instances: Float32Array, label: string): Geometry {
  const n = mesh.positions.length / 3;
  const interleaved = new Float32Array(n * 12);
  for (let v = 0; v < n; v++) {
    interleaved.set(mesh.positions.subarray(v * 3, v * 3 + 3), v * 12);
    interleaved.set(mesh.normals.subarray(v * 3, v * 3 + 3), v * 12 + 3);
    interleaved.set(mesh.uvs.subarray(v * 2, v * 2 + 2), v * 12 + 6);
    interleaved.set(mesh.tangents.subarray(v * 4, v * 4 + 4), v * 12 + 8);
  }
  return geometry(gpu, {
    label,
    buffers: [
      {
        data: interleaved,
        stride: 48,
        attributes: {
          position: { format: "float32x3", offset: 0, location: 0 },
          normal: { format: "float32x3", offset: 12, location: 1 },
          uv: { format: "float32x2", offset: 24, location: 2 },
          tangent: { format: "float32x4", offset: 32, location: 3 },
        },
      },
      { stepMode: "instance", data: new Float32Array(instances), stride: 16, attributes: { inst: { format: "float32x4", location: 4 } } },
    ],
    indices: mesh.indices,
  });
}

/** How a part's world matrix follows the render state. */
type Motion =
  | { kind: "static" }
  | { kind: "spin"; axis: Vec3; angle: (s: RenderState) => number }
  | { kind: "hinge"; point: Vec3; axis: Vec3; angle: (s: RenderState) => number };

function motionFor(name: string, part: GpuPart, meta: MusicBoxMeta): Motion {
  if (name === "lid") {
    const { point, axis, openAngle } = meta.lidHinge;
    return { kind: "hinge", point, axis, angle: (s) => openAngle * s.lidOpen01 };
  }
  const axis = vec3Extra(part.extras, "axis");
  if (!axis) return { kind: "static" };
  if (name === "key") return { kind: "spin", axis, angle: (s) => s.keyAngle };
  const ratio = typeof part.extras.ratio === "number" ? part.extras.ratio : 0;
  if (ratio === 0) return { kind: "static" };
  return { kind: "spin", axis, angle: (s) => ratio * s.cylinderAngle };
}

interface SceneObject {
  name: string;
  node: Float32Array; // glTF node matrix
  world: Float32Array;
  motion: Motion;
  /** One `model` block per primitive, shared by its lit, shadow (opaque) or glass draw. */
  models: { set(values: Partial<ModelValues>): unknown }[];
  draws: Draw[];   // opaque, lit
  casters: Draw[]; // opaque, shadow map
  glass: Draw[];   // blended, drawn last
  ids: Draw[];     // opaque, ID pass (picking)
}

/**
 * Renderer layout (later tasks plug in here):
 *   shadow pass → 2048² depth32float key-light map (only when a caster moved): vs_shadow of parts, teeth, pins
 *   scene pass  → HDR target (rgba16float, depth, 4× MSAA): parts, teeth, pins (IBL + PCF shadows), glass last
 *   post pass   → output (surface/target): ACES + vignette + sRGB
 */
export async function createRenderer(
  gpu: Gpu,
  output: Target,
  parts: Map<string, GpuPart>,
  meta: MusicBoxMeta,
): Promise<Renderer> {
  const hdr = target(gpu, {
    size: [output.size[0], output.size[1]], format: HDR_FORMAT, depth: true, msaa: 4,
    clearColor: LIGHTING.clear, label: "scene-hdr",
  });

  const light = fitLightFrustum(LIGHTING.lightDirection, SHADOW.bounds, SHADOW.size);
  const sceneBlock = uniforms<SceneValues>(gpu, {
    viewProjection: new Float32Array(16),
    lightViewProjection: light.viewProjection,
    cameraPosition: new Float32Array(3),
    time: 0,
    lightDirection: LIGHTING.lightDirection,
    lightIntensity: LIGHTING.lightIntensity,
    lightColor: LIGHTING.lightColor,
    envDiffuse: LIGHTING.envDiffuse,
    envSpecular: LIGHTING.envSpecular,
    shadowTexel: 1 / SHADOW.size,
    shadowNormalBias: SHADOW.normalBiasTexels * light.texelWorld,
    specularLevels: SPECULAR_LEVELS - 1,
  });

  // ---- Image-based lighting (baked once) + key-light shadow map ----
  const env = createEnvironment(gpu, LIGHTING.lightDirection);
  const irradianceMap = envCubeView(env.irradiance);
  const specularMap = envCubeView(env.specular);
  const envSampler = sampler(gpu, {
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear",
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge",
  });
  // vgpu targets always carry a colour attachment: a throwaway r8unorm one (never written) beside the depth.
  const shadowMap = target(gpu, { size: [SHADOW.size, SHADOW.size], format: "r8unorm", depth: SHADOW.format, label: "shadow" });
  const shadowSampler = sampler(gpu, {
    compare: "less-equal", minFilter: "linear", magFilter: "linear",
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
  });
  const lighting = { scene: sceneBlock, irradianceMap, specularMap, envSampler, shadowMap, shadowSampler };
  const casterState = { cull: "none", depth: { biasSlopeScale: SHADOW.biasSlopeScale }, writeMask: [] } as const;
  const shadowEntry = { vertex: "vs_shadow", fragment: "fs_shadow" };
  // ---- Picking: 1×1 ID target; the pass viewport shifts the requested pixel onto it ----
  const idEntry = {
    part: { vertex: "vs_part", fragment: "fs_id" },
    tooth: { vertex: "vs_tooth", fragment: "fs_id" },
    pin: { vertex: "vs_pin", fragment: "fs_id" },
  };
  const idTarget = target(gpu, { size: [1, 1], format: "rgba8unorm", depth: true, label: "pick-id" });

  const materialSampler = sampler(gpu, {
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear",
    addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8,
  });

  // ---- Opaque static/articulated parts: one draw per primitive with its own material ----
  const objects: SceneObject[] = [];
  for (const [name, part] of parts) {
    const obj: SceneObject = {
      name, node: part.matrix, world: new Float32Array(part.matrix), motion: motionFor(name, part, meta),
      models: [], draws: [], casters: [], glass: [], ids: [],
    };
    const ident = uniforms(gpu, { id: (PART_NAMES as readonly string[]).includes(name) ? partId(name as PartName) : 0, pad0: 0, pad1: 0, pad2: 0 });
    for (const [i, prim] of part.primitives.entries()) {
      const model = uniforms<ModelValues>(gpu, {
        world: obj.world, baseColor: prim.factors.baseColor, metallic: prim.factors.metallic, roughness: prim.factors.roughness,
      });
      obj.models.push(model);
      if (prim.blend) {
        // Glass: reflection layer only — no shadow (the movement stays lit under the panel).
        obj.glass.push(draw(gpu, {
          shader: glassShader, geometry: prim.geometry, label: `${name}.${i}.glass`,
          blend: "premultiplied", depth: { write: false }, cull: "back",
          set: { scene: sceneBlock, model, specularMap, envSampler },
        }));
        continue;
      }
      obj.draws.push(draw(gpu, {
        shader: pbrShader,
        geometry: prim.geometry,
        label: `${name}.${i}`,
        set: {
          ...lighting,
          model,
          baseColorMap: prim.textures.baseColor,
          normalMap: prim.textures.normal,
          ormMap: prim.textures.metallicRoughness,
          materialSampler,
        },
      }));
      obj.casters.push(draw(gpu, {
        shader: pbrShader, entry: shadowEntry, geometry: prim.geometry, label: `${name}.${i}.shadow`, ...casterState,
        set: { scene: sceneBlock, model },
      }));
      obj.ids.push(draw(gpu, {
        shader: idShader, entry: idEntry.part, geometry: prim.geometry, label: `${name}.${i}.id`,
        set: { scene: sceneBlock, model, ident },
      }));
    }
    if (obj.models.length) objects.push(obj);
  }

  // Per-frame scratch (no allocations in the frame loop).
  const tmpA = new Float32Array(16);
  const tmpB = new Float32Array(16);
  const quat: [number, number, number, number] = [0, 0, 0, 1];
  const spinPose = { quaternion: quat };
  const hingePose = { position: [0, 0, 0] as Vec3, quaternion: quat };
  const hingeBack = { position: [0, 0, 0] as Vec3 };
  const setQuat = (axis: Vec3, angle: number): void => {
    const [x, y, z] = normalize3(axis);
    const sn = Math.sin(angle / 2);
    quat[0] = x * sn; quat[1] = y * sn; quat[2] = z * sn; quat[3] = Math.cos(angle / 2);
  };
  const uploadModel = (o: SceneObject): void => {
    for (const model of o.models) model.set({ world: o.world });
  };
  const updateWorld = (o: SceneObject, s: RenderState): void => {
    const m = o.motion;
    if (m.kind === "static") return; // world + model uniform written once at creation
    if (m.kind === "spin") {
      // node × R(axis, angle): rotate about the part's own origin/axis
      setQuat(m.axis, m.angle(s));
      composeMatrix(spinPose, tmpA);
      multiplyMatrices(o.node, tmpA, o.world);
    } else {
      // T(p) × R(axis, angle) × T(−p) × node: rotate about the hinge line in world space
      setQuat(m.axis, m.angle(s));
      hingePose.position[0] = m.point[0]; hingePose.position[1] = m.point[1]; hingePose.position[2] = m.point[2];
      hingeBack.position[0] = -m.point[0]; hingeBack.position[1] = -m.point[1]; hingeBack.position[2] = -m.point[2];
      composeMatrix(hingePose, tmpA);
      composeMatrix(hingeBack, tmpB);
      multiplyMatrices(tmpA, tmpB, tmpA);
      multiplyMatrices(tmpA, o.node, o.world);
    }
    uploadModel(o);
  };

  // ---- Comb teeth: 18 instances of one unit-length tooth, bent in the vertex shader ----
  const toothGeometry = instancedGeometry(
    gpu, toothMesh(meta.comb.toothWidth, meta.comb.toothThickness), toothInstances(meta), "teeth",
  );
  const combPlucks = new Float32Array(18 * 4);
  const combPluckViews = Array.from({ length: 18 }, (_, i) => combPlucks.subarray(i * 4, i * 4 + 4));
  const combValues = { plucks: combPluckViews, tipZ: meta.comb.tipZ, combY: meta.comb.y, pad0: 0, pad1: 0 };
  const combBlock = uniforms(gpu, combValues);
  const teeth = draw(gpu, {
    shader: combShader, geometry: toothGeometry, label: "teeth", cull: "back", set: { ...lighting, comb: combBlock },
  });
  const teethCaster = draw(gpu, {
    shader: combShader, entry: shadowEntry, geometry: toothGeometry, label: "teeth.shadow", ...casterState,
    set: { scene: sceneBlock, comb: combBlock },
  });
  const teethId = draw(gpu, {
    shader: idShader, entry: idEntry.tooth, geometry: toothGeometry, label: "teeth.id", cull: "back",
    set: { scene: sceneBlock, comb: combBlock },
  });

  // ---- Pins: one instance per arranged note, rebuilt by setPins ----
  const pinBase = pinMesh(meta.pinRadius, meta.pinHeight);
  let pinGeometry: Geometry | null = null;
  let pins: Draw | null = null;
  let pinsCaster: Draw | null = null;
  let pinsId: Draw | null = null;
  const pinValues = {
    center: new Float32Array(meta.cylinder.center), cylinderAngle: 0, radius: meta.cylinder.radius,
    pad0: 0, pad1: 0, pad2: 0,
  };
  const pinsBlock = uniforms(gpu, pinValues);
  const disposePins = (): void => {
    pins?.dispose();
    pinsCaster?.dispose();
    pinsId?.dispose();
    pinGeometry?.destroy();
    pins = null;
    pinsCaster = null;
    pinsId = null;
    pinGeometry = null;
  };

  // Per-frame uniform updates shared by the shadow and scene passes.
  const updateDynamic = (s: RenderState): void => {
    const src = s.plucks;
    for (let i = 0; i < 18; i++) {
      combPlucks[i * 4] = src[i * 2] ?? 0;
      combPlucks[i * 4 + 1] = src[i * 2 + 1] ?? 0;
    }
    combBlock.set({ plucks: combPluckViews });
    pinsBlock.set({ cylinderAngle: s.cylinderAngle });
  };

  // Shadow map: re-rendered only when a caster moved (parts, lid, key, pins or a still-ringing tooth).
  const shadowKey = new Float64Array(4).fill(NaN); // cylinderAngle, keyAngle, lidOpen01, pin set revision
  let pinRevision = 0;
  const RING_SECONDS = 6; // longest tooth tau is 1.2 s: e^-5 of the amplitude is invisible
  const shadowDirty = (s: RenderState): boolean => {
    let dirty = false;
    for (let i = 0; i < 18 && !dirty; i++) {
      const t = s.time - (s.plucks[i * 2] ?? 0);
      if ((s.plucks[i * 2 + 1] ?? 0) > 0 && t > -0.1 && t < RING_SECONDS) dirty = true;
    }
    const k0 = s.cylinderAngle, k1 = s.keyAngle, k2 = s.lidOpen01, k3 = pinRevision;
    if (k0 !== shadowKey[0] || k1 !== shadowKey[1] || k2 !== shadowKey[2] || k3 !== shadowKey[3]) dirty = true;
    shadowKey[0] = k0; shadowKey[1] = k1; shadowKey[2] = k2; shadowKey[3] = k3;
    return dirty;
  };
  const shadowLayers: ((pass: FramePass) => void)[] = [
    (pass) => { for (const o of objects) for (const d of o.casters) pass.draw(d); },
    (pass) => pass.draw(teethCaster),
    (pass) => { if (pinsCaster) pass.draw(pinsCaster); },
  ];

  // Ordered list of scene layers encoded into the HDR pass: opaque parts, teeth, pins, then glass last.
  const sceneLayers: ((pass: FramePass) => void)[] = [
    (pass) => { for (const o of objects) for (const d of o.draws) pass.draw(d); },
    (pass) => pass.draw(teeth),
    (pass) => { if (pins) pass.draw(pins); },
    (pass) => { for (const o of objects) for (const d of o.glass) pass.draw(d); },
  ];

  // ---- Post: HDR → output ----
  const post = effect(gpu, postShader, {
    set: { hdr, hdrSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
  });
  const encodeSrgb = output.format.endsWith("-srgb") ? 0 : 1;

  let pickChain: Promise<number> = Promise.resolve(0);
  const pickNow = async (px: number, py: number): Promise<number> => {
    const [w, h] = output.size;
    if (disposed || !rendered || !(px >= 0 && py >= 0 && px < w && py < h)) return 0;
    const x = Math.floor(px), y = Math.floor(py);
    const f = frame(gpu);
    try {
      // Same camera / animation uniforms as the last render(): only the viewport differs.
      f.pass({ target: idTarget, clear: [0, 0, 0, 0], clearDepth: 1, viewport: { x: -x, y: -y, width: w, height: h } }, (pass) => {
        for (const o of objects) for (const d of o.ids) pass.draw(d);
        pass.draw(teethId);
        if (pinsId) pass.draw(pinsId);
      });
      f.submit();
    } catch (err) {
      f.cancel();
      throw err;
    }
    const px4 = await idTarget.color.read({ mipLevel: 0, region: "all" });
    return (px4[0] ?? 0) | ((px4[1] ?? 0) << 8);
  };
  let rendered = false;

  const cam: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16), position: new Float32Array(3) };
  let disposed = false;

  return {
    setPins(instances: Float32Array): void {
      if (instances.length % 4 !== 0) {
        throw new RangeError(`setPins: expected [x, angle0, tooth, 0] quadruples, got ${instances.length} floats`);
      }
      disposePins();
      pinRevision++; // the shadow map must drop the old pins / add the new ones
      if (disposed || instances.length === 0) return;
      pinGeometry = instancedGeometry(gpu, pinBase, instances, "pins");
      pins = draw(gpu, { shader: pinsShader, geometry: pinGeometry, label: "pins", cull: "back", set: { ...lighting, pins: pinsBlock } });
      pinsCaster = draw(gpu, {
        shader: pinsShader, entry: shadowEntry, geometry: pinGeometry, label: "pins.shadow", ...casterState,
        set: { scene: sceneBlock, pins: pinsBlock },
      });
      pinsId = draw(gpu, {
        shader: idShader, entry: idEntry.pin, geometry: pinGeometry, label: "pins.id", cull: "back",
        set: { scene: sceneBlock, pins: pinsBlock },
      });
    },

    render(s: RenderState): void {
      if (disposed) return;
      const f = frame(gpu); // advances the clock; a surface output auto-resizes here
      try {
        const [w, h] = output.size;
        if (hdr.size[0] !== w || hdr.size[1] !== h) hdr.resize([w, h]);
        const aspect = w / Math.max(1, h);
        cameraMatrices(s.orbit, aspect, cam);
        sceneBlock.set({ viewProjection: cam.viewProjection, cameraPosition: cam.position, time: s.time });
        for (const o of objects) updateWorld(o, s);
        updateDynamic(s);
        post.set({ post: { exposure: LIGHTING.exposure, vignette: LIGHTING.vignette, encodeSrgb, aspect } });

        if (shadowDirty(s)) {
          f.pass({ target: shadowMap, clear: [1, 1, 1, 1], clearDepth: 1 }, (pass) => {
            for (const layer of shadowLayers) layer(pass);
          });
        }
        f.pass({ target: hdr, clear: LIGHTING.clear, clearDepth: 1 }, (pass) => {
          for (const layer of sceneLayers) layer(pass);
        });
        f.pass(output, post);
        f.submit();
        rendered = true;
      } catch (err) {
        f.cancel();
        throw err;
      }
    },

    pick(px: number, py: number): Promise<number> {
      // Serialised: each pick renders into the shared 1×1 target and reads it back before the next one.
      const run = (): Promise<number> => pickNow(px, py);
      pickChain = pickChain.then(run, run);
      return pickChain;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const o of objects) for (const d of [...o.draws, ...o.casters, ...o.glass, ...o.ids]) d.dispose();
      teeth.dispose();
      teethCaster.dispose();
      teethId.dispose();
      toothGeometry.destroy();
      disposePins();
      post.dispose();
      (hdr as Target & { destroy?: () => void }).destroy?.();
      (shadowMap as Target & { destroy?: () => void }).destroy?.();
      (idTarget as Target & { destroy?: () => void }).destroy?.();
      env.irradiance.destroy();
      env.specular.destroy();
    },
  };
}
