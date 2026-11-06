import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { init, target } from "vgpu/mock";
import { parseGlb } from "../../src/gltf/glb";
import { uploadModel } from "../../src/gltf/upload";
import { validateMeta } from "../../src/meta";
import { createRenderer, easeLid, type RenderState } from "../../src/render/renderer";
import { DEFAULT_ORBIT } from "../../src/render/camera";
import metaJson from "../../public/musicbox.meta.json";
import { pinInstances } from "../../src/geometry/pins";
import { SONGS } from "../../src/songs/library";
import { arrange } from "../../src/songs/arrange";

function glb(): ArrayBuffer {
  const b = readFileSync("public/musicbox.glb");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
const meta = validateMeta(metaJson as unknown);

function state(over: Partial<RenderState> = {}): RenderState {
  return {
    time: 0, cylinderAngle: 0, keyAngle: 0, lidOpen01: 0,
    orbit: DEFAULT_ORBIT, plucks: new Float32Array(36), ...over,
  };
}

describe("renderer smoke (vgpu/mock)", () => {
  it("renders frames of the real model without throwing", async () => {
    const gpu = await init();
    const parts = await uploadModel(gpu, parseGlb(glb()), { decodeImage: async () => null });
    const output = target(gpu, { size: [320, 180] });
    const r = await createRenderer(gpu, output, parts, meta);
    expect(() => r.render(state())).not.toThrow();
    expect(() => r.render(state({ time: 1, cylinderAngle: -1.2, keyAngle: 0.7, lidOpen01: 1 }))).not.toThrow();
    // output resize is followed by the internal HDR target
    output.resize([200, 100]);
    expect(() => r.render(state({ time: 2 }))).not.toThrow();
    r.setPins(new Float32Array(0));
    await expect(r.pick(10, 10)).resolves.toBe(0);
    r.dispose();
    gpu.dispose();
  });
});

describe("renderer pins + comb (vgpu/mock)", () => {
  it("renders instanced pins and plucked teeth after setPins", async () => {
    const gpu = await init();
    const parts = await uploadModel(gpu, parseGlb(glb()), { decodeImage: async () => null });
    const output = target(gpu, { size: [320, 180] });
    const r = await createRenderer(gpu, output, parts, meta);
    const song = SONGS[0]!;
    const pins = pinInstances(meta, song, arrange(song));
    expect(pins.length).toBeGreaterThan(0);
    r.setPins(pins);
    const plucks = new Float32Array(36);
    for (let i = 0; i < 18; i++) { plucks[i * 2] = 0.9 - i * 0.05; plucks[i * 2 + 1] = 0.5 + i / 36; }
    expect(() => r.render(state({ time: 1, cylinderAngle: -2.1, lidOpen01: 1, plucks }))).not.toThrow();
    // growing past the initial capacity and shrinking back both keep rendering
    const many = new Float32Array(4 * 5000);
    for (let i = 0; i < 5000; i++) many.set(pins.subarray((i % (pins.length / 4)) * 4, (i % (pins.length / 4)) * 4 + 4), i * 4);
    r.setPins(many);
    expect(() => r.render(state({ time: 1.1, cylinderAngle: -2.2, lidOpen01: 1, plucks }))).not.toThrow();
    r.setPins(new Float32Array(0));
    expect(() => r.render(state({ time: 1.2, lidOpen01: 1, plucks }))).not.toThrow();
    r.dispose();
    gpu.dispose();
  });

  it("rejects pin data that is not [x, angle0, tooth, 0] quadruples", async () => {
    const gpu = await init();
    const parts = await uploadModel(gpu, parseGlb(glb()), { decodeImage: async () => null });
    const r = await createRenderer(gpu, target(gpu, { size: [64, 64] }), parts, meta);
    expect(() => r.setPins(new Float32Array(6))).toThrow(RangeError);
    r.dispose();
    gpu.dispose();
  });
});

describe("easeLid", () => {
  it("is a clamped smoothstep", () => {
    expect(easeLid(-1)).toBe(0);
    expect(easeLid(0)).toBe(0);
    expect(easeLid(0.5)).toBeCloseTo(0.5);
    expect(easeLid(1)).toBe(1);
    expect(easeLid(2)).toBe(1);
    expect(easeLid(0.25)).toBeLessThan(0.25);
  });
});
