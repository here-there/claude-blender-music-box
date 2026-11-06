export const PART_NAMES = [
  "case", "lid", "glass", "bedplate", "comb_base", "cylinder", "cylinder_bracket",
  "spring_barrel", "spring_coil", "gear_train", "governor", "key", "felt",
] as const;
export type PartName = (typeof PART_NAMES)[number];

export const PIN_ID = 200;
export const partId = (name: PartName): number => PART_NAMES.indexOf(name) + 1;
export const toothId = (i: number): number => 100 + i;

export type DecodedId =
  | { kind: "part"; name: PartName }
  | { kind: "tooth"; index: number }
  | { kind: "pin" };

export function decodeId(id: number): DecodedId | null {
  if (id >= 1 && id <= PART_NAMES.length) return { kind: "part", name: PART_NAMES[id - 1]! };
  if (id >= 100 && id < PIN_ID) return { kind: "tooth", index: id - 100 };
  if (id === PIN_ID) return { kind: "pin" };
  return null;
}
