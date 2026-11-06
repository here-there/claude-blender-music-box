import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { init, target } from "vgpu/mock";
import { parseGlb } from "../../src/gltf/glb";
import { uploadModel } from "../../src/gltf/upload";
import { validateMeta } from "../../src/meta";
import { createRenderer, easeLid, type RenderState } from "../../src/render/renderer";
import { createEnvironment } from "../../src/render/environment";
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

/** Records every render pipeline descriptor the device is asked to build. */
function recordPipelines(gpu: { gpu: GPUDevice }): GPURenderPipelineDescriptor[] {
  const seen: GPURenderPipelineDescriptor[] = [];
  const dev = gpu.gpu as GPUDevice & Record<string, unknown>;
  const sync = dev.createRenderPipeline.bind(dev);
  const async_ = dev.createRenderPipelineAsync.bind(dev);
  dev.createRenderPipeline = (d: GPURenderPipelineDescriptor) => { seen.push(d); return sync(d); };
  dev.createRenderPipelineAsync = (d: GPURenderPipelineDescriptor) => { seen.push(d); return async_(d); };
  return seen;
}

describe("environment (vgpu/mock)", () => {
  it("creates an irradiance cube and a 5-level prefiltered specular cube", async () => {
    const gpu = await init();
    const env = createEnvironment(gpu);
    expect(env.irradiance.size).toEqual([64, 64]);
    expect(env.irradiance.layers).toBe(6);
    expect(env.specular.size).toEqual([128, 128]);
    expect(env.specular.layers).toBe(6);
    expect(env.specular.mipLevelCount).toBe(5);
    gpu.dispose();
  });
});

describe("renderer shadows + glass (vgpu/mock)", () => {
  it("renders a frame with a depth32float shadow pass for every opaque kind and a blended glass draw", async () => {
    const gpu = await init();
    const pipelines = recordPipelines(gpu);
    const parts = await uploadModel(gpu, parseGlb(glb()), { decodeImage: async () => null });
    expect([...parts.values()].some((p) => p.primitives.some((q) => q.blend))).toBe(true);
    const r = await createRenderer(gpu, target(gpu, { size: [320, 180] }), parts, meta);
    const song = SONGS[0]!;
    r.setPins(pinInstances(meta, song, arrange(song)));
    expect(() => r.render(state({ time: 0.5, cylinderAngle: -0.4, lidOpen01: 1 }))).not.toThrow();
    // shadow casters: static parts, teeth and pins each get a depth-only pipeline into the depth32float map
    const shadow = pipelines.filter((d) => d.depthStencil?.format === "depth32float");
    const shadowEntries = new Set(shadow.map((d) => d.vertex.entryPoint));
    expect(shadow.length).toBeGreaterThanOrEqual(3);
    expect(shadowEntries.size).toBeGreaterThanOrEqual(1);
    const shadowModules = new Set(shadow.map((d) => d.vertex.module));
    expect(shadowModules.size).toBe(3);
    // glass: blended, depth-tested but not depth-writing, into the HDR scene target
    const glass = pipelines.filter((d) => d.fragment?.targets.some((t) => t?.blend) && d.depthStencil?.depthWriteEnabled === false);
    expect(glass.length).toBeGreaterThanOrEqual(1);
    expect(() => r.render(state({ time: 0.6, cylinderAngle: -0.5, lidOpen01: 1 }))).not.toThrow();
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
