import type { MusicBoxAudio } from "../audio/engine";
import type { Mechanism } from "../mechanism/mechanism";
import type { Vec3 } from "../meta";
import { decodeId, partId } from "../parts";
import { cameraMatrices, clampOrbit, DEFAULT_ORBIT, type OrbitState } from "../render/camera";
import type { Renderer } from "../render/renderer";
import { labelFor } from "./labels";
import type { Ui } from "./ui";
import { cssToTargetPixel, pointerAngle, projectToCss, ratchetDelta } from "./winding";

export interface InputDeps {
  renderer: Renderer;
  mechanism: Mechanism;
  audio: MusicBoxAudio;
  ui: Ui;
  /** Goal orbit (main eases the rendered camera toward it). */
  getOrbit(): OrbitState;
  setOrbit(s: OrbitState): void;
  /** Renderer output size in physical pixels (picking coordinates). */
  targetSize(): readonly [number, number];
  /** Winding key: world pivot (node translation) and world spin axis. */
  key: { pivot: Vec3; axis: Vec3 };
}

const ORBIT_PER_PIXEL = 0.005;
const ZOOM_BASE = 1.1;
const CLICK_SLOP = 4;
const HOVER_MS = 50;
const RATCHET_STEP = Math.PI / 6;
/** Near the key's centre the pointer angle is meaningless: no winding inside this radius (CSS px). */
const WIND_DEADZONE = 12;
const KEY_ID = partId("key");
const LID_ID = partId("lid");

type Mode = "pending" | "orbit" | "lid" | "wind";
interface Drag {
  pointerId: number;
  startX: number; startY: number;
  lastX: number; lastY: number; // last position applied to the orbit
  curX: number; curY: number;
  moved: number;
  mode: Mode;
  released: boolean;
  // winding
  cx: number; cy: number; sign: number; prevAngle: number; ratchet: number;
  /** false while inside the dead zone: the next angle only seats the reference, it does not wind. */
  armed: boolean;
}

