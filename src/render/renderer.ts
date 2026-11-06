import { draw, effect, frame, geometry, sampler, target, uniforms, type Draw, type FramePass, type Geometry, type Gpu, type Target } from "vgpu";
import { composeMatrix, multiplyMatrices } from "vgpu/scene";
import type { MeshData } from "../gltf/glb";
import type { GpuPart } from "../gltf/upload";
import { toothInstances, toothMesh } from "../geometry/comb";
import { pinMesh } from "../geometry/pins";
import type { MusicBoxMeta, Vec3 } from "../meta";
import { cameraMatrices, type CameraMatrices, type OrbitState } from "./camera";
import combShader from "./shaders/comb.wgsl";
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
  pick(cssX: number, cssY: number): Promise<number>; // Task 11: PartId encoding, 0 = none
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
  envDiffuse: 0.55,
  envSpecular: 0.8,
  skyColor: [0.46, 0.42, 0.38] as Vec3,
  groundColor: [0.11, 0.085, 0.065] as Vec3,
  exposure: 1.0,
  vignette: 0.55,
  clear: [0.018, 0.014, 0.012, 1] as [number, number, number, number],
};

/** Mirrors `struct Scene` in pbr.wgsl. */
type SceneValues = {
  viewProjection: Float32Array;
  cameraPosition: Float32Array;
  time: number;
  lightDirection: Vec3;
  lightIntensity: number;
  lightColor: Vec3;
  envDiffuse: number;
  skyColor: Vec3;
  envSpecular: number;
  groundColor: Vec3;
  pad0: number;
};

const HDR_FORMAT: GPUTextureFormat = "rgba16float";

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
  draws: { draw: Draw; factors: GpuPart["primitives"][number]["factors"] }[];
}

/**
 * Renderer layout (later tasks plug in here):
 *   scene pass  → HDR target (rgba16float, depth, 4× MSAA): opaque layers in order (parts, teeth, pins; glass T10)
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

  const sceneBlock = uniforms<SceneValues>(gpu, {
    viewProjection: new Float32Array(16),
    cameraPosition: new Float32Array(3),
    time: 0,
    lightDirection: LIGHTING.lightDirection,
    lightIntensity: LIGHTING.lightIntensity,
    lightColor: LIGHTING.lightColor,
    envDiffuse: LIGHTING.envDiffuse,
    skyColor: LIGHTING.skyColor,
    envSpecular: LIGHTING.envSpecular,
    groundColor: LIGHTING.groundColor,
    pad0: 0,
  });

  const materialSampler = sampler(gpu, {
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear",
    addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8,
  });

  // ---- Opaque static/articulated parts: one draw per primitive with its own material ----
  const objects: SceneObject[] = [];
  for (const [name, part] of parts) {
    const obj: SceneObject = {
      name, node: part.matrix, world: new Float32Array(part.matrix), motion: motionFor(name, part, meta), draws: [],
    };
    for (const [i, prim] of part.primitives.entries()) {
      if (prim.blend) continue; // glass: drawn by the transparent layer (Task 10)
      const d = draw(gpu, {
        shader: pbrShader,
        geometry: prim.geometry,
        label: `${name}.${i}`,
        set: {
          scene: sceneBlock,
          baseColorMap: prim.textures.baseColor,
          normalMap: prim.textures.normal,
          ormMap: prim.textures.metallicRoughness,
          materialSampler,
        },
      });
      obj.draws.push({ draw: d, factors: prim.factors });
    }
    if (obj.draws.length) objects.push(obj);
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
    for (const { draw: d, factors } of o.draws) {
      d.set({ model: { world: o.world, baseColor: factors.baseColor, metallic: factors.metallic, roughness: factors.roughness } });
    }
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
  for (const o of objects) if (o.motion.kind === "static") uploadModel(o);

  // ---- Comb teeth: 18 instances of one unit-length tooth, bent in the vertex shader ----
  const toothGeometry = instancedGeometry(
    gpu, toothMesh(meta.comb.toothWidth, meta.comb.toothThickness), toothInstances(meta), "teeth",
  );
  const teeth = draw(gpu, { shader: combShader, geometry: toothGeometry, label: "teeth", cull: "back" });
  const combPlucks = new Float32Array(18 * 4);
  const combPluckViews = Array.from({ length: 18 }, (_, i) => combPlucks.subarray(i * 4, i * 4 + 4));
  const combValues = { plucks: combPluckViews, tipZ: meta.comb.tipZ, combY: meta.comb.y, pad0: 0, pad1: 0 };
  teeth.set({ scene: sceneBlock });

  // ---- Pins: one instance per arranged note, rebuilt by setPins ----
  const pinBase = pinMesh(meta.pinRadius, meta.pinHeight);
  let pinGeometry: Geometry | null = null;
  let pins: Draw | null = null;
  const pinValues = {
    center: new Float32Array(meta.cylinder.center), cylinderAngle: 0, radius: meta.cylinder.radius,
    pad0: 0, pad1: 0, pad2: 0,
  };
  const disposePins = (): void => {
    pins?.dispose();
    pinGeometry?.destroy();
    pins = null;
    pinGeometry = null;
  };

  // Ordered list of scene layers encoded into the HDR pass. T8/T10 append their own layers.
  const sceneLayers: ((pass: FramePass, s: RenderState) => void)[] = [
    (pass) => { for (const o of objects) for (const { draw: d } of o.draws) pass.draw(d); },
    (pass, s) => {
      const src = s.plucks;
      for (let i = 0; i < 18; i++) {
        combPlucks[i * 4] = src[i * 2] ?? 0;
        combPlucks[i * 4 + 1] = src[i * 2 + 1] ?? 0;
      }
      teeth.set({ comb: combValues });
      pass.draw(teeth);
    },
    (pass, s) => {
      if (!pins) return;
      pinValues.cylinderAngle = s.cylinderAngle;
      pins.set({ pins: pinValues });
      pass.draw(pins);
    },
  ];

  // ---- Post: HDR → output ----
  const post = effect(gpu, postShader, {
    set: { hdr, hdrSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
  });
  const encodeSrgb = output.format.endsWith("-srgb") ? 0 : 1;

  const cam: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16), position: new Float32Array(3) };
  let disposed = false;

  return {
    setPins(instances: Float32Array): void {
      if (instances.length % 4 !== 0) {
        throw new RangeError(`setPins: expected [x, angle0, tooth, 0] quadruples, got ${instances.length} floats`);
      }
      disposePins();
      if (disposed || instances.length === 0) return;
      pinGeometry = instancedGeometry(gpu, pinBase, instances, "pins");
      pins = draw(gpu, { shader: pinsShader, geometry: pinGeometry, label: "pins", cull: "back", set: { scene: sceneBlock } });
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
        post.set({ post: { exposure: LIGHTING.exposure, vignette: LIGHTING.vignette, encodeSrgb, aspect } });

        f.pass({ target: hdr, clear: LIGHTING.clear, clearDepth: 1 }, (pass) => {
          for (const layer of sceneLayers) layer(pass, s);
        });
        f.pass(output, post);
        f.submit();
      } catch (err) {
        f.cancel();
        throw err;
      }
    },

    pick(_cssX: number, _cssY: number): Promise<number> {
      return Promise.resolve(0); // Task 11
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const o of objects) for (const { draw: d } of o.draws) d.dispose();
      teeth.dispose();
      toothGeometry.destroy();
      disposePins();
      post.dispose();
      (hdr as Target & { destroy?: () => void }).destroy?.();
    },
  };
}
