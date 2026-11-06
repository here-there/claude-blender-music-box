// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { attachInput, type InputDeps } from "../../src/interaction/input";
import { partId } from "../../src/parts";
import { cameraMatrices, DEFAULT_ORBIT, clampOrbit, type OrbitState } from "../../src/render/camera";
import { projectToCss } from "../../src/interaction/winding";
import type { Vec3 } from "../../src/meta";

const RECT = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} };
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(hit: number, key: { pivot: Vec3; axis: Vec3 } = { pivot: [0.02, 0.05, -0.02], axis: [0, 1, 0] }) {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => RECT as DOMRect;
  canvas.setPointerCapture = () => {};
  canvas.hasPointerCapture = () => false;
  canvas.releasePointerCapture = () => {};
  let orbit: OrbitState = clampOrbit(DEFAULT_ORBIT);
  const state = { tension: 0.5, lidOpen: false };
  const deps: InputDeps = {
    renderer: { pick: vi.fn(async () => hit), setPins() {}, render() {}, dispose() {} },
    mechanism: {
      get state() { return state; },
      wind: vi.fn((d: number) => { state.tension = Math.min(1, state.tension + d / (2 * Math.PI) * 0.1); }),
      setLid: vi.fn((o: boolean) => { state.lidOpen = o; }),
    } as unknown as InputDeps["mechanism"],
    audio: { resume: vi.fn(async () => {}), click: vi.fn(), running: true, play() {}, cancelAll() {} },
    ui: { showLabel: vi.fn(), hideLabel: vi.fn(), setTension() {}, hideHint() {} },
    getOrbit: () => orbit,
    setOrbit: (o) => { orbit = o; },
    targetSize: () => [1600, 1200],
    key,
  };
  attachInput(canvas, deps);
  const fire = (type: string, x: number, y: number) =>
    canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as unknown as Event);
  const ptr = (type: string, x: number, y: number, detail = 0) => {
    const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, detail });
    Object.defineProperty(e, "pointerId", { value: 1 });
    Object.defineProperty(e, "pointerType", { value: "mouse" });
    canvas.dispatchEvent(e);
  };
  return { canvas, deps, state, ptr, fire, orbit: () => orbit };
}

function keyCenter(key: { pivot: Vec3 }): [number, number] {
  const cam = cameraMatrices(DEFAULT_ORBIT, 800 / 600);
  return projectToCss(cam.viewProjection, key.pivot, RECT)!;
}

async function circle(t: ReturnType<typeof setup>, c: [number, number], dir: 1 | -1, turns = 1) {
  const r = 50;
  t.ptr("pointerdown", c[0] + r, c[1]);
  await flush();
  const n = 72 * turns;
  for (let i = 1; i <= n; i++) {
    const a = (dir * i * 2 * Math.PI) / 72;
    t.ptr("pointermove", c[0] + r * Math.cos(a), c[1] + r * Math.sin(a));
  }
  t.ptr("pointerup", c[0] + r, c[1]);
}

