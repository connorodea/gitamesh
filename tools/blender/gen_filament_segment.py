"""
Generate the FILAMENT segment: a reusable tube cross-section for the
"telepathic" links between separated daughter globes (see the "fission,
flight, and telepathy" section of GITAMESH_ODYSSEY_CONCEPT.md). Endpoints
of these links move every frame (globes drift independently), so the link
itself is expected to be built at runtime -- this asset only supplies a
nicer cross-section than a raw THREE.Line, for the runtime to stretch
between two world-space points (e.g. scale.y + lookAt, or feed into
TubeGeometry control points).

Shape: a unit-length (1.0 along local +Y, so it composes naturally with
three.js's default "point along Y, then rotate to face target" convention),
thin, low-poly (6-sided) open cylinder, capped at both ends so it reads
solid under grazing light. Origin at the segment's own center, so a runtime
scale on Y stretches it symmetrically from the midpoint -- reposition after
scaling to align an end to each globe.

Run headless:
    blender --background --python tools/blender/gen_filament_segment.py

Deterministic: fully parametric, no RNG.
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
OUT_PATH = os.path.join(OUT_DIR, "filament-segment.glb")

SEGMENTS = 6
RADIUS = 0.02
LENGTH = 1.0


def build_filament():
    bm = bmesh.new()
    y0, y1 = -LENGTH / 2, LENGTH / 2

    bottom = []
    top = []
    for i in range(SEGMENTS):
        theta = 2 * math.pi * i / SEGMENTS
        x, z = math.cos(theta) * RADIUS, math.sin(theta) * RADIUS
        bottom.append(bm.verts.new((x, y0, z)))
        top.append(bm.verts.new((x, y1, z)))
    bm.verts.ensure_lookup_table()

    for i in range(SEGMENTS):
        j = (i + 1) % SEGMENTS
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))

    bottom_cap = bm.faces.new(reversed(bottom))
    top_cap = bm.faces.new(top)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = new_mesh_object("filament_segment", bm)

    def color_fn(vert_idx, co):
        return PALETTE["teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material("filament_segment_mat", PALETTE["teal"]))

    print(f"[filament_segment] verts={len(obj.data.vertices)} faces={len(obj.data.polygons)}")
    return obj


def main():
    reset_scene()
    obj = build_filament()
    export_glb(OUT_PATH, objects=[obj], use_mesh_edges=False)


if __name__ == "__main__":
    main()
