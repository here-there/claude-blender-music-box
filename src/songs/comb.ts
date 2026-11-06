import comb from "../../shared/comb.json";

export const COMB_PITCHES: readonly number[] = comb.pitches;
export const COMB_TOOTH_COUNT = 18;

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
