"""
Generate the TIME-CORRIDOR ring: the repeatable stratum for Act III (the
event-log corridor). Meant to be instanced many times (dozens-to-hundreds)
receding down the Z axis, each ring = one moment in the replayable event
log.

Shape: a short annular tube (outer wall + inner wall + top/bottom rims) so
it has real facets to catch light from multiple angles as the camera moves
through the corridor, unlike a flat disc. One segment of the rim is
recolored orange as a "pulse marker" facet -- the runtime can rotate this
per-instance or drive its emissive strength to read as "an event fired in
this moment of the log."

Kept deliberately cheap (16 radial segments, no smoothing) since it is the
single most-instanced asset in the whole set.

Run headless:
    blender --background --python tools/blender/gen_time_ring.py

Deterministic: fully parametric, no RNG at all.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh
import bpy
from common import PALETTE, apply_vertex_colors, export_glb, make_vertex_color_material, new_mesh_object, reset_scene

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "apps", "site", "public", "models")
OUT_PATH = os.path.join(OUT_DIR, "time-ring.glb")

SEGMENTS = 16
OUTER_RADIUS = 1.0
INNER_RADIUS = 0.86
HEIGHT = 0.12
PULSE_SEGMENT_SPAN = 2  # how many of the 16 segments count as the "pulse marker" facet


def ring_verts(bm, radius, z):
    verts = []
    for i in range(SEGMENTS):
        theta = 2 * math.pi * i / SEGMENTS
        verts.append(bm.verts.new((math.cos(theta) * radius, math.sin(theta) * radius, z)))
    return verts


def build_time_ring():
    bm = bmesh.new()
    z0, z1 = -HEIGHT / 2, HEIGHT / 2

    outer_bottom = ring_verts(bm, OUTER_RADIUS, z0)
    outer_top = ring_verts(bm, OUTER_RADIUS, z1)
    inner_bottom = ring_verts(bm, INNER_RADIUS, z0)
    inner_top = ring_verts(bm, INNER_RADIUS, z1)
    bm.verts.ensure_lookup_table()

    for i in range(SEGMENTS):
        j = (i + 1) % SEGMENTS
        # Outer wall
        bm.faces.new((outer_bottom[i], outer_bottom[j], outer_top[j], outer_top[i]))
        # Inner wall (reversed winding so the normal faces inward)
        bm.faces.new((inner_bottom[j], inner_bottom[i], inner_top[i], inner_top[j]))
        # Top rim
        bm.faces.new((outer_top[i], outer_top[j], inner_top[j], inner_top[i]))
        # Bottom rim
        bm.faces.new((outer_bottom[j], outer_bottom[i], inner_bottom[i], inner_bottom[j]))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = new_mesh_object("time_ring", bm)

    def color_fn(vert_idx, co):
        angle = math.atan2(co.y, co.x)
        if angle < 0:
            angle += 2 * math.pi
        segment = int(angle / (2 * math.pi) * SEGMENTS)
        if segment < PULSE_SEGMENT_SPAN:
            return PALETTE["orange"]
        return PALETTE["dim_teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material("time_ring_mat", PALETTE["dim_teal"]))

    print(f"[time_ring] verts={len(obj.data.vertices)} quad_faces={len(obj.data.polygons)}")
    return obj


def main():
    reset_scene()
    obj = build_time_ring()
    export_glb(OUT_PATH, objects=[obj], use_mesh_edges=False)


if __name__ == "__main__":
    main()
