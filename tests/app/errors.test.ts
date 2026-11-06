// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { hasWebGpu, showFatal } from "../../src/app/errors";

describe("hasWebGpu", () => {
  it("detects navigator.gpu", () => {
    expect(hasWebGpu({} as Navigator)).toBe(false);
    expect(hasWebGpu({ gpu: {} } as Navigator)).toBe(true);
  });
});

describe("showFatal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a no-webgpu panel mentioning WebGPU", () => {
    showFatal("no-webgpu");
    const panel = document.querySelector(".fatal");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("WebGPU");
  });

  it("renders a reload button for device-lost", () => {
    showFatal("device-lost");
    expect(document.querySelector("button.fatal-reload")).not.toBeNull();
  });
});
