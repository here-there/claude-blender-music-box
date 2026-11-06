import { orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";

export interface OrbitState {
  yaw: number; // radians about +Y, 0 = camera on the +Z (comb / front) side
  pitch: number; // radians above the horizon
  distance: number; // metres from target
  target: [number, number, number];
}

/**
 * Below the horizon is allowed (Task 11): the winding key sits under the case, between the felt feet,
 * so the user must be able to orbit underneath to grab it.
 */
export const PITCH_LIMITS = [-1.3, 1.45] as const;
export const DISTANCE_LIMITS = [0.12, 0.6] as const;
export const LENS = { fov: 35, near: 0.005, far: 5 } as const;

/**
 * Narrow (portrait) viewports keep the horizontal coverage the default view has at FIT_ASPECT:
 * first by widening the vertical FOV up to MAX_FOV, then by dollying the camera back for the rest.
 * Wider viewports are untouched. Applied inside cameraMatrices only, so orbit state and zoom limits
 * keep their meaning on every screen.
 */
export const FIT_ASPECT = 1.25;
export const MAX_FOV = 55;

export interface Framing {
  fov: number; // vertical, degrees
  dolly: number; // multiplier on orbit distance, >= 1
}

const DEG = Math.PI / 180;

export function framingForAspect(aspect: number): Framing {
  if (!(aspect > 0) || aspect >= FIT_ASPECT) return { fov: LENS.fov, dolly: 1 };
  const needed = Math.tan((LENS.fov / 2) * DEG) * (FIT_ASPECT / aspect); // tan of required half-FOV
  const used = Math.min(needed, Math.tan((MAX_FOV / 2) * DEG));
  return { fov: (2 * Math.atan(used)) / DEG, dolly: needed / used };
}

/**
 * 3/4 showcase view from the front-right, high enough to look over the front wall onto the comb,
 * cylinder and pins, with the open lid fully in frame (target sits between the movement and the lid).
 */
export const DEFAULT_ORBIT: OrbitState = Object.freeze({
  yaw: 0.45,
  pitch: 0.85,
  distance: 0.4,
  target: Object.freeze([-0.004, 0.05, -0.022]) as unknown as [number, number, number],
});

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function clampOrbit(s: OrbitState): OrbitState {
  return {
    yaw: s.yaw,
    pitch: clamp(s.pitch, PITCH_LIMITS[0], PITCH_LIMITS[1]),
    distance: clamp(s.distance, DISTANCE_LIMITS[0], DISTANCE_LIMITS[1]),
    target: [s.target[0], s.target[1], s.target[2]],
  };
}

export interface CameraMatrices {
  view: Float32Array;
  viewProjection: Float32Array;
  position: Float32Array;
}

// Scratch reused across calls (the render loop calls this every frame).
const scratchQuat = new Float32Array(4);
const scratchProjection = new Float32Array(16);

export function cameraMatrices(s: OrbitState, aspect: number, out?: CameraMatrices): CameraMatrices {
  const c = clampOrbit(s);
  const fit = framingForAspect(aspect);
  const rig = orbitRig({ target: c.target, yaw: c.yaw, pitch: c.pitch, distance: c.distance * fit.dolly });
  const pose = { position: out?.position ?? new Float32Array(3), quaternion: scratchQuat };
  rigPose(rig, pose);
  const projection = perspective({ ...LENS, fov: fit.fov }, aspect, scratchProjection);
  const m = { view: out?.view ?? new Float32Array(16), viewProjection: out?.viewProjection ?? new Float32Array(16) };
  viewMatrices(pose, projection, m);
  return { view: m.view, viewProjection: m.viewProjection, position: pose.position };
}

/** Exponential approach of `current` toward `goal` (in place) with time constant `tau` seconds. */
export function dampOrbit(current: OrbitState, goal: OrbitState, dt: number, tau = 0.12): void {
  const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
  current.yaw += (goal.yaw - current.yaw) * k;
  current.pitch += (goal.pitch - current.pitch) * k;
  current.distance += (goal.distance - current.distance) * k;
  const c = current.target, g = goal.target;
  c[0] += (g[0] - c[0]) * k;
  c[1] += (g[1] - c[1]) * k;
  c[2] += (g[2] - c[2]) * k;
}

/** Wraps an angle to (-π, π]. */
export function wrapToPi(a: number): number {
  const t = a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
  return t === -Math.PI ? Math.PI : t;
}

/** Default orbit, with yaw reached by the shortest turn from `current` (never whirls through accumulated turns). */
export function resetOrbit(current: OrbitState): OrbitState {
  const d = clampOrbit({ ...DEFAULT_ORBIT, target: [...DEFAULT_ORBIT.target] });
  const delta = DEFAULT_ORBIT.yaw - current.yaw;
  if (Math.abs(delta) > Math.PI) d.yaw = current.yaw + wrapToPi(delta); // else already the shortest way: land exactly
  return d;
}
