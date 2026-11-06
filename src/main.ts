import { init, surface } from "vgpu";
import { hasWebGpu, showFatal } from "./app/errors";
import { pinInstances } from "./geometry/pins";
import { parseGlb } from "./gltf/glb";
import { uploadModel } from "./gltf/upload";
import { loadMeta } from "./meta";
import { Mechanism, phaseAt, type PluckEvent } from "./mechanism/mechanism";
import { DEFAULT_ORBIT } from "./render/camera";
import { createRenderer, easeLid, type RenderState } from "./render/renderer";
import { PUSH_SECONDS } from "./render/vibration";
import { arrange } from "./songs/arrange";
import { SONGS } from "./songs/library";

/** Mechanism runs this far ahead of the frame clock so audio (Task 9) can schedule plucks precisely. */
const LOOKAHEAD = 0.05;
/** Temporary until Task 11's key interaction: full wind = 10 key turns (WIND_PER_KEY_TURN = 0.1). */
const FULL_WIND_RADIANS = 2 * Math.PI * 10;

/** Debug: `?slow=0.25` runs the mechanism and animation clock at 0.25× speed. */
function timeScale(): number {
  const v = Number(new URLSearchParams(location.search).get("slow"));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

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

    const song = SONGS[0]!;
    const arranged = arrange(song);
    const mechanism = new Mechanism(song, arranged);
    renderer.setPins(pinInstances(meta, song, arranged));
    // Temporary (Task 11 replaces with interaction): start fully wound with the lid opening.
    mechanism.wind(FULL_WIND_RADIANS);
    mechanism.setLid(true);

    const state: RenderState = {
      time: 0, cylinderAngle: 0, keyAngle: 0, lidOpen01: 0,
      orbit: { ...DEFAULT_ORBIT, target: [...DEFAULT_ORBIT.target] },
      plucks: new Float32Array(36),
    };
    // Plucks are produced LOOKAHEAD early; a tooth's slot is overwritten only when its push-up phase starts,
    // so a still-ringing tooth is not cut short before the next pin reaches it.
    const pending: PluckEvent[] = [];
    const scale = timeScale();
    const t0 = performance.now();
    const tick = (nowMs: number): void => {
      const now = ((nowMs - t0) / 1000) * scale;
      const events = mechanism.update(now + LOOKAHEAD);
      pending.push(...events); // Task 9: hand the same events to the audio engine
      for (let i = pending.length - 1; i >= 0; i--) {
        const ev = pending[i]!;
        if (now < ev.time - PUSH_SECONDS) continue;
        // keep the latest pluck if several land on the same tooth
        if (ev.time >= state.plucks[ev.tooth * 2]! || state.plucks[ev.tooth * 2 + 1] === 0) {
          state.plucks[ev.tooth * 2] = ev.time;
          state.plucks[ev.tooth * 2 + 1] = ev.velocity;
        }
        pending.splice(i, 1);
      }
      const ms = mechanism.state;
      if (ms.tension === 0 && ms.omega === 0 && ms.lidT >= 1) mechanism.wind(FULL_WIND_RADIANS); // temporary: keep playing
      state.time = now;
      state.cylinderAngle = -2 * Math.PI * phaseAt(ms, now); // Ruling R6
      state.keyAngle = ms.keyAngle;
      state.lidOpen01 = easeLid(ms.lidT);
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
