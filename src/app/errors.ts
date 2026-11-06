export type FatalKind = "no-webgpu" | "load" | "device-lost";

export function hasWebGpu(nav: Navigator): boolean {
  return "gpu" in nav && !!(nav as Navigator & { gpu?: unknown }).gpu;
}

const TITLES: Record<FatalKind, string> = {
  "no-webgpu": "此浏览器不支持 WebGPU",
  load: "加载失败",
  "device-lost": "显卡连接已丢失",
};

const HINTS: Record<FatalKind, string> = {
  "no-webgpu": "八音盒需要 WebGPU。请使用最新版 Chrome、Edge 或 Safari 打开。",
  load: "初始化图形设备或资源时出错。",
  "device-lost": "图形设备已断开，请重新加载页面。",
};

export function showFatal(kind: FatalKind, detail?: string): void {
  document.querySelector(".fatal")?.remove();
  const panel = document.createElement("div");
  panel.className = "fatal";

  const h = document.createElement("h1");
  h.textContent = TITLES[kind];
  const p = document.createElement("p");
  p.textContent = HINTS[kind];
  panel.append(h, p);

  if (detail) {
    const d = document.createElement("pre");
    d.className = "fatal-detail";
    d.textContent = detail;
    panel.append(d);
  }
  if (kind === "device-lost") {
    const btn = document.createElement("button");
    btn.className = "fatal-reload";
    btn.type = "button";
    btn.textContent = "重新加载";
    btn.addEventListener("click", () => location.reload());
    panel.append(btn);
  }
  document.body.append(panel);
}
