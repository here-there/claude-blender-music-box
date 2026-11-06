import type { DecodedId, PartName } from "../parts";
import { COMB_PITCHES, noteName } from "../songs/comb";

export interface PartLabel { title: string; body: string }

/** Hover cards (Chinese, one-line body) for every named glTF part. */
export const PART_LABELS: Record<PartName, PartLabel> = {
  case: { title: "琴盒", body: "胡桃木盒体，同时是共鸣箱，让琴声更饱满" },
  lid: { title: "盒盖", body: "点击开合：打开即开始演奏，合上即停止" },
  glass: { title: "玻璃罩", body: "护住机芯，又能看清它如何转动" },
  bedplate: { title: "底板", body: "承载整套机芯的铸造底座" },
  comb_base: { title: "音梳底座", body: "把钢齿牢牢压在底板上，振动才能传给盒体" },
  cylinder: { title: "滚筒", body: "表面的凸点就是乐谱，转动时依次拨动钢齿" },
  cylinder_bracket: { title: "滚筒支架", body: "托住滚筒两端，让它平稳旋转" },
  spring_barrel: { title: "发条盒", body: "收着发条，释放的力推动整套机芯" },
  spring_coil: { title: "发条", body: "上弦时卷紧储能，放松时驱动滚筒" },
  gear_train: { title: "齿轮组", body: "把发条的力传给滚筒和调速器" },
  governor: { title: "调速器", body: "风扇叶片借空气阻力让转速保持平稳" },
  key: { title: "上弦钥匙", body: "按住绕圈拖动来上弦，反向转动无效" },
  felt: { title: "绒垫", body: "垫在盒底四角，防滑又不刮伤桌面" },
};

const TOOTH_BODY = "越长越低沉，越短越清脆";
const PIN_LABEL: PartLabel = { title: "凸点", body: "每颗凸点在特定时刻拨动一根钢齿" };

export function labelFor(decoded: DecodedId | null): PartLabel | null {
  if (!decoded) return null;
  switch (decoded.kind) {
    case "part":
      return PART_LABELS[decoded.name];
    case "tooth": {
      const midi = COMB_PITCHES[decoded.index];
      if (midi === undefined) return null;
      return { title: `钢齿 · ${noteName(midi)}`, body: TOOTH_BODY };
    }
    case "pin":
      return PIN_LABEL;
  }
}
