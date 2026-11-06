/**
 * "Pick matrix": a viewProjection that magnifies one output pixel to fill a 1x1 render target.
 *
 * GPU picking renders the ID pass into a 1x1 target. Selecting the pixel with a negative viewport
 * origin (viewport x = -px) relies on WebGPU's relaxed viewport rules, which older WebKit builds
 * (e.g. iOS 26.6) reject — the pass becomes invalid and every pick reads 0. Folding the selection
 * into the projection keeps the viewport at the default (0, 0, 1, 1), valid everywhere.
 *
 * In clip space: x' = W·x − W·cx·w, y' = H·y − H·cy·w, where (cx, cy) is the pixel centre in NDC.
 * Returns out = P · viewProjection (column-major).
 */
export function pickMatrix(
  px: number, py: number, width: number, height: number,
  viewProjection: Float32Array, out: Float32Array,
): Float32Array {
  const cx = (2 * (px + 0.5)) / width - 1;
  const cy = 1 - (2 * (py + 0.5)) / height;
  const vp = viewProjection;
  for (let col = 0; col < 4; col++) {
    const x = vp[col * 4]!, y = vp[col * 4 + 1]!, z = vp[col * 4 + 2]!, w = vp[col * 4 + 3]!;
    out[col * 4] = width * (x - cx * w);
    out[col * 4 + 1] = height * (y - cy * w);
    out[col * 4 + 2] = z;
    out[col * 4 + 3] = w;
  }
  return out;
}
