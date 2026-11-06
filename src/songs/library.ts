import type { Note, Song } from "./types";

// Public-domain compositions, hand-arranged as note data.
// MIDI: C4=60, A4=69. Notes outside the comb are octave-shifted by arrange().
const E5 = 76, Ds5 = 75, D5 = 74, C5 = 72, B4 = 71, A4 = 69, Gs4 = 68, G4 = 67;
const F5 = 77, G5 = 79, A5 = 81, F4 = 65, E4 = 64, C4 = 60;
const A2 = 45, E3 = 52, Gs3 = 56, B3 = 59, A3 = 57;

/** Sixteenth-step helper: step i -> beat i/4. */
const at16 = (step: number, midi: number): Note => ({ beat: step / 4, midi });

// ---- Für Elise (Beethoven), opening theme, A minor, 3/4 -------------------
/** Melody of one statement; steps are sixteenths relative to the statement start. */
const ELISE_MELODY: [number, number][] = [
  [0, E5], [1, Ds5],
  [2, E5], [3, Ds5], [4, E5], [5, B4], [6, D5], [7, C5],
  [8, A4], [11, C4], [12, E4], [13, A4],
  [14, B4], [17, E4], [18, Gs4], [19, B4],
  [20, C5], [23, E4],
  [24, E5], [25, Ds5],
  [26, E5], [27, Ds5], [28, E5], [29, B4], [30, D5], [31, C5],
  [32, A4], [35, C4], [36, E4], [37, A4],
  [38, B4], [41, E4], [42, C5], [43, B4],
  [44, A4],
];
const ELISE_BASS: [number, number][] = [
  [8, A2], [10, E3],
  [14, E3], [16, Gs3], [18, B3],
  [20, A2], [22, E3],
  [32, A2], [34, E3],
  [38, E3],
  [44, A2],
];
const eliseNotes: Note[] = [];
for (const [s, m] of ELISE_MELODY) eliseNotes.push(at16(s, m));
for (const [s, m] of ELISE_BASS) eliseNotes.push(at16(s + 48, m)); // bass only in 2nd statement
for (const [s, m] of ELISE_MELODY) eliseNotes.push(at16(s + 48, m));
eliseNotes.push({ beat: 24, midi: E3 }, { beat: 25, midi: A3 }); // closing arpeggio

// ---- Canon in D (Pachelbel) transposed to C, ground bass + melody ---------
// Chords C G Am Em F C F G, two beats each; three 16-beat cycles.
const CANON_BASS = [48, 43, 45, 52, 53, 48, 53, 43];
const CANON_THEME = [E5, D5, C5, B4, A4, G4, A4, B4];
const CANON_QUARTERS: [number, number][] = [
  [G5, E5], [D5, B4], [C5, A4], [B4, G4], [A4, C5], [G4, C5], [A4, F5], [B4, D5],
];
const CANON_EIGHTHS: number[][] = [
  [E5, C5, G4, C5], [D5, B4, G4, B4], [C5, A4, E4, A4], [B4, G4, E4, G4],
  [A4, F4, C4, F4], [G4, E4, C4, E4], [A4, C5, F5, C5], [B4, D5, G4, D5],
];
const canonNotes: Note[] = [];
for (let cycle = 0; cycle < 3; cycle++) {
  for (let i = 0; i < 8; i++) {
    const b = cycle * 16 + i * 2;
    canonNotes.push({ beat: b, midi: CANON_BASS[i]! });
    if (cycle === 0) canonNotes.push({ beat: b, midi: CANON_THEME[i]! });
    else if (cycle === 1) {
      canonNotes.push({ beat: b, midi: CANON_QUARTERS[i]![0] });
      canonNotes.push({ beat: b + 1, midi: CANON_QUARTERS[i]![1] });
    } else CANON_EIGHTHS[i]!.forEach((m, k) => canonNotes.push({ beat: b + k * 0.5, midi: m }));
  }
}

// ---- Twinkle, Twinkle, Little Star, C major, with root/third harmony -------
const LINE_A: [number, number][] = [
  [C5, 1], [C5, 1], [G5, 1], [G5, 1], [A5, 1], [A5, 1], [G5, 2],
  [F5, 1], [F5, 1], [E5, 1], [E5, 1], [D5, 1], [D5, 1], [C5, 2],
];
const LINE_B: [number, number][] = [
  [G5, 1], [G5, 1], [F5, 1], [F5, 1], [E5, 1], [E5, 1], [D5, 2],
];
const twinkleMelody = [...LINE_A, ...LINE_B, ...LINE_B, ...LINE_A];
const twinkleNotes: Note[] = [];
let tb = 0;
for (const [m, d] of twinkleMelody) { twinkleNotes.push({ beat: tb, midi: m }); tb += d; }
// chord per 2 beats: 0=C, 1=F, 2=G
const A_CH = [0, 0, 1, 0, 1, 0, 2, 0];   // C C | F C | F C | G C  (16 beats)
const B_CH = [0, 1, 0, 2];               // C F | C G
const twChords = [...A_CH, ...B_CH, ...B_CH, ...A_CH];
const TW_ROOT = [C4, F4, 67];
const TW_THIRD = [E4, A4, B4];
twChords.forEach((c, i) => {
  twinkleNotes.push({ beat: i * 2, midi: TW_ROOT[c]! });
  twinkleNotes.push({ beat: i * 2 + 1, midi: TW_THIRD[c]! });
});

// ---- 千年等一回, chorus only, C major (1 = C), 4/4, 4 phrases x 2 bars ------
// Not public domain: added at the user's request. Melody + sparse C Am F G
// broken-chord accompaniment, kept at or below the melody register.
const QN_MELODY: [number, number][] = [
  // phrase 1
  [0, G4], [0.5, A4], [1, C5], [2, D5], [3, C5], [4, A4], [5, G4],
  // phrase 2
  [8, G4], [8.5, A4], [9, C5], [10, D5], [11, D5],
  // phrase 3
  [16, G4], [16.5, A4], [17, C5], [18, D5], [19, C5], [20, A4], [21, G4],
  // phrase 4
  [24, G4], [25, E5], [26, D5], [27, C5], [28, C5],
];
const qiannianNotes: Note[] = QN_MELODY.map(([beat, midi]) => ({ beat, midi }));
// One bar of broken chord (4 beats): root @0, fifth @2, third @3 (1-5-3 shape).
const QN_C = [C4, G4, E4], QN_AM = [A3, E4, C4], QN_F = [F4, C4, A3], QN_G = [G4, 71, 71];
const QN_BARS = [QN_C, QN_AM, QN_F, QN_G, QN_C, QN_AM, QN_F, QN_C];
QN_BARS.forEach((chord, bar) => {
  [0, 2, 3].forEach((off, k) => qiannianNotes.push({ beat: bar * 4 + off, midi: chord[k]! }));
});

export const SONGS: readonly Song[] = [
  { id: "fur-elise", title: "给爱丽丝", bpm: 100, beatsPerRevolution: 27, notes: eliseNotes },
  { id: "canon", title: "卡农", bpm: 140, beatsPerRevolution: 48, notes: canonNotes },
  { id: "twinkle", title: "小星星", bpm: 126, beatsPerRevolution: 48, notes: twinkleNotes },
  { id: "qiannian", title: "千年等一回", bpm: 100, beatsPerRevolution: 32, notes: qiannianNotes },
];
