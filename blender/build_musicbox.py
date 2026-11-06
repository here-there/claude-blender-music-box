"""Headless Blender build of the music box's static parts.

Usage:
  Blender -b -P blender/build_musicbox.py -- --out public/musicbox.glb [--preview scratch/preview.png]

All geometry is authored in glTF space (+Y up, +Z toward the viewer / comb side,
X along the cylinder) and converted to Blender's Z-up space at vertex creation,
so the exported glb (export_yup) lands back in exactly these coordinates.

Outputs:
  <out>                     glb with embedded baked textures, tangents and node extras
  <out dir>/musicbox.meta.json   alignment data for the procedural comb teeth and pins
"""

import argparse
import json
import math
import os
import random
import sys
import tempfile

import bpy
import bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="build_musicbox.py")
    p.add_argument("--out", required=True, help="output .glb path")
    p.add_argument("--preview", default=None, help="render a check image (Eevee) to this png")
    p.add_argument("--bake-only", default=None, help="comma list of materials to bake, then exit (dev)")
    p.add_argument("--no-bake", action="store_true",
                   help="keep procedural materials (only for quick previews; glb not exported)")
    a = p.parse_args(argv)
    a.out = os.path.abspath(os.path.join(ROOT, a.out)) if not os.path.isabs(a.out) else a.out
    if a.preview and not os.path.isabs(a.preview):
        a.preview = os.path.abspath(os.path.join(ROOT, a.preview))
    return a


# ---------------------------------------------------------------------------
# Dimensions (metres, glTF space)
# ---------------------------------------------------------------------------

BOX_HX, BOX_HZ = 0.080, 0.055          # outer half extents -> 0.16 x 0.11
WALL = 0.008
IN_HX, IN_HZ = BOX_HX - WALL, BOX_HZ - WALL
FELT_T = 0.001
FOOT_Y0, CASE_Y0 = FELT_T, 0.006       # bun feet between felt pads and case bottom
FLOOR_Y = CASE_Y0 + 0.006              # inner floor
CASE_Y1 = 0.066                        # rim height
LID_Y1 = 0.085                         # overall height
LID_TOP_T = 0.008
GLASS_Y0, GLASS_Y1 = 0.0565, 0.0585

BED_X0, BED_X1 = -0.066, 0.034         # bedplate: centred-left
BED_Z0, BED_Z1 = -0.044, 0.044
PLINTH_Y = FLOOR_Y + 0.006             # walnut plinth raising the movement toward the glass
BED_Y = PLINTH_Y + 0.003               # bedplate top

CYL_R, CYL_L = 0.008, 0.046
CYL_C = (-0.014, BED_Y + 0.015, -0.010)

TOOTH_PITCH, TOOTH_W, TOOTH_T = 0.0025, 0.002, 0.0006
PIN_H, PIN_R = 0.0011, 0.00025
PLUCK_ELEV = 0.20                      # meeting point this many radians above horizontal (+Z side)
PLUCK_ANGLE = math.pi / 2 - PLUCK_ELEV # pin dir at world angle a = rotate +Y about +X by a = (0, cos a, sin a)

LID_HINGE = (0.0, CASE_Y1, -BOX_HZ)
LID_AXIS = (-1.0, 0.0, 0.0)            # positive rotation lifts the front edge
LID_OPEN = math.radians(100.0)

# drive train (all axes along X except governor/key which are vertical)
PINION_TIP = 0.0032
BARREL_TIP = 0.0135
BARREL_C = (0.0, CYL_C[1], CYL_C[2] - (PINION_TIP + BARREL_TIP - 0.0012))
BIGGEAR_TIP = 0.0115
TRAIN_PINION_TIP = 0.0040
_d = BIGGEAR_TIP + TRAIN_PINION_TIP - 0.0008
TRAIN_C = (0.0, CYL_C[1] - 0.006, CYL_C[2] - math.sqrt(_d * _d - 0.006 * 0.006))
TRAIN_WHEEL_TIP = 0.0085
WHEEL_X = -0.048
WORM_R = 0.0018
GOV_C = (WHEEL_X, BED_Y, TRAIN_C[2] - (TRAIN_WHEEL_TIP + WORM_R - 0.0004))
KEY_C = (0.019, 0.0, BARREL_C[2])

PART_EXTRAS = {
    "cylinder":      ([1.0, 0.0, 0.0], 1.0),
    "spring_barrel": ([1.0, 0.0, 0.0], -0.125),
    "gear_train":    ([1.0, 0.0, 0.0], 3.0),
    "governor":      ([0.0, 1.0, 0.0], 96.0),
    "key":           ([0.0, 1.0, 0.0], 0.0),
    "lid":           (list(LID_AXIS), 0.0),
}


def comb_layout():
    with open(os.path.join(ROOT, "shared", "comb.json")) as f:
        comb = json.load(f)
    pitches = comb["pitches"]
    lmax, lmin = comb["lengthMax"], comb["lengthMin"]
    g = [1.0 / math.sqrt(440.0 * 2 ** ((m - 69) / 12.0)) for m in pitches]
    gmax, gmin = max(g), min(g)
    n = len(pitches)
    r_meet = CYL_R + 0.5 * PIN_H        # pin overlaps the tooth tip by half its height
    tip_z = CYL_C[2] + r_meet * math.cos(PLUCK_ELEV)
    under_y = CYL_C[1] + r_meet * math.sin(PLUCK_ELEV)
    teeth = []
    for i, (m, gi) in enumerate(zip(pitches, g)):
        x = CYL_C[0] + (i - (n - 1) / 2.0) * TOOTH_PITCH
        length = lmin + (lmax - lmin) * (gi - gmin) / (gmax - gmin)
        teeth.append({"x": round(x, 6), "length": round(length, 6), "midi": m})
    return {"toothWidth": TOOTH_W, "toothThickness": TOOTH_T,
            "tipZ": round(tip_z, 6), "y": round(under_y + TOOTH_T, 6), "teeth": teeth}


# ---------------------------------------------------------------------------
# Geometry helpers (glTF space in, Blender space stored)
# ---------------------------------------------------------------------------

def g2b(p):
    return Vector((p[0], -p[2], p[1]))


def b2g(v):
    return (v[0], v[2], -v[1])


def frame(axis, c, u, v, t):
    if axis == "x":
        return (c[0] + t, c[1] + u, c[2] + v)
    if axis == "y":
        return (c[0] + u, c[1] + t, c[2] + v)
    return (c[0] + u, c[1] + v, c[2] + t)


def circle(r, seg=32, a0=0.0):
    return [(r * math.cos(a0 + 2 * math.pi * i / seg), r * math.sin(a0 + 2 * math.pi * i / seg))
            for i in range(seg)]


def rounded_rect(hx, hz, r, seg=6):
    pts = []
    for cx, cz, a0 in ((hx - r, hz - r, 0.0), (-hx + r, hz - r, 0.5 * math.pi),
                       (-hx + r, -hz + r, math.pi), (hx - r, -hz + r, 1.5 * math.pi)):
        for i in range(seg + 1):
            a = a0 + 0.5 * math.pi * i / seg
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def gear_outline(n, r_root, r_tip):
    pts = []
    da = 2 * math.pi / n
    for i in range(n):
        a = i * da
        for f, r in ((0.0, r_root), (0.12, r_tip), (0.38, r_tip), (0.5, r_root), (0.75, r_root)):
            pts.append((r * math.cos(a + f * da), r * math.sin(a + f * da)))
    return pts