export function attachInput(canvas: HTMLCanvasElement, deps: InputDeps): () => void {
  const { renderer, mechanism, audio, ui } = deps;
  let drag: Drag | null = null;
  let hoverSeq = 0;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHover = -Infinity;
  let hoverPos: [number, number] = [0, 0];

  canvas.style.touchAction = "none";

  const pickAt = (cssX: number, cssY: number): Promise<number> => {
    const [px, py] = cssToTargetPixel(cssX, cssY, canvas.getBoundingClientRect(), deps.targetSize());
    return renderer.pick(px, py).catch(() => 0);
  };

  const updateOrbit = (f: (o: OrbitState) => void): void => {
    const g = deps.getOrbit();
    const next: OrbitState = { ...g, target: [g.target[0], g.target[1], g.target[2]] };
    f(next);
    deps.setOrbit(clampOrbit(next));
  };

  const applyOrbitDrag = (d: Drag): void => {
    const dx = d.curX - d.lastX, dy = d.curY - d.lastY;
    d.lastX = d.curX;
    d.lastY = d.curY;
    if (dx === 0 && dy === 0) return;
    updateOrbit((o) => { o.yaw -= dx * ORBIT_PER_PIXEL; o.pitch += dy * ORBIT_PER_PIXEL; });
  };

  const applyWind = (d: Drag): void => {
    if (Math.hypot(d.curX - d.cx, d.curY - d.cy) < WIND_DEADZONE) {
      d.armed = false;
      return;
    }
    const a = d.sign * pointerAngle(d.curX, d.curY, d.cx, d.cy);
    if (!d.armed) {
      d.armed = true;
      d.prevAngle = a;
      return;
    }
    const delta = ratchetDelta(d.prevAngle, a);
    d.prevAngle = a; // backward motion re-seats the pawl
    if (delta <= 0 || mechanism.state.tension >= 1) return;
    mechanism.wind(delta);
    ui.hideHint();
    d.ratchet += delta;
    while (d.ratchet >= RATCHET_STEP) {
      d.ratchet -= RATCHET_STEP;
      audio.click();
    }
  };

  const toggleLid = (): void => {
    mechanism.setLid(!mechanism.state.lidOpen);
    ui.hideHint();
  };

  /** Starts winding around the key's projected pivot; false when the pivot is behind the camera. */
  const beginWind = (d: Drag): boolean => {
    const rect = canvas.getBoundingClientRect();
    const cam = cameraMatrices(deps.getOrbit(), rect.width / Math.max(1, rect.height));
    const c = projectToCss(cam.viewProjection, deps.key.pivot, rect);
    if (!c) return false;
    const { pivot, axis } = deps.key;
    const toCam = [cam.position[0]! - pivot[0], cam.position[1]! - pivot[1], cam.position[2]! - pivot[2]];
    // Screen angles grow clockwise (y down); a right-handed spin about an axis that points at the viewer
    // looks counter-clockwise, so flip the angle then: the key turns with the pointer.
    d.sign = axis[0] * toCam[0]! + axis[1] * toCam[1]! + axis[2] * toCam[2]! > 0 ? -1 : 1;
    d.cx = c[0];
    d.cy = c[1];
    d.armed = false;
    d.ratchet = 0;
    d.mode = "wind";
    return true;
  };

  const onPointerDown = (e: PointerEvent): void => {
    void audio.resume().catch(() => undefined);
    if (e.button !== 0 || drag) return;
    canvas.setPointerCapture(e.pointerId);
    cancelHover();
    ui.hideLabel();
    const d: Drag = {
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
      curX: e.clientX, curY: e.clientY, moved: 0, mode: "pending", released: false,
      cx: 0, cy: 0, sign: 1, prevAngle: 0, ratchet: 0, armed: false,
    };
    drag = d;
    void pickAt(e.clientX, e.clientY).then((id) => {
      if (id === KEY_ID && !d.released && beginWind(d)) {
        canvas.style.cursor = "grabbing";
        applyWind(d);
        return;
      }
      d.mode = id === LID_ID ? "lid" : "orbit";
      if (d.released) {
        if (d.mode === "lid" && d.moved < CLICK_SLOP) toggleLid();
        return;
      }
      applyOrbitDrag(d); // catch up with motion made while the pick was in flight
    });
  };

  const onPointerMove = (e: PointerEvent): void => {
    const d = drag;
    if (d && e.pointerId === d.pointerId) {
      d.curX = e.clientX;
      d.curY = e.clientY;
      d.moved = Math.max(d.moved, Math.hypot(d.curX - d.startX, d.curY - d.startY));
      if (d.mode === "wind") applyWind(d);
      else if (d.mode === "orbit" || d.mode === "lid") applyOrbitDrag(d);
      return;
    }
    if (e.pointerType === "touch") return;
    hoverPos = [e.clientX, e.clientY];
    scheduleHover();
  };

  const endDrag = (e: PointerEvent): void => {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.released = true;
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (e.type === "pointerup" && d.mode === "lid" && d.moved < CLICK_SLOP) toggleLid();
    canvas.style.cursor = "";
  };

  // ---- Hover labels (throttled pick) ----
  function cancelHover(): void {
    hoverSeq++;
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  function scheduleHover(): void {
    if (hoverTimer !== null) return;
    const wait = Math.max(0, lastHover + HOVER_MS - performance.now());
    hoverTimer = setTimeout(runHover, wait);
  }
  function runHover(): void {
    hoverTimer = null;
    lastHover = performance.now();
    const seq = ++hoverSeq;
    const [x, y] = hoverPos;
    void pickAt(x, y).then((id) => {
      if (seq !== hoverSeq || drag) return;
      const label = labelFor(decodeId(id));
      if (label) ui.showLabel(label, x, y);
      else ui.hideLabel();
      canvas.style.cursor = id === KEY_ID ? "grab" : id === LID_ID ? "pointer" : "";
    });
  }
  const onLeave = (): void => {
    cancelHover();
    ui.hideLabel();
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1; // lines / pages → pixels
    updateOrbit((o) => { o.distance *= Math.pow(ZOOM_BASE, (e.deltaY * scale) / 100); });
  };

  const onDblClick = (): void => {
    deps.setOrbit(clampOrbit({ ...DEFAULT_ORBIT, target: [...DEFAULT_ORBIT.target] }));
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDblClick);
  return () => {
    cancelHover();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endDrag);
    canvas.removeEventListener("pointercancel", endDrag);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("dblclick", onDblClick);
  };
}
