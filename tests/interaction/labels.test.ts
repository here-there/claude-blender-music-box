import { describe, it, expect } from "vitest";
import { PART_LABELS, labelFor } from "../../src/interaction/labels";
import { PART_NAMES, decodeId, PIN_ID, partId, toothId } from "../../src/parts";

describe("labels", () => {
  it("every part has a non-empty Chinese title and body", () => {
    for (const name of PART_NAMES) {
      const l = PART_LABELS[name];
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.body.length).toBeGreaterThan(0);
    }
  });
  it("labels parts by name", () => {
    expect(labelFor(decodeId(partId("cylinder")))).toEqual(PART_LABELS.cylinder);
    expect(PART_LABELS.cylinder.title).toBe("滚筒");
  });
  it("labels teeth with their note name", () => {
    expect(labelFor({ kind: "tooth", index: 0 })!.title).toContain("A3");
    expect(labelFor(decodeId(toothId(0)))!.title).toBe(labelFor({ kind: "tooth", index: 0 })!.title);
    expect(labelFor({ kind: "tooth", index: 0 })!.body).toBe("越长越低沉，越短越清脆");
  });
  it("labels pins", () => {
    expect(labelFor(decodeId(PIN_ID))).toEqual({ title: "凸点", body: "每颗凸点在特定时刻拨动一根钢齿" });
  });
  it("returns null for nothing", () => {
    expect(labelFor(null)).toBeNull();
    expect(labelFor(decodeId(0))).toBeNull();
  });
});
