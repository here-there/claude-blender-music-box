/** Inharmonic partial ratios of a struck steel comb tooth. */
export const PARTIAL_RATIOS = [1, 2.76, 5.4, 8.93] as const;
const PARTIAL_GAINS = [1, 0.35, 0.15, 0.06] as const;
const MAX_FREQ = 16000;
/** Allowed lateness (s) before an event counts as expired. */
const LATE_TOLERANCE = 0.005;

export interface PartialParams {
  freq: number;
  gain: number;
  /** Time (s) for the partial to decay to -60 dB. */
  decay: number;
}

export function voiceParams(midi: number, velocity: number): PartialParams[] {
  const f0 = 440 * Math.pow(2, (midi - 69) / 12);
  const u = Math.min(1, Math.max(0, (midi - 57) / (86 - 57)));
  const base = 3.0 + (0.8 - 3.0) * u;
  const out: PartialParams[] = [];
  PARTIAL_RATIOS.forEach((ratio, k) => {
    const freq = f0 * ratio;
    if (freq > MAX_FREQ) return;
    out.push({ freq, gain: velocity * PARTIAL_GAINS[k]!, decay: base / (1 + 1.5 * k) });
  });
  return out;
}

/** Maps a mechanism-clock event time to the audio clock; null when already stale. */
export function toAudioTime(eventTime: number, now: number, audioNow: number): number | null {
  const t = audioNow + (eventTime - now);
  return t < audioNow - LATE_TOLERANCE ? null : t;
}
