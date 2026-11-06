import { effect, frameLoop, init, surface } from "vgpu";
import { hasWebGpu, showFatal } from "./app/errors";
import clearShader from "./render/shaders/clear.wgsl";

async function main(): Promise<void> {
  if (!hasWebGpu(navigator)) {
    showFatal("no-webgpu");
    return;
  }
  try {
    const gpu = await init();
    const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
    const stage = surface(gpu, canvas, { dpr: [1, 2] });
    const clear = effect(gpu, clearShader);
    frameLoop(gpu, (frame) => {
      frame.pass(stage, clear);
    });
  } catch (err) {
    showFatal("load", err instanceof Error ? err.message : String(err));
  }
}

void main();
