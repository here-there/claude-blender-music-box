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

// ---- 千年等一回 (左宏元), from the verse to the end, F major (1 = F4), 4/4 -----
// Not public domain: added at the user's request. Melody transcribed from the
// original-singer 简谱 (1=G, ♩=110) and transposed to F so every melody note is a
// comb pitch: 2=G4 3=A4 5=C5 6=D5 | i=F5 2=G5 3=A5 6=D6 (dotted = high octave).
// Grace notes are omitted; tied notes are struck once. No lyrics.
const QN_D6 = 86;
const QN_MELODY: [number, number][] = [
  // verse (bars 1-8)
  [0, A4], [1, A4], [2, C5], [3, A4], [3.5, C5],
  [4, D5], [6, F5],
  [8, D5], [9, D5], [10, F5], [11, D5], [11.5, F5],
  [12, G5],
  [16, C5], [17, D5], [18, F5], [19, D5],
  [20, A4], [20.5, G4], [22, A4], [23, G4], [23.5, A4],
  [24, C5], [25, D5], [26, F5], [27, G5], [27.5, D5],
  [28, C5], [28.5, D5],
  // pre-chorus (bars 9-13)
  [34, A5], [35, A5], [35.5, G5],
  [36, G5], [38, G5], [39, G5], [39.5, A5],
  [40, F5], [41, D5], [42, A5], [43, A5], [43.5, G5],
  [44, G5], [46, G5], [47, G5], [47.5, A5],
  [48, F5], [49, D5],
  // bridge (bars 14-21)
  [53, F5], [54, F5], [54.5, D5], [55, D5],
  [56, F5], [56.5, G5], [58, F5], [58.5, G5], [59.5, A5],
  [62, G5], [63, G5], [63.5, F5],
  [64, F5], [65, F5], [65.5, F5], [66, G5], [66.5, A5], [67, G5], [67.5, F5],
  [68, A5], [68.5, A5], [70, G5], [70.25, A5], [70.5, G5], [71, F5], [71.5, C5],
  [72, D5], [74, G5], [74.25, A5], [74.5, G5], [75, F5], [75.5, C5],
  [76, D5], [78, G5], [78.25, A5], [78.5, G5], [79, F5], [79.5, C5],
  [80, D5],
  // chorus x2 (bars 22-29)
  [84, C5], [85, D5], [86, F5], [87, G5], [87.5, D5],
  [88, C5], [88.5, D5],
  [92, A5], [93, G5], [94, A5], [94.5, G5], [95, F5], [95.5, C5],
  [96, D5],
  [100, C5], [101, D5], [102, F5], [103, G5], [103.5, D5],
  [104, C5], [104.5, D5],
  [108, A5], [109, G5], [110, A5], [110.5, G5], [111, F5], [111.5, C5],
  [112, D5],
  // ending (bars 30-33)
  [116, D5], [118, F5],
  [120, G5], [122, A5],
  [124, QN_D6],
];
const qiannianNotes: Note[] = QN_MELODY.map(([beat, midi]) => ({ beat, midi }));
// Sparse broken-chord accompaniment, one chord per bar at beats 0, 2, 3, kept
// below the melody (the comb has no low D or B-flat, so Dm is voiced A-F).
const QN_F = [F4, A3, C4], QN_DM = [A3, F4, A3], QN_C = [C4, G4, E4], QN_AM = [A3, E4, C4];
const QN_BARS = [
  QN_F, QN_DM, QN_DM, QN_C, QN_F, QN_AM, QN_DM, QN_DM, // verse
  QN_F, QN_C, QN_DM, QN_C, QN_DM, // pre-chorus
  QN_DM, QN_F, QN_C, QN_F, QN_F, QN_DM, QN_DM, QN_DM, // bridge
  QN_F, QN_DM, QN_C, QN_DM, QN_F, QN_DM, QN_C, QN_DM, // chorus x2
  QN_DM, QN_C, QN_DM, QN_DM, // ending
];
QN_BARS.forEach((chord, bar) => {
  [0, 2, 3].forEach((off, k) => qiannianNotes.push({ beat: bar * 4 + off, midi: chord[k]! }));
});

export const SONGS: readonly Song[] = [
  { id: "fur-elise", title: "给爱丽丝", bpm: 100, beatsPerRevolution: 27, notes: eliseNotes },
  { id: "canon", title: "卡农", bpm: 140, beatsPerRevolution: 48, notes: canonNotes },
  { id: "twinkle", title: "小星星", bpm: 126, beatsPerRevolution: 48, notes: twinkleNotes },
  { id: "qiannian", title: "千年等一回", bpm: 108, beatsPerRevolution: 132, notes: qiannianNotes },
];
