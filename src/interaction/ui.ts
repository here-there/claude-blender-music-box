import type { Song } from "../songs/types";
import type { PartLabel } from "./labels";

export interface Ui {
  showLabel(label: PartLabel, x: number, y: number): void;
  hideLabel(): void;
  /** 0..1 spring tension. */
  setTension(t: number): void;
  /** Fades out the first-run gesture hint (called once the user has wound or opened the lid). */
  hideHint(): void;
}

const CSS = `
.mb-ui { position: fixed; inset: 0; pointer-events: none; font: 13px/1.45 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #e8dccb; }
.mb-song { pointer-events: auto; position: absolute; top: 16px; right: 16px; appearance: none; -webkit-appearance: none;
  font: inherit; color: #e8dccb; background: rgba(26, 22, 20, 0.55) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23c9a35a' stroke-width='1.4'/%3E%3C/svg%3E") no-repeat right 10px center;
  border: 1px solid rgba(232, 220, 203, 0.18); border-radius: 6px; padding: 5px 28px 5px 10px; cursor: pointer; outline: none;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: border-color 0.2s; }
.mb-song:hover, .mb-song:focus-visible { border-color: rgba(201, 163, 90, 0.6); }
.mb-song option { color: #e8dccb; background: #1a1614; }
.mb-tension { position: absolute; left: 16px; bottom: 16px; width: 160px; height: 2px; border-radius: 1px; background: rgba(232, 220, 203, 0.12); overflow: hidden; }
.mb-tension > div { height: 100%; width: 0; background: linear-gradient(90deg, #8a6a32, #d8b56a); transition: width 0.12s linear; }
.mb-hint { position: absolute; left: 16px; bottom: 26px; font-size: 12px; color: rgba(232, 220, 203, 0.5); transition: opacity 0.8s; }
.mb-hint.mb-gone { opacity: 0; }
.mb-label { position: absolute; left: 0; top: 0; max-width: 220px; padding: 7px 10px; border-radius: 6px;
  background: rgba(26, 22, 20, 0.78); border: 1px solid rgba(201, 163, 90, 0.28);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); opacity: 0; transition: opacity 0.12s; will-change: transform; }
.mb-label.mb-on { opacity: 1; }
.mb-label b { display: block; font-weight: 600; color: #d8b56a; margin-bottom: 1px; }
.mb-label span { color: rgba(232, 220, 203, 0.85); font-size: 12px; }
`;

export function createUi(root: HTMLElement, songs: readonly Song[], onSong: (id: string) => void): Ui {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "mb-ui";

  const select = document.createElement("select");
  select.className = "mb-song";
  select.setAttribute("aria-label", "选择曲目");
  for (const s of songs) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.title;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    onSong(select.value);
    select.blur();
  });

  const bar = document.createElement("div");
  bar.className = "mb-tension";
  bar.title = "发条张力";
  const fill = document.createElement("div");
  bar.appendChild(fill);

  const hint = document.createElement("div");
  hint.className = "mb-hint";
  hint.textContent = "点盒盖开合 · 转到盒底拖动钥匙上弦";

  const label = document.createElement("div");
  label.className = "mb-label";
  label.setAttribute("role", "tooltip");
  const title = document.createElement("b");
  const body = document.createElement("span");
  label.append(title, body);

  layer.append(select, bar, hint, label);
  root.appendChild(layer);

  let shownTension = -1;
  return {
    showLabel(l, x, y) {
      title.textContent = l.title;
      body.textContent = l.body;
      label.classList.add("mb-on");
      const w = label.offsetWidth, h = label.offsetHeight;
      const left = x + 14 + w > innerWidth - 8 ? x - 14 - w : x + 14;
      const top = Math.min(innerHeight - 8 - h, Math.max(8, y + 14));
      label.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
    },
    hideLabel() {
      label.classList.remove("mb-on");
    },
    setTension(t) {
      const v = Math.round(Math.min(1, Math.max(0, t)) * 1000) / 10;
      if (v === shownTension) return;
      shownTension = v;
      fill.style.width = `${v}%`;
    },
    hideHint() {
      hint.classList.add("mb-gone");
    },
  };
}
