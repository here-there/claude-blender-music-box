/**
 * Temporary on-screen diagnostics, enabled with `?debug=1` (for devices without dev tools, e.g. iPhone).
 * Shows pointer events, GPU pick results / errors and uncaptured WebGPU errors.
 */
export interface DebugOverlay {
  log(message: string): void;
}

export function createDebugOverlay(search = location.search): DebugOverlay | null {
  if (new URLSearchParams(search).get("debug") !== "1") return null;
  const box = document.createElement("pre");
  box.className = "debug-overlay";
  Object.assign(box.style, {
    position: "fixed", left: "8px", right: "8px", bottom: "8px", maxHeight: "40vh", overflow: "auto",
    margin: "0", padding: "8px", font: "11px/1.4 ui-monospace, monospace", color: "#e8f5e9",
    background: "rgba(0,0,0,.75)", borderRadius: "6px", zIndex: "1000", pointerEvents: "none", whiteSpace: "pre-wrap",
  });
  document.body.append(box);
  const lines: string[] = [];
  const t0 = performance.now();
  const log = (message: string): void => {
    lines.push(`${((performance.now() - t0) / 1000).toFixed(2)} ${message}`);
    if (lines.length > 30) lines.shift();
    box.textContent = lines.join("\n");
  };
  log(navigator.userAgent);
  return { log };
}
