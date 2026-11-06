import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseGlb } from "../../src/gltf/glb";
import { PART_NAMES, decodeId, toothId, partId, PIN_ID } from "../../src/parts";

function load(): ArrayBuffer {
  const b = readFileSync("public/musicbox.glb");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
const parts = parseGlb(load());

describe("parseGlb", () => {
  it("contains every PART_NAME", () => {
    for (const n of PART_NAMES) expect(parts.has(n), n).toBe(true);
  });
  it("has valid per-primitive meshes", () => {
    for (const p of parts.values()) {
      expect(p.primitives.length).toBeGreaterThan(0);
      expect(p.matrix.length).toBe(16);
      for (const { mesh: m } of p.primitives) {
        const n = m.positions.length / 3;
        expect(m.positions.length % 3).toBe(0);
        expect(m.normals.length).toBe(m.positions.length);
        expect(m.uvs.length / 2).toBe(n);
        expect(m.tangents.length / 4).toBe(n);
        let max = 0;
        for (const i of m.indices) max = Math.max(max, i);
        expect(max).toBeLessThan(n);
        expect(m.indices.length % 3).toBe(0);
      }
    }
  });
  it("reads extras", () => {
    expect(parts.get("cylinder")!.extras.ratio).toBe(1);
    // ratios follow the modelled tooth counts: barrel 72 -> pinion 12, wheel 48 -> train 16, train wheel 48 -> worm
    expect(parts.get("spring_barrel")!.extras.ratio).toBeCloseTo(-12 / 72, 9);
    expect(parts.get("gear_train")!.extras.ratio).toBe(-3);
    expect(parts.get("governor")!.extras.ratio).toBe(144);
  });
  it("glass is blended", () => {
    expect(parts.get("glass")!.primitives[0]!.material.alphaMode).toBe("BLEND");
  });
  it("rejects bad magic", () => {
    expect(() => parseGlb(new ArrayBuffer(32))).toThrow(/glTF/);
  });
});

describe("part ids", () => {
  it("decodes", () => {
    expect(decodeId(toothId(5))).toEqual({ kind: "tooth", index: 5 });
    expect(decodeId(0)).toBeNull();
    expect(decodeId(PIN_ID)).toEqual({ kind: "pin" });
    expect(decodeId(partId("lid"))).toEqual({ kind: "part", name: "lid" });
    expect(decodeId(14)).toBeNull();
  });
});