class Builder:
    """Accumulates geometry for one object in a bmesh."""

    def __init__(self):
        self.bm = bmesh.new()

    def loft(self, rings, mat, cyclic=False, cap0=False, cap1=False):
        vs = [[self.bm.verts.new(g2b(p)) for p in ring] for ring in rings]
        n, m = len(rings[0]), len(rings)
        for j in range(m if cyclic else m - 1):
            a, b = vs[j], vs[(j + 1) % m]
            for i in range(n):
                i2 = (i + 1) % n
                f = self.bm.faces.new((a[i], a[i2], b[i2], b[i]))
                f.material_index = mat
        if cap0:
            self.bm.faces.new(list(reversed(vs[0]))).material_index = mat
        if cap1:
            self.bm.faces.new(vs[-1]).material_index = mat

    def prism(self, pts, axis, c, t0, t1, mat):
        self.loft([[frame(axis, c, u, v, t0) for u, v in pts],
                   [frame(axis, c, u, v, t1) for u, v in pts]], mat, cap0=True, cap1=True)

    def annulus(self, outer, inner, axis, c, t0, t1, mat):
        assert len(outer) == len(inner)
        self.loft([[frame(axis, c, u, v, t0) for u, v in outer],
                   [frame(axis, c, u, v, t1) for u, v in outer],
                   [frame(axis, c, u, v, t1) for u, v in inner],
                   [frame(axis, c, u, v, t0) for u, v in inner]], mat, cyclic=True)

    def box(self, mn, mx, mat):
        c = ((mn[0] + mx[0]) / 2, 0.0, (mn[2] + mx[2]) / 2)
        hx, hz = (mx[0] - mn[0]) / 2, (mx[2] - mn[2]) / 2
        self.prism([(hx, hz), (-hx, hz), (-hx, -hz), (hx, -hz)], "y", c, mn[1], mx[1], mat)

    def cyl(self, axis, c, r, t0, t1, mat, seg=32):
        self.prism(circle(r, seg), axis, c, t0, t1, mat)

    def tube(self, axis, c, r_in, r_out, t0, t1, mat, seg=48):
        self.annulus(circle(r_out, seg), circle(r_in, seg), axis, c, t0, t1, mat)

    def dome(self, axis, c, r, h, t0, mat, seg=20, rings=5):
        """Screw-head style dome: flat base at t0, rounded top of height h."""
        rs = [[frame(axis, c, u, v, t0) for u, v in circle(r, seg)]]
        for k in range(1, rings + 1):
            a = 0.5 * math.pi * k / (rings + 1)
            rs.append([frame(axis, c, u, v, t0 + h * math.sin(a)) for u, v in circle(r * math.cos(a), seg)])
        self.loft(rs, mat, cap0=True, cap1=True)

    def gear(self, axis, c, n, r_root, r_tip, t0, t1, mat, rim=None, hub=None, spokes=4, bore=0.0):
        outline = gear_outline(n, r_root, r_tip)
        if rim is None:
            if bore > 0:
                inner = [(bore * math.cos(math.atan2(v, u)), bore * math.sin(math.atan2(v, u))) for u, v in outline]
                self.annulus(outline, inner, axis, c, t0, t1, mat)
            else:
                self.prism(outline, axis, c, t0, t1, mat)
            return
        inner = [(rim * math.cos(math.atan2(v, u)), rim * math.sin(math.atan2(v, u))) for u, v in outline]
        self.annulus(outline, inner, axis, c, t0, t1, mat)
        hub = hub or rim * 0.3
        tm = (t1 - t0) * 0.15
        self.tube(axis, c, bore, hub, t0 - tm, t1 + tm, mat, seg=24) if bore > 0 else \
            self.cyl(axis, c, hub, t0 - tm, t1 + tm, mat, seg=24)
        w = rim * 0.16
        for k in range(spokes):
            a = 2 * math.pi * k / spokes + 0.3
            ca, sa = math.cos(a), math.sin(a)
            r0, r1 = hub * 0.8, rim * 1.02
            pts = [(r0 * ca - w * sa, r0 * sa + w * ca), (r1 * ca - w * sa, r1 * sa + w * ca),
                   (r1 * ca + w * sa, r1 * sa - w * ca), (r0 * ca + w * sa, r0 * sa - w * ca)]
            ti = (t1 - t0) * 0.2
            self.prism(pts, axis, c, t0 + ti, t1 - ti, mat)

    def helix(self, c, coil_r, wire_r, y0, y1, pitch, mat, seg=10, steps_per_turn=36):
        turns = (y1 - y0) / pitch
        steps = max(2, int(turns * steps_per_turn))
        rings = []
        for s in range(steps + 1):
            phi = 2 * math.pi * turns * s / steps
            y = y0 + (y1 - y0) * s / steps
            p = Vector((c[0] + coil_r * math.cos(phi), y, c[2] + coil_r * math.sin(phi)))
            t = Vector((-coil_r * math.sin(phi) * 2 * math.pi, pitch, coil_r * math.cos(phi) * 2 * math.pi)).normalized()
            n = Vector((math.cos(phi), 0.0, math.sin(phi)))
            b = t.cross(n).normalized()
            n = b.cross(t).normalized()
            rings.append([tuple(p + wire_r * (math.cos(2 * math.pi * k / seg) * n + math.sin(2 * math.pi * k / seg) * b))
                          for k in range(seg)])
        self.loft(rings, mat, cap0=True, cap1=True)

    def to_object(self, name, mats, pivot=(0.0, 0.0, 0.0)):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        off = g2b(pivot)
        for v in self.bm.verts:
            v.co -= off
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        ob = bpy.data.objects.new(name, me)
        ob.location = off
        bpy.context.scene.collection.objects.link(ob)
        for m in mats:
            me.materials.append(m)
        return ob


