import { init, surface } from "vgpu";
import { hasWebGpu, showFatal } from "./app/errors";
import { parseGlb } from "./gltf/glb";
import { uploadModel } from "./gltf/upload";
import { loadMeta } from "./meta";
import { DEFAULT_ORBIT } from "./render/camera";
import { createRenderer, easeLid, type RenderState } from "./render/renderer";

const BASE = import.meta.env.BASE_URL;

async function loadGlb(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url} (${res.status})`);
  return res.arrayBuffer();
}

async function main(): Promise<void> {
  if (!hasWebGpu(navigator)) {
    showFatal("no-webgpu");
    return;
  }
  try {
    const gpu = await init();
    const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
    const stage = surface(gpu, canvas, { dpr: [1, 2] });
    const [glb, meta] = await Promise.all([loadGlb(`${BASE}musicbox.glb`), loadMeta(`${BASE}musicbox.meta.json`)]);
    const parts = await uploadModel(gpu, parseGlb(glb));
    const renderer = await createRenderer(gpu, stage, parts, meta);

    // Static scene for now: lid open, mechanism at rest (the mechanism timeline drives these later).
    const state: RenderState = {
      time: 0, cylinderAngle: 0, keyAngle: 0, lidOpen01: easeLid(1),
      orbit: { ...DEFAULT_ORBIT, target: [...DEFAULT_ORBIT.target] },
      plucks: new Float32Array(36),
    };
    const t0 = performance.now();
    const tick = (now: number): void => {
      state.time = (now - t0) / 1000;
      try {
        renderer.render(state);
      } catch (err) {
        showFatal("load", err instanceof Error ? err.message : String(err));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (err) {
    showFatal("load", err instanceof Error ? err.message : String(err));
  }
}

void main();
