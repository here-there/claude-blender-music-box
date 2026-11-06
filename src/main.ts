import { init, surface } from "vgpu";
import { hasWebGpu, showFatal } from "./app/errors";
import { createDebugOverlay } from "./app/debugOverlay";
import { pinInstances } from "./geometry/pins";
import { parseGlb } from "./gltf/glb";
import { uploadModel } from "./gltf/upload";
import { loadMeta, type Vec3 } from "./meta";
import { Mechanism, phaseAt, WIND_PER_KEY_TURN, type PluckEvent } from "./mechanism/mechanism";
import { attachInput } from "./interaction/input";
import { createUi } from "./interaction/ui";
import { clampOrbit, dampOrbit, DEFAULT_ORBIT, type OrbitState } from "./render/camera";
import { createRenderer, easeLid, type RenderState } from "./render/renderer";
import { PUSH_SECONDS } from "./render/vibration";
import { createMusicBoxAudio, type MusicBoxAudio } from "./audio/engine";
import { arrange } from "./songs/arrange";
import { COMB_PITCHES } from "./songs/comb";
import { SONGS } from "./songs/library";

/** Mechanism runs this far ahead of the frame clock so audio (Task 9) can schedule plucks precisely. */
const LOOKAHEAD = 0.05;
/** Spring tension at page load (the lid starts closed: opening it plays). */
const INITIAL_TENSION = 0.5;

/** Debug: `?slow=0.25` runs the mechanism and animation clock at 0.25× speed. */
function timeScale(): number {
  const v = Number(new URLSearchParams(location.search).get("slow"));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
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
  let deviceLost = false;
  try {
    const gpu = await init();
    let audio: MusicBoxAudio | null = null;
    void gpu.lost.then((info) => {
      deviceLost = true;
      audio?.cancelAll();
      showFatal("device-lost", info.message || undefined);
    });
    const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
    const stage = surface(gpu, canvas, { dpr: [1, 2] });
    const [glb, meta] = await Promise.all([loadGlb(`${BASE}musicbox.glb`), loadMeta(`${BASE}musicbox.meta.json`)]);
    const parts = await uploadModel(gpu, parseGlb(glb));
    const renderer = await createRenderer(gpu, stage, parts, meta);
    const debug = createDebugOverlay();
    if (debug) {
      debug.log(`canvas css ${canvas.clientWidth}x${canvas.clientHeight} target ${stage.size.join("x")} dpr ${devicePixelRatio}`);
      gpu.device.gpu.addEventListener("uncapturederror", (e) => debug.log(`GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`));
      for (const type of ["pointerdown", "pointerup", "pointercancel", "click"] as const) {
        canvas.addEventListener(type, (e) => {
          const p = e as PointerEvent;
          debug.log(`${type} ${p.pointerType ?? ""} btn=${p.button} detail=${p.detail} @${Math.round(p.clientX)},${Math.round(p.clientY)}`);
        });
      }
      const pick = renderer.pick.bind(renderer);
      renderer.pick = (px, py) => pick(px, py).then(
        (id) => { debug.log(`pick(${px},${py}) -> ${id}`); return id; },
        (err) => { debug.log(`pick(${px},${py}) threw: ${err instanceof Error ? err.message : String(err)}`); throw err; },
      );
    }

    const song = SONGS[0]!;
    const arranged = arrange(song);
    const mechanism = new Mechanism(song, arranged);
    renderer.setPins(pinInstances(meta, song, arranged));
    mechanism.wind((INITIAL_TENSION / WIND_PER_KEY_TURN) * 2 * Math.PI);

    const orbitGoal: OrbitState = clampOrbit(DEFAULT_ORBIT);
    const state: RenderState = {
      time: 0, cylinderAngle: 0, keyAngle: 0, lidOpen01: 0,
      orbit: clampOrbit(DEFAULT_ORBIT),
      plucks: new Float32Array(36),
    };
    // Plucks are produced LOOKAHEAD early; a tooth's slot is overwritten only when its push-up phase starts,
    // so a still-ringing tooth is not cut short before the next pin reaches it.
    const pending: PluckEvent[] = [];
    const scale = timeScale();
    const audioEngine = createMusicBoxAudio();
    audio = audioEngine;
    if (deviceLost) audioEngine.cancelAll();

    const ui = createUi(document.body, SONGS, (id) => {
      const next = SONGS.find((s) => s.id === id);
      if (!next) return;
      audio.cancelAll();
      const pins = arrange(next);
      mechanism.setSong(next, pins);
      renderer.setPins(pinInstances(meta, next, pins));
      // Old vibrations stop with the old song.
      pending.length = 0;
      state.plucks.fill(0);
    });
    attachInput(canvas, {
      renderer, mechanism, audio, ui,
      getOrbit: () => orbitGoal,
      setOrbit: (o) => {
        orbitGoal.yaw = o.yaw; orbitGoal.pitch = o.pitch; orbitGoal.distance = o.distance;
        orbitGoal.target[0] = o.target[0]; orbitGoal.target[1] = o.target[1]; orbitGoal.target[2] = o.target[2];
      },
      getRenderedOrbit: () => state.orbit,
      targetSize: () => stage.size,
      key: keyRig(parts.get("key")),
    });

    const t0 = performance.now();
    let lastMs = t0;
    let rendered = false;
    const tick = (nowMs: number): void => {
      if (deviceLost) return;
      const now = ((nowMs - t0) / 1000) * scale;
      dampOrbit(state.orbit, orbitGoal, Math.min(0.1, (nowMs - lastMs) / 1000));
      lastMs = nowMs;
      const events = mechanism.update(now + LOOKAHEAD);
      pending.push(...events);
      // Audio stays in wall time (mechanism clock = wall * scale).
      for (const ev of events) audio.play(COMB_PITCHES[ev.tooth]!, ev.velocity, ev.time / scale, now / scale);
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
      ui.setTension(ms.tension);
      state.time = now;
      state.cylinderAngle = -2 * Math.PI * phaseAt(ms, now); // Ruling R6
      state.keyAngle = ms.keyAngle;
      state.lidOpen01 = easeLid(ms.lidT);
      try {
        renderer.render(state);
      } catch (err) {
        if (!deviceLost) { document.querySelector(".loading")?.remove(); showFatal("load", err instanceof Error ? err.message : String(err)); }
        return;
      }
      if (!rendered) {
        rendered = true;
        document.querySelector(".loading")?.remove();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (deviceLost) return; // keep the device-lost panel
    document.querySelector(".loading")?.remove();
    const code = (err as { code?: unknown } | null)?.code;
    showFatal(code === "VGPU-RING1-UNSUPPORTED" ? "no-webgpu" : "load", detail);
  }
}

/** Key pivot (node translation) and spin axis in world space, from the glTF node and its extras.axis. */
function keyRig(part: { matrix: Float32Array; extras: Record<string, unknown> } | undefined): { pivot: Vec3; axis: Vec3 } {
  if (!part) return { pivot: [0, 0, 0], axis: [0, 1, 0] };
  const m = part.matrix;
  const a = Array.isArray(part.extras.axis) ? (part.extras.axis as number[]) : [0, 1, 0];
  const [x, y, z] = [a[0] ?? 0, a[1] ?? 1, a[2] ?? 0];
  return {
    pivot: [m[12]!, m[13]!, m[14]!],
    axis: [m[0]! * x + m[4]! * y + m[8]! * z, m[1]! * x + m[5]! * y + m[9]! * z, m[2]! * x + m[6]! * y + m[10]! * z],
  };
}

void main();
