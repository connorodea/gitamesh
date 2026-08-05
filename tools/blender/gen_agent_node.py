"""
Generate the agent/node module: the repeatable low-poly unit meant to
populate the coordination mesh lattice (see gen_mesh_lattice.py) with more
character than a bare `sphereGeometry`, the current placeholder in the
react-three-fiber scene.

Shape: a faceted bipyramid ("gem") with a hexagonal equator -- 8 vertices,
12 triangles. Chosen over a sphere because its flat facets catch directional
light distinctly per-instance (a sphere reads identically from every angle;
a faceted gem visibly glints as instances rotate/drift), while staying cheap
enough to instance in the hundreds alongside the lattice.

Vertex-colored in two zones so the runtime can key off color instead of a
second draw call:
    - body (the hexagonal band + lower pyramid): teal, the idle/primary hue
    - upper apex facets: orange, so a subset of instanced nodes can be
      recolored (e.g. via an instance color attribute) to read as
      "active/claimed" without swapping geometry.

Run headless:
    blender --background --python tools/blender/gen_agent_node.py

Deterministic: no randomness is used at all -- the shape is fully
parametric, so re-running always produces byte-identical geometry.
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
OUT_PATH = os.path.join(OUT_DIR, "agent-node.glb")

EQUATOR_SEGMENTS = 6
EQUATOR_RADIUS = 0.32
TOP_HEIGHT = 0.62      # apex above equator (taller -> reads as "pointing")
BOTTOM_HEIGHT = 0.34    # apex below equator (shorter -> stable base read)


def build_agent_node():
    bm = bmesh.new()

    equator = [
        bm.verts.new((
            math.cos(2 * math.pi * i / EQUATOR_SEGMENTS) * EQUATOR_RADIUS,
            math.sin(2 * math.pi * i / EQUATOR_SEGMENTS) * EQUATOR_RADIUS,
            0.0,
        ))
        for i in range(EQUATOR_SEGMENTS)
    ]
    top = bm.verts.new((0.0, 0.0, TOP_HEIGHT))
    bottom = bm.verts.new((0.0, 0.0, -BOTTOM_HEIGHT))
    bm.verts.ensure_lookup_table()

    for i in range(EQUATOR_SEGMENTS):
        a = equator[i]
        b = equator[(i + 1) % EQUATOR_SEGMENTS]
        bm.faces.new((a, b, top))
        bm.faces.new((b, a, bottom))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    obj = new_mesh_object("agent_node", bm)

    def color_fn(vert_idx, co):
        # co.z is in local space (origin at the equator plane); the top
        # apex and its immediate facet neighbors read as the "active" zone.
        if co.z > TOP_HEIGHT * 0.45:
            return PALETTE["orange"]
        return PALETTE["teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material("agent_node_mat", PALETTE["teal"]))

    tri_count = len(obj.data.polygons)
    vert_count = len(obj.data.vertices)
    print(f"[agent_node] verts={vert_count} tris={tri_count}")
    return obj


def main():
    reset_scene()
    obj = build_agent_node()
    export_glb(OUT_PATH, objects=[obj], use_mesh_edges=False)


if __name__ == "__main__":
    main()
