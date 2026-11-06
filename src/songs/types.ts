export interface Note { beat: number; midi: number }
export interface Song {
  id: string;
  title: string;
  bpm: number;
  beatsPerRevolution: number;
  notes: readonly Note[];
}
/** midi = actual comb-tooth pitch (after octave shifting) */
export interface ArrangedPin { tooth: number; beat: number; midi: number }