describe("attachInput", () => {
  it("resumes audio and picks the target pixel on pointerdown", async () => {
    const t = setup(0);
    t.ptr("pointerdown", 400, 300);
    await flush();
    expect(t.deps.audio.resume).toHaveBeenCalled();
    expect(t.deps.renderer.pick).toHaveBeenCalledWith(800, 600);
  });

  it("winds when circling the key with the key (axis toward the camera: counter-clockwise on screen)", async () => {
    const t = setup(partId("key"));
    const c = keyCenter(t.deps.key);
    await circle(t, c, -1);
    const wound = (t.deps.mechanism.wind as ReturnType<typeof vi.fn>).mock.calls.reduce((s, [d]) => s + d, 0);
    expect(wound).toBeCloseTo(2 * Math.PI, 5);
    expect(t.deps.audio.click).toHaveBeenCalledTimes(12); // every π/6
    expect(t.orbit()).toEqual(clampOrbit(DEFAULT_ORBIT)); // camera untouched
  });

  it("the ratchet ignores the reverse direction", async () => {
    const t = setup(partId("key"));
    await circle(t, keyCenter(t.deps.key), 1);
    expect(t.deps.mechanism.wind).not.toHaveBeenCalled();
    expect(t.deps.audio.click).not.toHaveBeenCalled();
  });

  it("flips the winding direction when the key axis points away from the camera", async () => {
    const t = setup(partId("key"), { pivot: [0.02, 0.05, -0.02], axis: [0, -1, 0] });
    await circle(t, keyCenter(t.deps.key), 1);
    expect(t.deps.mechanism.wind).toHaveBeenCalled();
  });

  it("stops winding (and clicking) at full tension", async () => {
    const t = setup(partId("key"));
    t.state.tension = 1;
    await circle(t, keyCenter(t.deps.key), -1);
    expect(t.deps.mechanism.wind).not.toHaveBeenCalled();
    expect(t.deps.audio.click).not.toHaveBeenCalled();
  });

  it("a click on the lid toggles it; a drag on the lid orbits instead", async () => {
    const t = setup(partId("lid"));
    t.ptr("pointerdown", 400, 300);
    await flush();
    t.ptr("pointermove", 402, 301);
    t.ptr("pointerup", 402, 301);
    expect(t.deps.mechanism.setLid).toHaveBeenCalledWith(true);
    t.ptr("pointerdown", 400, 300);
    await flush();
    t.ptr("pointermove", 440, 300);
    t.ptr("pointerup", 440, 300);
    expect(t.deps.mechanism.setLid).toHaveBeenCalledTimes(1);
    expect(t.orbit().yaw).toBeCloseTo(DEFAULT_ORBIT.yaw - (2 + 40) * 0.005, 9); // the 2 px click jitter orbits too
  });

  it("a click released before the pick resolves still toggles the lid", async () => {
    const t = setup(partId("lid"));
    t.ptr("pointerdown", 400, 300);
    t.ptr("pointerup", 400, 300);
    await flush();
    expect(t.deps.mechanism.setLid).toHaveBeenCalledWith(true);
  });

  it("a double-click on the lid toggles once and does not reset the camera", async () => {
    const t = setup(partId("lid"));
    t.ptr("pointerdown", 400, 300, 1);
    await flush();
    t.ptr("pointerup", 400, 300, 1);
    t.ptr("pointerdown", 400, 300, 2);
    await flush();
    t.ptr("pointerup", 400, 300, 2);
    expect(t.deps.mechanism.setLid).toHaveBeenCalledTimes(1);
    t.deps.setOrbit({ ...t.orbit(), yaw: 1 });
    t.fire("dblclick", 400, 300);
    expect(t.orbit().yaw).toBe(1);
  });

  it("double-click away from the lid still resets the camera", async () => {
    const t = setup(0);
    t.ptr("pointerdown", 400, 300, 1); await flush(); t.ptr("pointerup", 400, 300, 1);
    t.ptr("pointerdown", 400, 300, 2); await flush(); t.ptr("pointerup", 400, 300, 2);
    t.deps.setOrbit({ ...t.orbit(), yaw: 1 });
    t.fire("dblclick", 400, 300);
    expect(t.orbit()).toEqual(clampOrbit(DEFAULT_ORBIT));
  });

  it("drags elsewhere orbit 0.005 rad per pixel, clamped", async () => {
    const t = setup(0);
    t.ptr("pointerdown", 400, 300);
    await flush();
    t.ptr("pointermove", 380, 320);
    expect(t.orbit().yaw).toBeCloseTo(DEFAULT_ORBIT.yaw + 0.1, 9);
    expect(t.orbit().pitch).toBeCloseTo(DEFAULT_ORBIT.pitch + 0.1, 9);
    t.ptr("pointermove", 380, 2000);
    expect(t.orbit().pitch).toBe(1.45);
    t.ptr("pointerup", 380, 2000);
  });

  it("wheel zooms by 1.1^(deltaY/100); double-click resets", async () => {
    const t = setup(0);
    t.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
    expect(t.orbit().distance).toBeCloseTo(DEFAULT_ORBIT.distance * 1.1, 9);
    t.fire("dblclick", 0, 0);
    expect(t.orbit()).toEqual(clampOrbit(DEFAULT_ORBIT));
  });

  it("hover shows the picked part's label", async () => {
    vi.useFakeTimers();
    const t = setup(partId("cylinder"));
    t.ptr("pointermove", 100, 120);
    await vi.advanceTimersByTimeAsync(60);
    expect(t.deps.ui.showLabel).toHaveBeenCalledWith(expect.objectContaining({ title: "滚筒" }), 100, 120);
    vi.useRealTimers();
  });
});

describe("attachInput winding dead zone", () => {
  it("pressing on the key centre and dragging out does not wind by the jump", async () => {
    const t = setup(partId("key"));
    const c = keyCenter(t.deps.key);
    t.ptr("pointerdown", c[0], c[1]);
    await flush();
    t.ptr("pointermove", c[0] + 2, c[1] + 1); // jitter inside the dead zone
    t.ptr("pointermove", c[0], c[1] - 60);    // jump out: seats the reference only
    expect(t.deps.mechanism.wind).not.toHaveBeenCalled();
    t.ptr("pointermove", c[0] - 60, c[1]);    // a quarter turn counter-clockwise on screen
    const calls = (t.deps.mechanism.wind as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBeCloseTo(Math.PI / 2, 6);
  });
});
