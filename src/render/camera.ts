import { orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";

export interface OrbitState {
  yaw: number; // radians about +Y, 0 = camera on the +Z (comb / front) side
  pitch: number; // radians above the horizon
  distance: number; // metres from target
  target: [number, number, number];
}

export const PITCH_LIMITS = [0.1, 1.45] as const;
export const DISTANCE_LIMITS = [0.12, 0.6] as const;
export const LENS = { fov: 35, near: 0.005, far: 5 } as const;

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
  const rig = orbitRig({ target: c.target, yaw: c.yaw, pitch: c.pitch, distance: c.distance });
  const pose = { position: out?.position ?? new Float32Array(3), quaternion: scratchQuat };
  rigPose(rig, pose);
  const projection = perspective(LENS, aspect, scratchProjection);
  const m = { view: out?.view ?? new Float32Array(16), viewProjection: out?.viewProjection ?? new Float32Array(16) };
  viewMatrices(pose, projection, m);
  return { view: m.view, viewProjection: m.viewProjection, position: pose.position };
}
