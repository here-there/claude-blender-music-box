/** Pure pointer geometry for picking and key winding (unit-tested). */

export interface Rect { left: number; top: number; width: number; height: number }

/** CSS client coordinates → integer pixel of a render target covering `rect`, clamped inside the target. */
export function cssToTargetPixel(
  cssX: number, cssY: number, rect: Rect, targetSize: readonly [number, number],
): [number, number] {
  const [w, h] = targetSize;
  const x = Math.floor(((cssX - rect.left) / Math.max(1e-6, rect.width)) * w);
  const y = Math.floor(((cssY - rect.top) / Math.max(1e-6, rect.height)) * h);
  return [Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y))];
}

/** Angle of the pointer around a centre, in screen space (y down): increases clockwise on screen. */
export function pointerAngle(px: number, py: number, cx: number, cy: number): number {
  return Math.atan2(py - cy, px - cx);
}

/** Shortest signed difference next − prev wrapped into (−π, π]; backward motion (negative) gives 0. */
export function ratchetDelta(prevAngle: number, nextAngle: number): number {
  let d = (nextAngle - prevAngle) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d > 0 ? d : 0;
}

/** World point → CSS client coordinates through a column-major viewProjection; null behind the camera. */
export function projectToCss(
  viewProjection: ArrayLike<number>, p: readonly [number, number, number], rect: Rect,
): [number, number] | null {
  const m = viewProjection;
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  if (!(w > 1e-9)) return null;
  return [rect.left + ((x / w + 1) / 2) * rect.width, rect.top + ((1 - y / w) / 2) * rect.height];
}
