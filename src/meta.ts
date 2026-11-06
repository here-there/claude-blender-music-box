// Alignment data written by blender/build_musicbox.py next to musicbox.glb.
// All values are metres / radians in glTF space (+Y up, cylinder axis along +X, comb on the +Z side).

export type Vec3 = [number, number, number];

export interface CombTooth {
  x: number; // tooth centre line
  length: number; // root at z = tipZ + length, tip at z = tipZ
  midi: number;
}

export interface MusicBoxMeta {
  cylinder: { center: Vec3; radius: number; length: number }; // axis along +X
  comb: {
    toothWidth: number;
    toothThickness: number;
    tipZ: number;
    y: number; // tooth top surface height
    teeth: CombTooth[]; // 18 entries, bass on -X
  };
  // Pin direction at world angle a is +Y rotated about +X by a: (0, cos a, sin a).
  // A pin meets its tooth tip when its world angle equals pluckAngle.
  pluckAngle: number;
  pinHeight: number;
  pinRadius: number;
  lidHinge: { point: Vec3; axis: Vec3; openAngle: number };
}

function fail(path: string, what: string): never {
  throw new Error(`musicbox meta: ${path} ${what}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "must be an object");
  return v as Record<string, unknown>;
}

function num(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${path}.${key}`, "must be a finite number");
  return v;
}

function vec3(o: Record<string, unknown>, key: string, path: string): Vec3 {
  const v = o[key];
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    fail(`${path}.${key}`, "must be an array of 3 finite numbers");
  }
  return [v[0], v[1], v[2]];
}

export function validateMeta(raw: unknown): MusicBoxMeta {
  const root = obj(raw, "meta");
  const cyl = obj(root.cylinder, "cylinder");
  const comb = obj(root.comb, "comb");
  const hinge = obj(root.lidHinge, "lidHinge");
  const teethRaw = comb.teeth;
  if (!Array.isArray(teethRaw) || teethRaw.length === 0) fail("comb.teeth", "must be a non-empty array");
  const teeth = teethRaw.map((t, i) => {
    const p = `comb.teeth[${i}]`;
    const o = obj(t, p);
    return { x: num(o, "x", p), length: num(o, "length", p), midi: num(o, "midi", p) };
  });
  return {
    cylinder: {
      center: vec3(cyl, "center", "cylinder"),
      radius: num(cyl, "radius", "cylinder"),
      length: num(cyl, "length", "cylinder"),
    },
    comb: {
      toothWidth: num(comb, "toothWidth", "comb"),
      toothThickness: num(comb, "toothThickness", "comb"),
      tipZ: num(comb, "tipZ", "comb"),
      y: num(comb, "y", "comb"),
      teeth,
    },
    pluckAngle: num(root, "pluckAngle", "meta"),
    pinHeight: num(root, "pinHeight", "meta"),
    pinRadius: num(root, "pinRadius", "meta"),
    lidHinge: {
      point: vec3(hinge, "point", "lidHinge"),
      axis: vec3(hinge, "axis", "lidHinge"),
      openAngle: num(hinge, "openAngle", "lidHinge"),
    },
  };
}

export async function loadMeta(url: string): Promise<MusicBoxMeta> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`musicbox meta: failed to fetch ${url} (${res.status})`);
  return validateMeta(await res.json());
}
