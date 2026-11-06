"""Render fixed-camera close-ups of the drive train from an exported glb.

Used to document the model before/after a fix (blog illustrations):

  /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/render_closeups.py -- \
      --glb public/musicbox.glb --out docs/blog/assets/history --prefix after

Cameras are fixed so renders of different model versions line up.
Coordinates below are Blender world space (glTF (x, y, z) imports as (x, -z, y)).
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

HIDE = {"case", "lid", "glass", "felt"}

# name: (camera location, look-at target, focal length mm)
VIEWS = {
    # barrel ring gear vs. cylinder pinion, seen from above: shows the axial (x) alignment
    "barrel-pinion-top": ((0.0160, 0.0175, 0.100), (0.0160, 0.0180, 0.036), 55),
    # same mesh from the back-right, three-quarter view
    "barrel-pinion-34": ((0.060, 0.070, 0.080), (0.0150, 0.018, 0.036), 70),
    # cylinder great wheel driving the governor gear train
    "greatwheel-train": ((-0.090, -0.020, 0.075), (-0.044, 0.018, 0.030), 60),
}


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--prefix", required=True)
    return p.parse_args(argv)


def look_at(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(a.glb))
    for ob in bpy.context.scene.objects:
        if ob.name.split(".")[0] in HIDE:
            ob.hide_render = True

    scene = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1400, 1000
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = -0.6

    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.32, 0.30, 0.28, 1.0)
    bg.inputs[1].default_value = 0.35
    scene.world = world

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 2.2
    sun.rotation_euler = (math.radians(40), math.radians(15), math.radians(30))
    scene.collection.objects.link(sun)
    fill = bpy.data.objects.new("fill", bpy.data.lights.new("fill", "SUN"))
    fill.data.energy = 0.5
    fill.rotation_euler = (math.radians(-50), math.radians(-20), math.radians(200))
    scene.collection.objects.link(fill)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.clip_start = 0.001
    scene.collection.objects.link(cam)
    scene.camera = cam

    os.makedirs(a.out, exist_ok=True)
    for name, (loc, target, lens) in VIEWS.items():
        cam.location = Vector(loc)
        look_at(cam, target)
        cam.data.lens = lens
        scene.render.filepath = os.path.join(os.path.abspath(a.out), f"{a.prefix}-{name}.png")
        bpy.ops.render.render(write_still=True)
        print("wrote", scene.render.filepath)


main()