def apply_modifiers(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    me.name = ob.name


def bevel(ob, width, segments=3, angle=35.0):
    m = ob.modifiers.new("bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(angle)
    m.miter_outer = "MITER_ARC"
    apply_modifiers(ob)


def boolean_cut(ob, cutter):
    m = ob.modifiers.new("cut", "BOOLEAN")
    m.operation = "DIFFERENCE"
    m.solver = "EXACT"
    m.material_mode = "TRANSFER"
    m.object = cutter
    apply_modifiers(ob)
    bpy.data.objects.remove(cutter)


def append_geometry(ob, builder):
    """Merge a Builder's geometry (world glTF coords) into an existing object."""
    off = ob.location.copy()
    for v in builder.bm.verts:
        v.co -= off
    bmesh.ops.recalc_face_normals(builder.bm, faces=builder.bm.faces)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    tmp = bpy.data.meshes.new("tmp")
    builder.bm.to_mesh(tmp)
    builder.bm.free()
    bm.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)
    bm.to_mesh(ob.data)
    bm.free()


# ---------------------------------------------------------------------------
# Materials: procedural node graphs -> baked image textures
# ---------------------------------------------------------------------------

# name: (swatch size in metres, texture resolution)
MAT_SPECS = {
    "walnut":         (0.24, 1024),
    "velvet":         (0.20, 512),
    "inlay":          (None, 1024),     # mapped 0..1 over the inlay panel
    "brass_brushed":  (0.12, 512),
    "brass_polished": (0.10, 512),
    "steel":          (0.08, 512),
    "blued_steel":    (0.06, 512),
    "lead":           (0.03, 256),
    "felt":           (0.20, 256),
}

INLAY_RECT = (-0.060, 0.060, -0.037, 0.037)   # x0, x1, z0, z1 of the panel inside the lid


class Nodes:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nt.nodes.clear()

    def new(self, kind, **kw):
        n = self.nt.nodes.new(kind)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    def link(self, out, inp):
        self.nt.links.new(out, inp)

    @staticmethod
    def sock(coll, name, kind=None):
        for s in coll:
            if s.name == name and (kind is None or s.type == kind) and s.enabled:
                return s
        for s in coll:
            if s.name == name and (kind is None or s.type == kind):
                return s
        raise KeyError(name)

    def set(self, node, name, val, kind=None):
        s = self.sock(node.inputs, name, kind)
        if isinstance(val, bpy.types.NodeSocket):
            self.link(val, s)
        else:
            s.default_value = val

    def math(self, op, a, b=0.0, clamp=False, c=0.5):
        n = self.new("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b, c)):
            if isinstance(v, bpy.types.NodeSocket):
                self.link(v, n.inputs[i])
            else:
                n.inputs[i].default_value = v
        return n.outputs[0]

    def vscale(self, vec, s):
        n = self.new("ShaderNodeVectorMath", operation="MULTIPLY")
        self.link(vec, n.inputs[0])
        n.inputs[1].default_value = s
        return n.outputs[0]

    def vadd(self, vec, other):
        n = self.new("ShaderNodeVectorMath", operation="ADD")
        self.link(vec, n.inputs[0])
        if isinstance(other, bpy.types.NodeSocket):
            self.link(other, n.inputs[1])
        else:
            n.inputs[1].default_value = other
        return n.outputs[0]

    def sep(self, vec):
        n = self.new("ShaderNodeSeparateXYZ")
        self.link(vec, n.inputs[0])
        return n.outputs

    def comb(self, x, y, z):
        n = self.new("ShaderNodeCombineXYZ")
        for i, v in enumerate((x, y, z)):
            if isinstance(v, bpy.types.NodeSocket):
                self.link(v, n.inputs[i])
            else:
                n.inputs[i].default_value = v
        return n.outputs[0]

    def noise(self, vec, scale, detail=4.0, rough=0.5, distortion=0.0):
        n = self.new("ShaderNodeTexNoise")
        self.link(vec, n.inputs["Vector"])
        self.set(n, "Scale", scale)
        self.set(n, "Detail", detail)
        self.set(n, "Roughness", rough)
        self.set(n, "Distortion", distortion)
        return n.outputs["Fac"]

    def ramp(self, fac, stops):
        n = self.new("ShaderNodeValToRGB")
        self.link(fac, n.inputs[0])
        els = n.color_ramp.elements
        while len(els) > 1:
            els.remove(els[-1])
        els[0].position, els[0].color = stops[0][0], (*stops[0][1], 1.0)
        for pos, col in stops[1:]:
            e = els.new(pos)
            e.color = (*col, 1.0)
        return n.outputs["Color"]

    def mix(self, fac, a, b):
        n = self.new("ShaderNodeMix", data_type="RGBA")
        self.set(n, "Factor", fac, "VALUE")
        for name, v in (("A", a), ("B", b)):
            s = self.sock(n.inputs, name, "RGBA")
            if isinstance(v, bpy.types.NodeSocket):
                self.link(v, s)
            else:
                s.default_value = (*v, 1.0)
        return self.sock(n.outputs, "Result", "RGBA")

    def bump(self, height, distance, strength=1.0):
        n = self.new("ShaderNodeBump")
        self.set(n, "Height", height)
        self.set(n, "Distance", distance)
        self.set(n, "Strength", strength)
        return n.outputs["Normal"]


def coords(nb, size):
    """Physical coordinates in metres over the swatch (UV * size)."""
    tc = nb.new("ShaderNodeTexCoord")
    return nb.vscale(tc.outputs["UV"], (size, size, size))


def wood_grain(nb, P, ring_period=0.0026, figure=1.0, seed=0.0):
    """Returns (fac 0..1 grain, pore mask 0..1, tone 0..1) with grain lines running along X."""
    P2 = nb.vadd(P, (seed, seed * 1.7, seed * 0.3))
    sx, sy, sz = nb.sep(P2)

    def stretched(kx, ky, s, detail=3.0, rough=0.55):
        return nb.noise(nb.comb(nb.math("MULTIPLY", sx, kx), nb.math("MULTIPLY", sy, ky), s), 1.0,
                        detail=detail, rough=rough)

    # cathedral-like arches: slow waves along the board plus finer wobble
    arch = stretched(9.0, 22.0, seed + 1.0, detail=2.0)
    wob = stretched(45.0, 160.0, seed + 2.0, detail=3.0)
    y = nb.math("ADD", sy, nb.math("MULTIPLY", nb.math("SUBTRACT", arch, 0.5), 0.022 * figure))
    y = nb.math("ADD", y, nb.math("MULTIPLY", nb.math("SUBTRACT", wob, 0.5), 0.0022 * figure))
    # ring spacing varies along the radius
    spacing = stretched(2.0, 35.0, seed + 5.0, detail=1.0)
    phase = nb.math("DIVIDE", y, nb.math("MULTIPLY", ring_period, nb.math("ADD", 0.6, spacing)))
    saw = nb.math("FRACT", phase)
    ring = nb.math("POWER", saw, 3.0)            # gradual early wood, sharp late-wood edge
    streak = stretched(30.0, 1800.0, seed + 7.0, detail=6.0, rough=0.65)
    fac = nb.math("ADD", nb.math("MULTIPLY", ring, 0.7), nb.math("MULTIPLY", streak, 0.3))
    # open pores: short dark dashes along the grain
    pores = stretched(700.0, 7000.0, seed + 11.0, detail=1.0, rough=0.3)
    pores = nb.math("POWER", nb.math("MULTIPLY", nb.math("SUBTRACT", pores, 0.38, clamp=True), 1.0), 1.0)
    pores = nb.math("POWER", nb.math("SUBTRACT", 1.0, nb.math("MULTIPLY", pores, 4.0), clamp=True), 6.0)
    tone = stretched(4.0, 55.0, seed + 13.0, detail=3.0)
    return fac, pores, tone


def build_procedural(name):
    """Create a procedural material and return (material, channels).

    channels: dict(color=socket, rough=socket|float, metal=socket|float, normal=socket|None)
    """
    mat = bpy.data.materials.new(name + "_proc")
    mat.use_nodes = True
    nb = Nodes(mat)
    size, _ = MAT_SPECS[name]
    P = coords(nb, size if size else 1.0)
    ch = {"metal": 0.0, "normal": None}

    if name == "walnut":
        fac, pores, tone = wood_grain(nb, P, ring_period=0.0042, figure=1.0)
        col = nb.ramp(fac, [(0.0, (0.115, 0.058, 0.028)), (0.40, (0.075, 0.036, 0.017)),
                            (0.75, (0.036, 0.016, 0.008)), (1.0, (0.020, 0.009, 0.004))])
        # heartwood streaks: some boards lighter / redder, some nearly chocolate
        col = nb.mix(nb.math("MULTIPLY", nb.math("SUBTRACT", tone, 0.45, clamp=True), 1.6), col, (0.16, 0.085, 0.040))
        col = nb.mix(nb.math("MULTIPLY", nb.math("SUBTRACT", 0.45, tone, clamp=True), 1.4), col, (0.028, 0.013, 0.007))
        col = nb.mix(nb.math("MULTIPLY", pores, 0.75), col, (0.010, 0.005, 0.0025))
        ch["color"] = col
        ch["rough"] = nb.math("ADD", nb.math("ADD", 0.28, nb.math("MULTIPLY", fac, 0.06)), nb.math("MULTIPLY", pores, 0.3))
        h = nb.math("ADD", nb.math("MULTIPLY", fac, 0.25), nb.math("MULTIPLY", pores, -1.0))
        ch["normal"] = nb.bump(h, 0.00012 / size, 1.0)

    elif name == "inlay":
        img = bpy.data.images.load(make_inlay_mask())
        img.colorspace_settings.name = "Non-Color"
        tc = nb.new("ShaderNodeTexCoord")
        tex = nb.new("ShaderNodeTexImage", interpolation="Closest", image=img)
        nb.link(tc.outputs["UV"], tex.inputs["Vector"])
        rgb = nb.new("ShaderNodeSeparateColor")
        nb.link(tex.outputs["Color"], rgb.inputs[0])
        idx = nb.math("ROUND", nb.math("MULTIPLY", rgb.outputs[0], 4.0))
        # physical coords across the panel (metres), grain along X
        w = INLAY_RECT[1] - INLAY_RECT[0]
        h = INLAY_RECT[3] - INLAY_RECT[2]
        Pp = nb.vscale(tc.outputs["UV"], (w, h, 1.0))
        # rosette petals carry their grain radially: rotate the coordinate per petal via G channel angle
        fac, pores, _ = wood_grain(nb, Pp, ring_period=0.0018, figure=0.35, seed=4.0)
        species = [
            [(0.0, (0.62, 0.45, 0.26)), (1.0, (0.45, 0.30, 0.15))],   # 0 maple / satinwood
            [(0.0, (0.020, 0.014, 0.010)), (1.0, (0.008, 0.006, 0.005))],  # 1 ebony stringing
            [(0.0, (0.23, 0.07, 0.035)), (1.0, (0.10, 0.025, 0.012))],  # 2 rosewood
            [(0.0, (0.14, 0.075, 0.037)), (1.0, (0.035, 0.016, 0.008))],  # 3 walnut field
            [(0.0, (0.40, 0.24, 0.11)), (1.0, (0.22, 0.12, 0.05))],     # 4 olive burl
        ]
        col = nb.ramp(fac, species[0])
        for k in range(1, len(species)):
            sel = nb.math("COMPARE", idx, float(k), c=0.25)
            col = nb.mix(sel, col, nb.ramp(fac, species[k]))
        ch["color"] = col
        ch["rough"] = nb.math("ADD", 0.26, nb.math("MULTIPLY", pores, 0.15))
        # tiny glue-line grooves between pieces + pores
        edge = nb.new("ShaderNodeTexImage", interpolation="Linear", image=img)
        nb.link(tc.outputs["UV"], edge.inputs["Vector"])
        sep2 = nb.new("ShaderNodeSeparateColor")
        nb.link(edge.outputs["Color"], sep2.inputs[0])
        groove = sep2.outputs[1]   # G = smoothed piece boundary mask
        hgt = nb.math("ADD", nb.math("MULTIPLY", groove, -0.6), nb.math("MULTIPLY", pores, -0.5))
        ch["normal"] = nb.bump(hgt, 0.00002 / w, 1.0)

    elif name == "velvet":
        n1 = nb.noise(P, 900.0, detail=8.0, rough=0.75)
        n2 = nb.noise(P, 60.0, detail=3.0, rough=0.5)
        col = nb.ramp(nb.math("ADD", nb.math("MULTIPLY", n1, 0.5), nb.math("MULTIPLY", n2, 0.5)),
                      [(0.3, (0.060, 0.004, 0.010)), (0.7, (0.170, 0.012, 0.028))])
        ch["color"] = col
        ch["rough"] = nb.math("ADD", 0.82, nb.math("MULTIPLY", n1, 0.15))
        ch["normal"] = nb.bump(n1, 0.00025 / size, 1.0)

    elif name == "felt":
        n1 = nb.noise(P, 1500.0, detail=10.0, rough=0.8, distortion=0.5)
        n2 = nb.noise(P, 80.0, detail=3.0)
        col = nb.ramp(nb.math("ADD", nb.math("MULTIPLY", n1, 0.6), nb.math("MULTIPLY", n2, 0.4)),
                      [(0.3, (0.010, 0.040, 0.018)), (0.75, (0.030, 0.090, 0.040))])
        ch["color"] = col
        ch["rough"] = 0.95
        ch["normal"] = nb.bump(n1, 0.0004 / size, 1.0)

    elif name in ("brass_brushed", "brass_polished", "steel", "blued_steel", "lead"):
        sx, sy, sz = nb.sep(P)
        if name == "brass_brushed":
            streak = nb.noise(nb.comb(nb.math("MULTIPLY", sx, 25.0), nb.math("MULTIPLY", sy, 4500.0), 0.0),
                              1.0, detail=6.0, rough=0.65)
            smudge = nb.noise(P, 30.0, detail=3.0)
            ch["color"] = nb.ramp(nb.math("ADD", nb.math("MULTIPLY", streak, 0.5), nb.math("MULTIPLY", smudge, 0.5)),
                                  [(0.2, (0.62, 0.42, 0.15)), (0.8, (0.80, 0.58, 0.24))])
            ch["rough"] = nb.math("ADD", 0.22, nb.math("MULTIPLY", streak, 0.20))
            ch["metal"] = 1.0
            ch["normal"] = nb.bump(streak, 0.0000015 / size * 60.0, 1.0)
        elif name == "brass_polished":
            smudge = nb.noise(P, 50.0, detail=4.0, rough=0.6)
            fine = nb.noise(P, 2500.0, detail=2.0)
            ch["color"] = nb.ramp(smudge, [(0.25, (0.70, 0.50, 0.19)), (0.75, (0.86, 0.66, 0.30))])
            ch["rough"] = nb.math("ADD", 0.10, nb.math("MULTIPLY", nb.math("POWER", smudge, 3.0), 0.18))
            ch["metal"] = 1.0
            ch["normal"] = nb.bump(fine, 0.00000012 / size * 60.0, 1.0)
        elif name == "steel":
            streak = nb.noise(nb.comb(nb.math("MULTIPLY", sx, 3000.0), nb.math("MULTIPLY", sy, 30.0), 0.0),
                              1.0, detail=6.0, rough=0.6)
            ch["color"] = nb.ramp(streak, [(0.2, (0.48, 0.49, 0.50)), (0.8, (0.62, 0.63, 0.64))])
            ch["rough"] = nb.math("ADD", 0.16, nb.math("MULTIPLY", streak, 0.16))
            ch["metal"] = 1.0
            ch["normal"] = nb.bump(streak, 0.000001 / size * 60.0, 1.0)
        elif name == "blued_steel":
            n1 = nb.noise(P, 120.0, detail=3.0)
            ch["color"] = nb.ramp(n1, [(0.2, (0.020, 0.030, 0.110)), (0.6, (0.030, 0.055, 0.200)),
                                       (0.9, (0.080, 0.040, 0.160))])
            ch["rough"] = nb.math("ADD", 0.18, nb.math("MULTIPLY", n1, 0.1))
            ch["metal"] = 1.0
            ch["normal"] = nb.bump(nb.noise(P, 3000.0, detail=2.0), 0.0000005 / size * 60.0, 1.0)
        else:  # lead
            n1 = nb.noise(P, 300.0, detail=6.0, rough=0.7)
            ch["color"] = nb.ramp(n1, [(0.2, (0.16, 0.16, 0.17)), (0.8, (0.30, 0.30, 0.31))])
            ch["rough"] = nb.math("ADD", 0.45, nb.math("MULTIPLY", n1, 0.3))
            ch["metal"] = 0.9
            ch["normal"] = nb.bump(n1, 0.0001 / size, 1.0)
    else:
        raise ValueError(name)

    bsdf = nb.new("ShaderNodeBsdfPrincipled")
    out = nb.new("ShaderNodeOutputMaterial")
    nb.set(bsdf, "Base Color", ch["color"])
    nb.set(bsdf, "Roughness", ch["rough"])
    nb.set(bsdf, "Metallic", ch["metal"])
    if ch["normal"] is not None:
        nb.set(bsdf, "Normal", ch["normal"])
    nb.link(bsdf.outputs[0], out.inputs["Surface"])
    ch["bsdf"] = bsdf
    ch["out"] = out
    return mat, ch


def make_inlay_mask():
    """Piece-id image for the lid inlay (R = id/4, G = blurred boundary mask)."""
    import numpy as np
    res = 1024
    x0, x1, z0, z1 = INLAY_RECT
    w, h = x1 - x0, z1 - z0
    u = (np.arange(res) + 0.5) / res
    U, V = np.meshgrid(u, u)
    px, pz = (U - 0.5) * w, (V - 0.5) * h
    ids = np.full((res, res), 3, dtype=np.float32)   # walnut field
    d = np.minimum(w / 2 - np.abs(px), h / 2 - np.abs(pz))
    ids[d < 0.0068] = 1
    ids[d < 0.0062] = 0
    ids[d < 0.0050] = 1
    ids[d < 0.0044] = 2          # rosewood crossbanding
    r = np.hypot(px, pz)
    a = np.arctan2(pz, px)
    # compass rosette
    ring = (r > 0.0205) & (r < 0.0250)
    ids[ring] = 0
    ids[(r > 0.0205) & (r < 0.0212)] = 1
    ids[(r > 0.0243) & (r < 0.0250)] = 1
    ids[r <= 0.0205] = 4         # olive burl ground
    k = 8
    t = (a * k / (2 * np.pi)) % 1.0
    tri = np.abs(t - 0.5) * 2.0   # 1 at point centre, 0 between
    for scale, phase in ((0.0190, 0.0), (0.0120, 0.5)):
        tt = ((a * k / (2 * np.pi)) + phase) % 1.0
        tri = 1.0 - np.abs(tt - 0.5) * 2.0
        star = r < 0.0025 + (scale - 0.0025) * tri ** 1.6
        half = tt < 0.5
        sel = star & (ids != 1) & (r <= 0.0205)
        ids[sel & half] = 0
        ids[sel & ~half] = 2
    ids[r < 0.0025] = 1
    # corner quarter fans
    for sx in (-1, 1):
        for sz in (-1, 1):
            cx, cz = sx * (w / 2 - 0.0068), sz * (h / 2 - 0.0068)
            rr = np.hypot(px - cx, pz - cz)
            inside = (d >= 0.0068) & (rr < 0.012)
            aa = np.arctan2((pz - cz) * -sz, (px - cx) * -sx)
            fan = ((aa * 10 / np.pi) % 2.0) < 1.0
            ids[inside & fan] = 0
            ids[inside & ~fan] = 2
            ids[(d >= 0.0068) & (rr >= 0.012) & (rr < 0.0128)] = 1
    # boundary mask
    edge = np.zeros_like(ids)
    edge[:, 1:] += ids[:, 1:] != ids[:, :-1]
    edge[1:, :] += ids[1:, :] != ids[:-1, :]
    edge = np.clip(edge, 0, 1)
    for _ in range(2):
        edge = (edge + np.roll(edge, 1, 0) + np.roll(edge, -1, 0) + np.roll(edge, 1, 1) + np.roll(edge, -1, 1)) / 5.0
    img = np.zeros((res, res, 4), dtype=np.float32)
    img[..., 0] = ids / 4.0
    img[..., 1] = np.clip(edge * 2.0, 0, 1)
    img[..., 3] = 1.0
    path = os.path.join(BAKE_DIR, "inlay_mask.png")
    im = bpy.data.images.new("inlay_mask", res, res, alpha=True, float_buffer=False)
    im.colorspace_settings.name = "Non-Color"
    im.pixels.foreach_set(img.ravel())
    im.filepath_raw = path
    im.file_format = "PNG"
    im.save()
    bpy.data.images.remove(im)
    return path


BAKE_DIR = os.path.join(tempfile.gettempdir(), "musicbox_bake")


def swatch_plane():
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new("UVMap")
    for loop, co in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = co
    me = bpy.data.meshes.new("swatch")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("swatch", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def bake_material(name):
    """Bake a procedural material into baseColor / ORM / normal images; return the final material."""
    _, res = MAT_SPECS[name]
    mat, ch = build_procedural(name)
    nt = mat.node_tree
    plane = swatch_plane()
    plane.data.materials.append(mat)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    plane.select_set(True)
    bpy.context.view_layer.objects.active = plane
    scene = bpy.context.scene

    def target(kind, colorspace):
        img = bpy.data.images.new(f"{name}_{kind}", res, res, alpha=False)
        img.colorspace_settings.name = colorspace
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        nt.nodes.active = node
        return img, node

    def emit(sock_or_val):
        em = nt.nodes.new("ShaderNodeEmission")
        if isinstance(sock_or_val, bpy.types.NodeSocket):
            nt.links.new(sock_or_val, em.inputs["Color"])
        else:
            em.inputs["Color"].default_value = sock_or_val
        nt.links.new(em.outputs[0], ch["out"].inputs["Surface"])
        return em

    def save(img, kind):
        path = os.path.join(BAKE_DIR, f"{name}_{kind}.png")
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
        return path

    paths = {}
    # base colour
    img, node = target("baseColor", "sRGB")
    emit(ch["color"])
    scene.cycles.samples = 4
    bpy.ops.object.bake(type="EMIT", margin=4, use_clear=True)
    paths["baseColor"] = save(img, "baseColor")
    # occlusion / roughness / metallic
    img, node = target("orm", "Non-Color")
    cc = nt.nodes.new("ShaderNodeCombineColor")
    cc.inputs[0].default_value = 1.0
    for i, key in ((1, "rough"), (2, "metal")):
        v = ch[key]
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, cc.inputs[i])
        else:
            cc.inputs[i].default_value = v
    emit(cc.outputs[0])
    bpy.ops.object.bake(type="EMIT", margin=4, use_clear=True)
    paths["orm"] = save(img, "orm")
    # tangent-space normal
    if ch["normal"] is not None:
        img, node = target("normal", "Non-Color")
        nt.links.new(ch["bsdf"].outputs[0], ch["out"].inputs["Surface"])
        scene.cycles.samples = 16
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=4, use_clear=True)
        paths["normal"] = save(img, "normal")

    bpy.data.objects.remove(plane)
    bpy.data.materials.remove(mat)
    for im in list(bpy.data.images):
        if im.name.startswith(name + "_"):
            bpy.data.images.remove(im)
    return final_material(name, paths)


def final_material(name, paths):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nb = Nodes(mat)
    bsdf = nb.new("ShaderNodeBsdfPrincipled")
    out = nb.new("ShaderNodeOutputMaterial")
    nb.link(bsdf.outputs[0], out.inputs["Surface"])
    base = bpy.data.images.load(paths["baseColor"])
    base.colorspace_settings.name = "sRGB"
    tb = nb.new("ShaderNodeTexImage", image=base)
    nb.link(tb.outputs["Color"], nb.sock(bsdf.inputs, "Base Color"))
    orm = bpy.data.images.load(paths["orm"])
    orm.colorspace_settings.name = "Non-Color"
    to = nb.new("ShaderNodeTexImage", image=orm)
    sep = nb.new("ShaderNodeSeparateColor")
    nb.link(to.outputs["Color"], sep.inputs[0])
    nb.link(sep.outputs[1], nb.sock(bsdf.inputs, "Roughness"))
    nb.link(sep.outputs[2], nb.sock(bsdf.inputs, "Metallic"))
    if "normal" in paths:
        nimg = bpy.data.images.load(paths["normal"])
        nimg.colorspace_settings.name = "Non-Color"
        tn = nb.new("ShaderNodeTexImage", image=nimg)
        nm = nb.new("ShaderNodeNormalMap")
        nb.link(tn.outputs["Color"], nm.inputs["Color"])
        nb.link(nm.outputs["Normal"], nb.sock(bsdf.inputs, "Normal"))
    return mat


def glass_material():
    mat = bpy.data.materials.new("glass")
    mat.use_nodes = True
    nb = Nodes(mat)
    bsdf = nb.new("ShaderNodeBsdfPrincipled")
    out = nb.new("ShaderNodeOutputMaterial")
    nb.link(bsdf.outputs[0], out.inputs["Surface"])
    nb.set(bsdf, "Base Color", (0.020, 0.026, 0.025, 1.0))
    nb.set(bsdf, "Roughness", 0.02)
    nb.set(bsdf, "Metallic", 0.0)
    nb.set(bsdf, "Alpha", 0.10)
    mat.surface_render_method = "BLENDED"
    return mat


def make_materials(bake):
    os.makedirs(BAKE_DIR, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.render.bake.margin = 4
    mats = {}
    for name in MAT_SPECS:
        if bake:
            print(f"[musicbox] baking {name} ...", flush=True)
            mats[name] = bake_material(name)
        else:
            m, _ = build_procedural(name)
            m.name = name
            mats[name] = m
    mats["glass"] = glass_material()
    return mats


# ---------------------------------------------------------------------------
# UVs: per-face box projection in physical units
# ---------------------------------------------------------------------------

def assign_uvs(ob):
    me = ob.data
    rnd = random.Random(ob.name)
    bm = bmesh.new()
    bm.from_mesh(me)
    # glTF tangents (MikkTSpace) need triangles; ngon caps are concave, use beauty fill
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
    uv = bm.loops.layers.uv.verify()
    loc = ob.location
    pts = [b2g(v.co + loc) for v in bm.verts]
    mn = [min(p[i] for p in pts) for i in range(3)]
    mx = [max(p[i] for p in pts) for i in range(3)]
    offs = {}
    for mi, m in enumerate(me.materials):
        size = MAT_SPECS.get(m.name, (0.1, 0))[0]
        if size is None:
            offs[mi] = None
            continue
        ext = max(mx[i] - mn[i] for i in range(3)) / size
        slack = max(0.0, 1.0 - ext - 0.02)
        offs[mi] = (size, 0.01 + rnd.random() * slack, 0.01 + rnd.random() * slack)
    for f in bm.faces:
        n = b2g(f.normal)
        ax = max(range(3), key=lambda i: abs(n[i]))
        spec = offs.get(f.material_index)
        for loop in f.loops:
            p = b2g(loop.vert.co + loc)
            if spec is None:  # inlay panel: 0..1 across INLAY_RECT
                x0, x1, z0, z1 = INLAY_RECT
                loop[uv].uv = ((p[0] - x0) / (x1 - x0), (p[2] - z0) / (z1 - z0))
                continue
            size, ou, ov = spec
            if ax == 1:
                a, b, ia, ib = p[0], p[2], 0, 2
            elif ax == 2:
                a, b, ia, ib = p[0], p[1], 0, 1
            else:
                a, b, ia, ib = p[2], p[1], 2, 1
            loop[uv].uv = ((a - mn[ia]) / size + ou, (b - mn[ib]) / size + ov)
    bm.to_mesh(me)
    bm.free()


def finish(ob, smooth_angle=35.0):
    assign_uvs(ob)
    for p in ob.data.polygons:
        p.use_smooth = True
    ob.data.set_sharp_from_angle(angle=math.radians(smooth_angle))
    if ob.name in PART_EXTRAS:
        axis, ratio = PART_EXTRAS[ob.name]
        ob["axis"] = axis
        ob["ratio"] = ratio


# ---------------------------------------------------------------------------
# Parts
# ---------------------------------------------------------------------------

def build_case(M):
    b = Builder()
    b.prism(rounded_rect(BOX_HX, BOX_HZ, 0.004), "y", (0, 0, 0), CASE_Y0, CASE_Y1, 0)
    ob = b.to_object("case", [M["walnut"], M["velvet"], M["brass_polished"]])
    c = Builder()
    c.prism(rounded_rect(IN_HX, IN_HZ, 0.0015), "y", (0, 0, 0), FLOOR_Y, CASE_Y1 + 0.01, 0)
    cutter = c.to_object("case_cut", [M["velvet"]])
    boolean_cut(ob, cutter)
    extra = Builder()
    # glass ledge strips (walnut) and compartment divider
    ly0, ly1, lw = GLASS_Y0 - 0.0025, GLASS_Y0, 0.0022
    extra.box((-IN_HX, ly0, -IN_HZ), (IN_HX, ly1, -IN_HZ + lw), 0)
    extra.box((-IN_HX, ly0, IN_HZ - lw), (IN_HX, ly1, IN_HZ), 0)
    extra.box((-IN_HX, ly0, -IN_HZ), (-IN_HX + lw, ly1, IN_HZ), 0)
    extra.box((IN_HX - lw, ly0, -IN_HZ), (IN_HX, ly1, IN_HZ), 0)
    extra.box((0.038, FLOOR_Y, -IN_HZ), (0.041, ly1 - 0.004, IN_HZ), 0)
    extra.box((BED_X0 + 0.002, FLOOR_Y - 0.0005, BED_Z0 + 0.002), (BED_X1 - 0.002, PLINTH_Y, BED_Z1 - 0.002), 0)
    # bun feet
    for sx in (-1, 1):
        for sz in (-1, 1):
            extra.prism(circle(0.0065, 32), "y", (sx * 0.066, 0, sz * 0.041), FOOT_Y0, CASE_Y0 + 0.0005, 0)
    append_geometry(ob, extra)
    bevel(ob, 0.0010, segments=3)
    # hinge knuckles (brass) on the back edge, after bevel so they stay crisp cylinders
    hk = Builder()
    for x0 in (-0.058, 0.046):
        for a, b2 in ((0.0, 0.004), (0.008, 0.012)):
            hk.cyl("x", (0, LID_HINGE[1], LID_HINGE[2]), 0.0021, x0 + a, x0 + b2, 2, seg=20)
        hk.box((x0, CASE_Y1 - 0.009, LID_HINGE[2] - 0.0004), (x0 + 0.012, CASE_Y1 - 0.0005, LID_HINGE[2] + 0.0002), 2)
    append_geometry(ob, hk)
    finish(ob)
    return ob


def build_lid(M):
    b = Builder()
    b.prism(rounded_rect(BOX_HX, BOX_HZ, 0.004), "y", (0, 0, 0), CASE_Y1, LID_Y1, 0)
    ob = b.to_object("lid", [M["walnut"], M["velvet"], M["inlay"], M["brass_polished"]], pivot=LID_HINGE)
    c = Builder()
    c.prism(rounded_rect(IN_HX, IN_HZ, 0.0015), "y", (0, 0, 0), CASE_Y1 - 0.01, LID_Y1 - LID_TOP_T, 1)
    cutter = c.to_object("lid_cut", [M["velvet"]])
    boolean_cut(ob, cutter)
    bevel(ob, 0.0016, segments=4)
    ex = Builder()
    x0, x1, z0, z1 = INLAY_RECT
    ceil = LID_Y1 - LID_TOP_T
    # walnut frame moulding around the inlay panel, then the panel itself
    ex.annulus(rounded_rect((x1 - x0) / 2 + 0.0035, (z1 - z0) / 2 + 0.0035, 0.002, 4),
               rounded_rect((x1 - x0) / 2 + 0.0002, (z1 - z0) / 2 + 0.0002, 0.0002, 4),
               "y", (0, 0, 0), ceil - 0.0022, ceil + 0.0002, 0)
    ex.box((x0, ceil - 0.0012, z0), (x1, ceil + 0.0002, z1), 2)
    # hinge knuckle (lid side) + leaf
    for x0k in (-0.058, 0.046):
        ex.cyl("x", (0, LID_HINGE[1], LID_HINGE[2]), 0.0021, x0k + 0.004, x0k + 0.008, 3, seg=20)
        ex.box((x0k + 0.0035, CASE_Y1 + 0.0005, LID_HINGE[2] - 0.0004),
               (x0k + 0.0085, CASE_Y1 + 0.009, LID_HINGE[2] + 0.0002), 3)
    append_geometry(ob, ex)
    finish(ob)
    return ob


def build_glass(M):
    b = Builder()
    b.prism(rounded_rect(IN_HX - 0.0004, IN_HZ - 0.0004, 0.0012), "y", (0, 0, 0), GLASS_Y0, GLASS_Y1, 0)
    ob = b.to_object("glass", [M["glass"]], pivot=(0, GLASS_Y0, 0))
    bevel(ob, 0.0004, segments=2)
    finish(ob)
    return ob


def bracket_profile(axle_u, axle_v, half_w, base_u, top_r, flare=0.0015, seg=12):
    """2D (u=y, v=z) upright with a rounded top centred on an axle."""
    pts = [(base_u, axle_v - half_w - flare)]
    for i in range(seg + 1):
        a = math.pi * i / seg            # sweep over the top
        pts.append((axle_u + top_r * math.sin(a), axle_v - top_r * math.cos(a)))
    pts.append((base_u, axle_v + half_w + flare))
    return pts


def build_bedplate(M):
    b = Builder()
    BR, BL = 0, 1
    b.prism(rounded_rect((BED_X1 - BED_X0) / 2, (BED_Z1 - BED_Z0) / 2, 0.003), "y",
            ((BED_X0 + BED_X1) / 2, 0, (BED_Z0 + BED_Z1) / 2), PLINTH_Y, BED_Y, BR)
    meta = COMB
    teeth = meta["teeth"]
    comb_back = max(t["length"] for t in teeth) + meta["tipZ"] + 0.0095
    under = meta["y"] - TOOTH_T
    xl, xr = teeth[0]["x"] - 0.005, teeth[-1]["x"] + 0.005
    # comb riser block under the back of the comb
    riser_z0 = max(t["length"] for t in teeth) + meta["tipZ"] + 0.0015
    b.box((xl, BED_Y - 0.0005, riser_z0), (xr, under - 0.0045, comb_back), BR)
    # barrel arbor uprights and the governor cock
    ax = (0, BARREL_C[1], BARREL_C[2])
    for x0 in (0.0095, 0.0262):
        b.prism(bracket_profile(BARREL_C[1], BARREL_C[2], 0.0028, BED_Y - 0.0005, 0.0028), "x", (0, 0, 0), x0, x0 + 0.0018, BR)
    # gear train outer upright (−X side)
    tax = (0, TRAIN_C[1], TRAIN_C[2])
    b.prism(bracket_profile(TRAIN_C[1], TRAIN_C[2], 0.0025, BED_Y - 0.0005, 0.0025), "x", (0, 0, 0), -0.0525, -0.0507, BR)
    # governor: post + lower bearing + upper arm
    gx, gz = GOV_C[0], GOV_C[2]
    post_x = gx - 0.0135
    b.box((post_x - 0.0018, BED_Y - 0.0005, gz - 0.0018), (post_x + 0.0018, BED_Y + 0.0278, gz + 0.0018), BR)
    b.box((post_x, BED_Y + 0.0255, gz - 0.0016), (gx + 0.0022, BED_Y + 0.0273, gz + 0.0016), BR)
    b.cyl("y", (gx, 0, gz), 0.0024, BED_Y + 0.0255, BED_Y + 0.0273, BR, seg=24)
    b.cyl("y", (gx, 0, gz), 0.0024, BED_Y - 0.0005, BED_Y + 0.0018, BR, seg=24)
    # screws (blued) holding the bedplate, comb riser and uprights
    for sx, sz in ((BED_X0 + 0.004, BED_Z0 + 0.004), (BED_X0 + 0.004, BED_Z1 - 0.004),
                   (BED_X1 - 0.004, BED_Z0 + 0.004), (BED_X1 - 0.004, BED_Z1 - 0.004),
                   (0.024, 0.006)):
        b.dome("y", (sx, 0, sz), 0.0021, 0.0012, BED_Y - 0.0002, BL)
    ob = b.to_object("bedplate", [M["brass_brushed"], M["blued_steel"]], pivot=(BED_X0, PLINTH_Y, 0))
    bevel(ob, 0.0003, segments=2)
    finish(ob)
    return ob


def build_cylinder_bracket(M):
    b = Builder()
    cx, cy, cz = CYL_C
    ax = (0, cy, cz)
    left_x = cx - CYL_L / 2 - 0.0025
    right_x = cx + CYL_L / 2 + 0.0005
    for x0 in (left_x, right_x):
        b.prism(bracket_profile(cy, cz, 0.0045, BED_Y - 0.0005, 0.0045), "x", (0, 0, 0), x0, x0 + 0.002, 0)
        # bearing boss
        b.tube("x", ax, 0.0012, 0.0026, x0 - 0.0006, x0 + 0.0026, 0, seg=28)
    # left upright also carries the gear-train arbor (web between the two bearings)
    tz, ty = TRAIN_C[2], TRAIN_C[1]
    web = [(BED_Y - 0.0005, cz + 0.002), (BED_Y - 0.0005, tz - 0.0045), (ty + 0.0035, tz - 0.0035),
           (ty + 0.0045, tz), (cy - 0.002, cz - 0.004)]
    b.prism(web, "x", (0, 0, 0), left_x, left_x + 0.002, 0)
    b.tube("x", (0, ty, tz), 0.0009, 0.0021, left_x - 0.0005, left_x + 0.0025, 0, seg=24)
    # feet flanges with screws
    for x0 in (left_x, right_x):
        b.box((x0 - 0.002, BED_Y - 0.0005, cz - 0.007), (x0 + 0.004, BED_Y + 0.0012, cz + 0.007), 0)
    ob = b.to_object("cylinder_bracket", [M["brass_brushed"]], pivot=(cx, BED_Y, cz))
    bevel(ob, 0.0002, segments=2)
    finish(ob)
    return ob


def build_comb_base(M):
    meta = COMB
    teeth = meta["teeth"]
    p = TOOTH_PITCH
    top = meta["y"]
    bot = top - 0.0045
    tip = meta["tipZ"]
    roots = [tip + t["length"] for t in teeth]
    back = max(roots) + 0.0095
    xl, xr = teeth[0]["x"] - 0.005, teeth[-1]["x"] + 0.005
    # stepped outline in (x, z): the front edge follows each tooth's root
    outline = [(xl, back), (xl, roots[0])]
    for i, t in enumerate(teeth):
        x_a = t["x"] - p / 2 if i > 0 else xl
        x_b = t["x"] + p / 2 if i < len(teeth) - 1 else xr
        if i > 0:
            outline.append((x_a, roots[i]))
        outline.append((x_b, roots[i]))
    outline.append((xr, back))
    b = Builder()
    # prism "y" frame uses (u=x, v=z); outline must be in that order
    b.prism(outline, "y", (0, 0, 0), bot, top, 0)
    # lead weights under the bass teeth roots
    for i in range(6):
        t = teeth[i]
        ln = 0.0085 - i * 0.0009
        b.box((t["x"] - 0.0009, top - TOOTH_T - 0.0034, roots[i] - ln),
              (t["x"] + 0.0009, top - TOOTH_T - 0.0001, roots[i] + 0.0003), 1)
    # clamp bar across the roots + screws
    b.box((xl + 0.001, top, back - 0.0075), (xr - 0.001, top + 0.0022, back - 0.0012), 0)
    for sx in (xl + 0.0045, (xl + xr) / 2, xr - 0.0045):
        b.dome("y", (sx, 0, back - 0.0043), 0.0019, 0.0011, top + 0.0021, 2)
    ob = b.to_object("comb_base", [M["steel"], M["lead"], M["blued_steel"]], pivot=(CYL_C[0], bot, back))
    bevel(ob, 0.00015, segments=2, angle=40.0)
    finish(ob)
    return ob


def build_cylinder(M):
    cx, cy, cz = CYL_C
    ax = (0, cy, cz)
    x0, x1 = cx - CYL_L / 2, cx + CYL_L / 2
    b = Builder()
    # drum: slightly crowned end bands
    rings = []
    seg = 96
    prof = [(x0 + 0.0012, CYL_R * 0.92), (x0 + 0.0012, CYL_R + 0.0003), (x0 + 0.0024, CYL_R + 0.0003),
            (x0 + 0.0026, CYL_R), (x1 - 0.0026, CYL_R), (x1 - 0.0024, CYL_R + 0.0003),
            (x1 - 0.0012, CYL_R + 0.0003), (x1 - 0.0012, CYL_R * 0.92)]
    for x, r in prof:
        rings.append([frame("x", ax, u, v, x) for u, v in circle(r, seg)])
    b.loft(rings, 0, cap0=True, cap1=True)
    # end plates
    b.cyl("x", ax, CYL_R * 0.9, x0, x0 + 0.0012, 0, seg=48)
    b.cyl("x", ax, CYL_R * 0.9, x1 - 0.0012, x1, 0, seg=48)
    # arbor (steel)
    b.cyl("x", ax, 0.0011, x0 - 0.0085, x1 + 0.0075, 1, seg=20)
    # great wheel at -X end and pinion at +X end
    b.gear("x", ax, 64, BIGGEAR_TIP - 0.0009, BIGGEAR_TIP, x0 - 0.0055, x0 - 0.0040, 0, rim=BIGGEAR_TIP - 0.0022,
           hub=0.0026, spokes=5, bore=0.0)
    b.gear("x", ax, 12, PINION_TIP - 0.0008, PINION_TIP, x1 + 0.0035, x1 + 0.0062, 0)
    ob = b.to_object("cylinder", [M["brass_polished"], M["steel"]], pivot=CYL_C)
    finish(ob, smooth_angle=30.0)
    return ob


def build_spring_barrel(M):
    bx0, bx1 = 0.0125, 0.0248
    ax = (0, BARREL_C[1], BARREL_C[2])
    b = Builder()
    b.gear("x", ax, 72, BARREL_TIP - 0.0008, BARREL_TIP, bx0 + 0.0034, bx0 + 0.0061, 0, bore=0.0118)
    # drum wall (open toward +X so the blued spring is visible)
    b.tube("x", ax, 0.0118, 0.0128, bx0, bx1, 0, seg=72)
    b.tube("x", ax, 0.0118, 0.0131, bx1 - 0.0008, bx1, 0, seg=72)
    # closed back wall with a decorative ring groove
    b.tube("x", ax, 0.0016, 0.0119, bx0, bx0 + 0.0009, 0, seg=72)
    b.tube("x", ax, 0.0016, 0.0035, bx0 - 0.0006, bx0 + 0.0009, 0, seg=32)
    ob = b.to_object("spring_barrel", [M["brass_polished"]], pivot=(bx0, BARREL_C[1], BARREL_C[2]))
    finish(ob, smooth_angle=30.0)
    return ob


def build_spring_coil(M):
    ax = (0, BARREL_C[1], BARREL_C[2])
    r0, r1, turns, th = 0.0026, 0.0114, 6.5, 0.00042
    n = int(turns * 64)
    inner, outer = [], []
    for i in range(n + 1):
        a = 2 * math.pi * turns * i / n
        r = r0 + (r1 - r0) * i / n
        inner.append((r * math.cos(a), r * math.sin(a)))
        outer.append(((r + th) * math.cos(a), (r + th) * math.sin(a)))
    pts = inner + list(reversed(outer))
    b = Builder()
    b.prism(pts, "x", ax, 0.0138, 0.0232, 0)
    # arbor with hook collar
    b.cyl("x", ax, 0.0015, 0.0090, 0.0290, 0, seg=24)
    b.cyl("x", ax, 0.0026, 0.0138, 0.0232, 0, seg=24)
    ob = b.to_object("spring_coil", [M["blued_steel"]], pivot=(0.0138, BARREL_C[1], BARREL_C[2]))
    finish(ob, smooth_angle=50.0)
    return ob


def build_gear_train(M):
    ax = (0, TRAIN_C[1], TRAIN_C[2])
    cx = CYL_C[0] - CYL_L / 2
    b = Builder()
    # pinion meshing with the great wheel (same plane), wheel driving the worm
    b.gear("x", ax, 10, TRAIN_PINION_TIP - 0.0009, TRAIN_PINION_TIP, cx - 0.0058, cx - 0.0037, 0)
    b.gear("x", ax, 48, TRAIN_WHEEL_TIP - 0.0007, TRAIN_WHEEL_TIP, WHEEL_X - 0.0006, WHEEL_X + 0.0006, 0,
           rim=TRAIN_WHEEL_TIP - 0.0017, hub=0.0018, spokes=4)
    b.cyl("x", ax, 0.0008, -0.0535, cx - 0.0010, 1, seg=16)
    ob = b.to_object("gear_train", [M["brass_polished"], M["steel"]], pivot=(cx, TRAIN_C[1], TRAIN_C[2]))
    finish(ob, smooth_angle=30.0)
    return ob


def build_governor(M):
    gx, gy, gz = GOV_C
    c = (gx, 0, gz)
    b = Builder()
    b.cyl("y", c, 0.0006, BED_Y, BED_Y + 0.0340, 0, seg=12)                # steel staff
    b.cyl("y", c, 0.0011, TRAIN_C[1] - 0.0065, TRAIN_C[1] + 0.0065, 0, seg=16)  # worm core
    b.helix(c, 0.0012, 0.00045, TRAIN_C[1] - 0.0060, TRAIN_C[1] + 0.0060, 0.0011, 0, seg=8, steps_per_turn=24)
    # fan: brass collar, cross arm and two blades (blade planes contain the axis)
    b.cyl("y", c, 0.0018, BED_Y + 0.0282, BED_Y + 0.0312, 1, seg=20)
    b.box((gx - 0.0105, BED_Y + 0.0290, gz - 0.0005), (gx + 0.0105, BED_Y + 0.0302, gz + 0.0005), 1)
    for s in (-1, 1):
        x_in, x_out = gx + s * 0.0035, gx + s * 0.0110
        b.box((min(x_in, x_out), BED_Y + 0.0278, gz - 0.00015), (max(x_in, x_out), BED_Y + 0.0345, gz + 0.00015), 0)
    ob = b.to_object("governor", [M["steel"], M["brass_polished"]], pivot=GOV_C)
    finish(ob, smooth_angle=40.0)
    return ob


def build_key(M):
    kx, _, kz = KEY_C
    c = (kx, 0, kz)
    pts = []
    for i in range(96):
        a = 2 * math.pi * i / 96
        r = 0.0035 + 0.0085 * abs(math.cos(a)) ** 1.6
        r *= 1.0 - 0.12 * math.cos(2 * a) ** 2 * (abs(math.sin(a)) > 0.3)
        pts.append((r * math.cos(a), r * math.sin(a) * 0.95))
    b = Builder()
    b.prism(pts, "y", c, 0.0016, 0.0031, 0)
    b.cyl("y", c, 0.0028, 0.0016, 0.0042, 0, seg=24)
    b.cyl("y", c, 0.0016, 0.0042, CASE_Y0 + 0.0002, 0, seg=20)
    # pierced decoration: a raised bead ring on each wing
    for s in (-1, 1):
        b.tube("y", (kx + s * 0.0072, 0, kz), 0.0012, 0.0019, 0.0029, 0.0034, 0, seg=20)
    ob = b.to_object("key", [M["brass_polished"]], pivot=(kx, 0.0, kz))
    bevel(ob, 0.0003, segments=2, angle=40.0)
    finish(ob)
    return ob


def build_felt(M):
    b = Builder()
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.cyl("y", (sx * 0.066, 0, sz * 0.041), 0.0060, 0.0, FELT_T + 0.0002, 0, seg=32)
    ob = b.to_object("felt", [M["felt"]])
    finish(ob)
    return ob


# ---------------------------------------------------------------------------
# Export + meta
# ---------------------------------------------------------------------------

def export(out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_tangents=True,
        export_extras=True,
        export_apply=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        use_selection=False,
    )


def write_meta(path):
    meta = {
        "cylinder": {"center": [round(v, 6) for v in CYL_C], "radius": CYL_R, "length": CYL_L},
        "comb": COMB,
        "pluckAngle": round(PLUCK_ANGLE, 6),
        "pinHeight": PIN_H,
        "pinRadius": PIN_R,
        "lidHinge": {"point": [round(v, 6) for v in LID_HINGE], "axis": list(LID_AXIS),
                     "openAngle": round(LID_OPEN, 6)},
    }
    with open(path, "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

def preview(path, M):
    scene = bpy.context.scene
    lid = bpy.data.objects["lid"]
    lid.rotation_mode = "AXIS_ANGLE"
    ax = g2b(LID_AXIS)
    lid.rotation_axis_angle = (LID_OPEN, ax.x, ax.y, ax.z)
    # temporary teeth + pins so alignment can be judged
    tb = Builder()
    meta = COMB
    for t in meta["teeth"]:
        tb.box((t["x"] - TOOTH_W / 2, meta["y"] - TOOTH_T, meta["tipZ"]),
               (t["x"] + TOOTH_W / 2, meta["y"], meta["tipZ"] + t["length"]), 0)
    tb.to_object("preview_teeth", [M["steel"]])
    pb = Builder()
    rnd = random.Random(3)
    for t in meta["teeth"]:
        for k in range(10):
            a = PLUCK_ANGLE + (0 if k == 0 else rnd.uniform(0.3, 2 * math.pi - 0.3))
            d = (0.0, math.cos(a), math.sin(a))
            rings = []
            for rr in (CYL_R * 0.98, CYL_R + PIN_H):
                cc = (t["x"], CYL_C[1] + d[1] * rr, CYL_C[2] + d[2] * rr)
                ring = []
                for u, v in circle(PIN_R, 8):
                    # local frame: X and tangent (0, -sin a, cos a)
                    ring.append((cc[0] + u, cc[1] - math.sin(a) * v, cc[2] + math.cos(a) * v))
                rings.append(ring)
            pb.loft(rings, 0, cap0=True, cap1=True)
    pb.to_object("preview_pins", [M["steel"]])

    for o in bpy.data.objects:
        if o.type == "MESH":
            o.data.update()
    # camera: 3/4 from the front-right, above
    target = Vector(g2b((0.0, 0.045, -0.005)))
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam_data.clip_start = 0.01
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = g2b((0.21, 0.27, 0.33))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    # lights: warm key, cool fill, rim
    def light(name, kind, loc, energy, color, size=0.2):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if kind == "AREA":
            ld.size = size
        lo = bpy.data.objects.new(name, ld)
        lo.location = g2b(loc)
        lo.rotation_euler = (target - lo.location).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)
    light("key", "AREA", (-0.25, 0.40, 0.20), 7.0, (1.0, 0.80, 0.58), 0.25)
    light("fill", "AREA", (0.35, 0.18, 0.15), 1.5, (0.75, 0.85, 1.0), 0.4)
    light("rim", "AREA", (0.05, 0.30, -0.35), 4.0, (1.0, 0.9, 0.8), 0.3)
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.05, 0.04, 0.035, 1.0)
    bg.inputs[1].default_value = 0.35
    scene.world = world
    # ground plane
    gb = Builder()
    gb.box((-0.6, -0.002, -0.6), (0.6, 0.0, 0.6), 0)
    gm = bpy.data.materials.new("table")
    gm.use_nodes = True
    p = gm.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (0.03, 0.025, 0.02, 1.0)
    p.inputs["Roughness"].default_value = 0.6
    gb.to_object("table", [gm])

    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = 64
    try:
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    scene.view_settings.view_transform = "AgX"
    scene.render.filepath = path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print(f"[musicbox] preview -> {path}")
    # close-up of the movement with the glass hidden
    bpy.data.objects["glass"].hide_render = True
    cam.location = g2b((0.05, 0.17, 0.11))
    t2 = Vector(g2b((-0.014, 0.030, 0.006)))
    cam.rotation_euler = (t2 - cam.location).to_track_quat("-Z", "Y").to_euler()
    root, ext = os.path.splitext(path)
    scene.render.filepath = root + "_mech" + ext
    bpy.ops.render.render(write_still=True)
    print(f"[musicbox] preview -> {scene.render.filepath}")
    # side section from +X: checks tooth tips vs pins at the pluck angle
    for n in ("case", "lid", "spring_barrel", "spring_coil", "cylinder_bracket"):
        bpy.data.objects[n].hide_render = True
    cam_data.lens = 100
    cam.location = g2b((0.20, CYL_C[1] + 0.004, 0.006))
    t3 = Vector(g2b((0.0, CYL_C[1] + 0.001, 0.006)))
    cam.rotation_euler = (t3 - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = root + "_side" + ext
    bpy.ops.render.render(write_still=True)
    print(f"[musicbox] preview -> {scene.render.filepath}")


# ---------------------------------------------------------------------------

COMB = comb_layout()


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if args.bake_only:
        global MAT_SPECS
        MAT_SPECS = {k: v for k, v in MAT_SPECS.items() if k in args.bake_only.split(",")}
        make_materials(bake=True)
        return
    M = make_materials(bake=not args.no_bake)
    parts = [build_case(M), build_lid(M), build_glass(M), build_bedplate(M), build_comb_base(M),
             build_cylinder(M), build_cylinder_bracket(M), build_spring_barrel(M), build_spring_coil(M),
             build_gear_train(M), build_governor(M), build_key(M), build_felt(M)]
    print("[musicbox] parts:", ", ".join(p.name for p in parts))
    if not args.no_bake:
        export(args.out)
        meta_path = os.path.join(os.path.dirname(args.out), "musicbox.meta.json")
        write_meta(meta_path)
        print(f"[musicbox] wrote {args.out} ({os.path.getsize(args.out) / 1e6:.2f} MB) and {meta_path}")
    if args.preview:
        preview(args.preview, M)


if __name__ == "__main__":
    main()
