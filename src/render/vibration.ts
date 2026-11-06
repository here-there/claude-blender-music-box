// CPU reference for the comb-tooth vibration. comb.wgsl implements the same formula; keep them in sync.

/** Displacement scale in metres (along +Y) for amplitude 1. */
export const BASE_AMPLITUDE = 0.0006;
/** Duration of the pin push-up phase before release (t < 0). */
export const PUSH_SECONDS = 0.04;

/** Visible (slowed-down) vibration frequency in Hz: 6 Hz bass → 16 Hz treble. */
export function visFrequency(toothIndex: number): number {
  return 6 + (10 * toothIndex) / 17;
}

/** Exponential decay time constant in seconds: 1.2 s bass → 0.4 s treble. */
export function decayTau(toothIndex: number): number {
  return 1.2 - (0.8 * toothIndex) / 17;
}

/**
 * Vertical displacement (metres, +Y) of a tooth at fraction u ∈ [0,1] from root to tip,
 * t seconds after the pin releases it (t < 0: the pin is still pushing it up).
 */
export function toothDisplacement(t: number, amplitude: number, toothIndex: number, u: number): number {
  const a = BASE_AMPLITUDE * amplitude * u * u;
  if (t < 0) return t < -PUSH_SECONDS ? 0 : a * (1 + t / PUSH_SECONDS);
  return a * Math.exp(-t / decayTau(toothIndex)) * Math.cos(2 * Math.PI * visFrequency(toothIndex) * t);
}
