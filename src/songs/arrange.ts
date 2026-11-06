import { COMB_PITCHES, noteName } from "./comb";
import type { ArrangedPin, Song } from "./types";

const SHIFTS = [0, 12, -12, 24, -24];

export function arrange(song: Song, pitches: readonly number[] = COMB_PITCHES): ArrangedPin[] {
  const pins: ArrangedPin[] = song.notes.map((n) => {
    for (const s of SHIFTS) {
      const tooth = pitches.indexOf(n.midi + s);
      if (tooth >= 0) return { tooth, beat: n.beat, midi: n.midi + s };
    }
    throw new Error(`note ${noteName(n.midi)} at beat ${n.beat} has no tooth`);
  });
  return pins.sort((a, b) => a.beat - b.beat);
}

export function findCooldownViolations(
  song: Song,
  pins: readonly ArrangedPin[],
  minGapMs = 120,
): { tooth: number; beatA: number; beatB: number }[] {
  const msPerBeat = 60000 / song.bpm;
  const byTooth = new Map<number, number[]>();
  for (const p of pins) {
    const l = byTooth.get(p.tooth) ?? [];
    l.push(p.beat);
    byTooth.set(p.tooth, l);
  }
  const out: { tooth: number; beatA: number; beatB: number }[] = [];
  for (const [tooth, beats] of byTooth) {
    beats.sort((a, b) => a - b);
    for (let i = 1; i < beats.length; i++) {
      if ((beats[i]! - beats[i - 1]!) * msPerBeat < minGapMs - 1e-9)
        out.push({ tooth, beatA: beats[i - 1]!, beatB: beats[i]! });
    }
    const first = beats[0]!, last = beats[beats.length - 1]!;
    if (beats.length >= 1 && (song.beatsPerRevolution - last + first) * msPerBeat < minGapMs - 1e-9)
      out.push({ tooth, beatA: last, beatB: first });
  }
  return out;
}
