import { draw, effect, frame, sampler, target, uniforms, type Draw, type FramePass, type Gpu, type Target } from "vgpu";
import { composeMatrix, multiplyMatrices } from "vgpu/scene";
import type { GpuPart } from "../gltf/upload";
import type { MusicBoxMeta, Vec3 } from "../meta";
import { cameraMatrices, type CameraMatrices, type OrbitState } from "./camera";
import pbrShader from "./shaders/pbr.wgsl";
import postShader from "./shaders/post.wgsl";

export interface RenderState {
  time: number;
  /** Signed cylinder angle in radians (main computes −2π·phase). Parts turn by extras.ratio · cylinderAngle. */
  cylinderAngle: number;
  keyAngle: number;
  /** Already eased 0..1 (see easeLid). */
  lidOpen01: number;
  orbit: OrbitState;
  /** 18×2: [pluckTime, amplitude] — used from Task 8. */
  plucks: Float32Array;
}

export interface Renderer {
  setPins(instances: Float32Array): void; // Task 8
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

function axisAngleQuat(axis: ArrayLike<number>, angle: number): [number, number, number, number] {
  const [x, y, z] = normalize3([axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0]);
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

function vec3Extra(extras: Record<string, unknown>, key: string): Vec3 | null {
  const v = extras[key];
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number")) return null;
  const [x, y, z] = v as number[];
  return [x!, y!, z!];
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
 *   scene pass  → HDR target (rgba16float, depth, 4× MSAA): opaque layers in order (parts now; teeth/pins T8; glass T10)
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

  const tmpA = new Float32Array(16);
  const tmpB = new Float32Array(16);
  const updateWorld = (o: SceneObject, s: RenderState): void => {
    const m = o.motion;
    if (m.kind === "static") {
      o.world.set(o.node);
    } else if (m.kind === "spin") {
      // node × R(axis, angle): rotate about the part's own origin/axis
      composeMatrix({ quaternion: axisAngleQuat(m.axis, m.angle(s)) }, tmpA);
      multiplyMatrices(o.node, tmpA, o.world);
    } else {
      // T(p) × R(axis, angle) × T(−p) × node: rotate about the hinge line in world space
      composeMatrix({ position: m.point, quaternion: axisAngleQuat(m.axis, m.angle(s)) }, tmpA);
      composeMatrix({ position: [-m.point[0], -m.point[1], -m.point[2]] }, tmpB);
      multiplyMatrices(tmpA, tmpB, tmpA);
      multiplyMatrices(tmpA, o.node, o.world);
    }
    for (const { draw: d, factors } of o.draws) {
      d.set({ model: { world: o.world, baseColor: factors.baseColor, metallic: factors.metallic, roughness: factors.roughness } });
    }
  };

  // Ordered list of scene layers encoded into the HDR pass. T8/T10 append their own layers.
  const sceneLayers: ((pass: FramePass, s: RenderState) => void)[] = [
    (pass) => { for (const o of objects) for (const { draw: d } of o.draws) pass.draw(d); },
  ];

  // ---- Post: HDR → output ----
  const post = effect(gpu, postShader, {
    set: { hdr, hdrSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
  });
  const encodeSrgb = output.format.endsWith("-srgb") ? 0 : 1;

  const cam: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16), position: new Float32Array(3) };
  let disposed = false;

  return {
    setPins(_instances: Float32Array): void {
      // Task 8: instanced pins.
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
      post.dispose();
      (hdr as Target & { destroy?: () => void }).destroy?.();
    },
  };
}
