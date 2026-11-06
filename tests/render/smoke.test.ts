import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { init, target } from "vgpu/mock";
import { parseGlb } from "../../src/gltf/glb";
import { uploadModel } from "../../src/gltf/upload";
import { validateMeta } from "../../src/meta";
import { createRenderer, easeLid, type RenderState } from "../../src/render/renderer";
import { DEFAULT_ORBIT } from "../../src/render/camera";
import metaJson from "../../public/musicbox.meta.json";

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
