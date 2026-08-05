"""
Generate the "exploded mechanism" asset: one compound object, authored as
four clearly-named, independently addressable meshes, standing in for
Gitamesh's four coordination primitives:

    part_claim     - a hexagonal token: one agent atomically holds one task.
    part_fencing   - a stepped, numbered-tooth ratchet disc: a monotonic
                     fencing token, each step strictly larger than the last,
                     so a stale writer's late write is provably older.
    part_lease     - a ring with an inset pulsing core: a lease + heartbeat,
                     the ring reads as a countdown/renewal cycle.
    part_eventlog  - a stack of thin plates: an append-only event log, each
                     plate one immutable entry.

All four parts are authored ASSEMBLED (concentric / stacked at the origin)
in one mesh naming scheme so the three.js side can:
  - address each part by name (mesh.name === "part_claim", etc.)
  - read each part's assembled-position local origin as its "explode from"
    point (each part's mesh origin is set to its own centroid, not world
    origin, specifically so a runtime offset along its own outward normal
    reads as a clean explode).
  - drive per-part color already baked in via material name / vertex color
    (orange = active/claimed primitive emphasis on part_claim and
    part_fencing's newest tooth; teal = idle/primary elsewhere).

Run headless:
    blender --background --python tools/blender/gen_exploded_mechanism.py

Deterministic: only a seeded random.Random(SEED) is used, and only for the
fencing ratchet's tooth-count decoration (visual noise, not layout).
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh
import bpy
from mathutils import Vector
from common import PALETTE, apply_vertex_colors, export_glb, make_vertex_color_material, new_mesh_object, reset_scene

SEED = 4141

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "apps", "site", "public", "models")
OUT_PATH = os.path.join(OUT_DIR, "exploded-mechanism.glb")


def recenter_to_centroid(bm):
    """Move the bmesh so its own vertex centroid is at local origin, and
    return the world-space offset that was removed (== the assembled-state
    position the runtime should place the object at)."""
    if not bm.verts:
        return Vector((0, 0, 0))
    centroid = sum((v.co for v in bm.verts), Vector((0, 0, 0))) / len(bm.verts)
    for v in bm.verts:
        v.co -= centroid
    return centroid


def build_part_claim():
    """A hexagonal token: an extruded hex prism. Reads as a single, discrete,
    exclusively-held unit of work."""
    bm = bmesh.new()
    radius = 0.5
    height = 0.22
    bmesh.ops.create_circle(bm, cap_ends=True, cap_tris=False, segments=6, radius=radius)
    bm.faces.ensure_lookup_table()
    face = bm.faces[0]  # single hexagonal ngon cap
    geom = bmesh.ops.extrude_face_region(bm, geom=[face])
    extruded_verts = [g for g in geom["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=extruded_verts, vec=(0, 0, height))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    centroid = recenter_to_centroid(bm)
    obj = new_mesh_object("part_claim", bm)
    obj.location = centroid

    def color_fn(vert_idx, co):
        return PALETTE["orange"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material("part_claim_mat", PALETTE["orange"]))
    return obj


def build_part_fencing(rng):
    """A stepped ratchet disc: concentric rings of increasing radius, each
    ring one 'tooth' -- a monotonically increasing fencing token. The
    outermost (newest) tooth is colored orange to mark it as the currently
    valid token; older/inner rings are dim teal."""
    bm = bmesh.new()
    tooth_count = 6
    inner_radius = 0.16
    radius_step = 0.075
    tooth_height = 0.05
    segments = 10

    for tooth in range(tooth_count):
        r0 = inner_radius + tooth * radius_step
        r1 = r0 + radius_step * 0.82
        z0 = tooth * tooth_height * 0.35
        z1 = z0 + tooth_height

        ring = bmesh.ops.create_circle(bm, cap_ends=False, segments=segments, radius=r1)
        outer_verts = ring["verts"]
        for v in outer_verts:
            v.co.z = z0
        inner_verts = []
        for v in outer_verts:
            nv = bm.verts.new((v.co.x * (r0 / r1), v.co.y * (r0 / r1), z0))
            inner_verts.append(nv)
        bm.verts.ensure_lookup_table()

        n = len(outer_verts)
        bottom_faces = []
        for i in range(n):
            a, b = outer_verts[i], outer_verts[(i + 1) % n]
            c, d = inner_verts[(i + 1) % n], inner_verts[i]
            f = bm.faces.new((a, b, c, d))
            bottom_faces.append(f)

        top_geom = bmesh.ops.extrude_face_region(bm, geom=bottom_faces)
        top_verts = [g for g in top_geom["geom"] if isinstance(g, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, verts=top_verts, vec=(0, 0, z1 - z0))

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    centroid = recenter_to_centroid(bm)
    obj = new_mesh_object("part_fencing", bm)
    obj.location = centroid

    outer_edge = inner_radius + (tooth_count - 1) * radius_step

    def color_fn(vert_idx, co):
        # co is local (already recentered); compare radial distance to pick
        # the newest (outermost) tooth for the "currently valid token" hue.
        r = math.hypot(co.x, co.y)
        if r >= outer_edge - radius_step * 0.5:
            return PALETTE["orange"]
        return PALETTE["dim_teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material("part_fencing_mat", PALETTE["dim_teal"]))
    return obj


def build_part_lease():
    """A torus ring (the lease) with an inset core (the heartbeat pulse)."""
    bm = bmesh.new()
    major_radius = 0.55
    minor_radius = 0.07
    major_segments = 24
    minor_segments = 8
    for i in range(major_segments):
        theta = 2 * math.pi * i / major_segments
        cx, cy = math.cos(theta) * major_radius, math.sin(theta) * major_radius
        tangent = Vector((-math.sin(theta), math.cos(theta), 0))
        normal = Vector((math.cos(theta), math.sin(theta), 0))
        ring_verts = []
        for j in range(minor_segments):
            phi = 2 * math.pi * j / minor_segments
            offset = normal * (math.cos(phi) * minor_radius) + Vector((0, 0, math.sin(phi) * minor_radius))
            ring_verts.append(bm.verts.new((cx + offset.x, cy + offset.y, offset.z)))
    bm.verts.ensure_lookup_table()
    for i in range(major_segments):
        for j in range(minor_segments):
            a = i * minor_segments + j
            b = i * minor_segments + (j + 1) % minor_segments
            c = ((i + 1) % major_segments) * minor_segments + (j + 1) % minor_segments
            d = ((i + 1) % major_segments) * minor_segments + j
            bm.faces.new((bm.verts[a], bm.verts[b], bm.verts[c], bm.verts[d]))

    # Heartbeat core: small icosphere at the ring's center.
    core = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.14)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    centroid = recenter_to_centroid(bm)
    obj = new_mesh_object("part_lease", bm)
    obj.location = centroid

    def color_fn(vert_idx, co):
        r = math.hypot(co.x, co.y)
        if r < minor_radius * 2.5:  # the core
            return PALETTE["orange"]
        return PALETTE["teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material("part_lease_mat", PALETTE["teal"]))
    return obj


def build_part_eventlog():
    """A stack of thin rectangular plates: each plate one immutable,
    append-only log entry. Plates are offset upward, most-recent (top)
    plate colored orange, older entries dim teal -> reads as a ledger."""
    bm = bmesh.new()
    plate_count = 7
    plate_w, plate_d, plate_h = 0.62, 0.42, 0.045
    gap = 0.018

    for i in range(plate_count):
        z0 = i * (plate_h + gap)
        z1 = z0 + plate_h
        # slight inward taper per plate for a hand-stacked, non-uniform read
        shrink = 1.0 - (i * 0.01)
        w, d = plate_w * shrink, plate_d * shrink
        x0, x1 = -w / 2, w / 2
        y0, y1 = -d / 2, d / 2
        v = [
            bm.verts.new((x0, y0, z0)), bm.verts.new((x1, y0, z0)),
            bm.verts.new((x1, y1, z0)), bm.verts.new((x0, y1, z0)),
            bm.verts.new((x0, y0, z1)), bm.verts.new((x1, y0, z1)),
            bm.verts.new((x1, y1, z1)), bm.verts.new((x0, y1, z1)),
        ]
        faces = [
            (v[0], v[1], v[2], v[3]),
            (v[4], v[5], v[6], v[7]),
            (v[0], v[1], v[5], v[4]),
            (v[1], v[2], v[6], v[5]),
            (v[2], v[3], v[7], v[6]),
            (v[3], v[0], v[4], v[7]),
        ]
        for f in faces:
            bm.faces.new(f)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    centroid = recenter_to_centroid(bm)
    obj = new_mesh_object("part_eventlog", bm)
    obj.location = centroid

    top_z = ((plate_count - 1) * (plate_h + gap)) - centroid.z

    def color_fn(vert_idx, co):
        if co.z >= top_z - plate_h * 0.5:
            return PALETTE["orange"]
        return PALETTE["dim_teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material("part_eventlog_mat", PALETTE["dim_teal"]))
    return obj


def main():
    rng = random.Random(SEED)
    reset_scene()

    # Assembled layout: claim token centered above the ratchet, lease ring
    # around both, event-log stack offset to one side -- concentric enough
    # to read as "one mechanism", spread enough that an outward explode
    # along each part's own position vector separates cleanly.
    claim = build_part_claim()
    claim.location.z += 0.9

    fencing = build_part_fencing(rng)
    fencing.location.z += 0.0

    lease = build_part_lease()
    lease.location.z += 0.55

    eventlog = build_part_eventlog()
    eventlog.location.x += 1.15
    eventlog.location.z += -0.12

    parts = [claim, fencing, lease, eventlog]
    for p in parts:
        print(f"[part] {p.name} verts={len(p.data.vertices)} tris(approx)={len(p.data.polygons)}")

    export_glb(OUT_PATH, objects=parts, use_mesh_edges=False)


if __name__ == "__main__":
    main()
