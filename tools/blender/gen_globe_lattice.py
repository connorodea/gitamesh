"""
Generate the GLOBE coordination lattice: a spherical mesh of agent nodes,
evenly distributed with a Fibonacci-sphere layout and connected by arcs that
hug the sphere's surface (spherical-linear-interpolated great-circle arcs,
not straight chords through the interior). This is the Act I "arrival" hero
asset for the odyssey concept (see GITAMESH_ODYSSEY_CONCEPT.md).

FISSION-READY: per the concept's "fission, flight, and telepathy" motion --
the globe is meant to visibly come apart into daughter globes in Act II --
each LOD is authored as SIX named shells (`shell_00` .. `shell_05`, one per
cube-face direction: +X/-X/+Y/-Y/+Z/-Z) rather than one monolithic mesh.
Each shell is a self-contained wedge of the sphere: its own nodes plus the
lattice edges that stay entirely within that wedge, combined into a single
mesh object with two glTF primitives (TRIANGLES for the node icosahedra,
LINES for the edges). The runtime can therefore address each shell by name
and fling it outward along its own centroid direction for the fission beat,
with no reparenting or mesh-splitting needed at runtime.

Edges that would cross between two shells are intentionally NOT authored
here -- at rest they'd be invisible seams anyway (adjacent wedges touch),
and once shells fly apart a straight authored edge would visibly tear. The
concept doc's "telepathic" links between separated globes are expected to
be runtime-generated (endpoints move every frame), optionally using
filament-segment.glb as their cross-section profile.

Produces three LOD variants for the site's low/mid/high device tiers:
    globe-lattice-low.glb   ~60  nodes  (phones / low tier)
    globe-lattice-mid.glb   ~160 nodes  (mid tier)
    globe-lattice-high.glb  ~420 nodes  (high tier / desktop)

Run headless:
    blender --background --python tools/blender/gen_globe_lattice.py

Deterministic: every random choice goes through random.Random(SEED); the
Fibonacci-sphere point placement and shell classification are fully
parametric (no RNG at all).
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh
import bpy
from common import PALETTE, apply_vertex_colors, export_glb, make_vertex_color_material, new_mesh_object, reset_scene

SEED = 8181

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "apps", "site", "public", "models")

GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))  # ~2.399963 rad

SHELL_NAMES = ["shell_00", "shell_01", "shell_02", "shell_03", "shell_04", "shell_05"]
# Index -> dominant world-space axis direction each shell wedge is centered on.
SHELL_AXES = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]

# (name, node_count, neighbor_k, hub_count, hub_extra_links, node_radius, sphere_radius, arc_segments)
LOD_SPECS = [
    ("globe-lattice-low", 60, 2, 4, 3, 0.05, 1.6, 4),
    ("globe-lattice-mid", 160, 3, 8, 4, 0.036, 1.8, 5),
    ("globe-lattice-high", 420, 3, 14, 6, 0.024, 2.0, 6),
]


def fibonacci_sphere(count, radius):
    """Evenly-spaced points over a sphere surface. Deterministic and
    parameter-only (no RNG) -- same technique already used by the site's
    flat constellation, per the concept brief."""
    points = []
    for i in range(count):
        y = 1.0 - (i / max(1, count - 1)) * 2.0  # 1 .. -1
        r_at_y = math.sqrt(max(0.0, 1.0 - y * y))
        theta = GOLDEN_ANGLE * i
        x = math.cos(theta) * r_at_y
        z = math.sin(theta) * r_at_y
        points.append((x * radius, z * radius, y * radius))
    return points


def classify_shell(pos):
    """Assign a point to one of six cube-face wedges by its dominant axis
    component. Fully deterministic given pos."""
    x, y, z = pos
    ax, ay, az = abs(x), abs(y), abs(z)
    if ax >= ay and ax >= az:
        return 0 if x >= 0 else 1
    if ay >= ax and ay >= az:
        return 2 if y >= 0 else 3
    return 4 if z >= 0 else 5


def build_edges(positions, k, hub_indices, hub_extra_links):
    n = len(positions)

    def dist(a, b):
        return math.dist(positions[a], positions[b])

    edge_set = set()

    for i in range(n):
        dists = sorted((dist(i, j), j) for j in range(n) if j != i)
        for _, j in dists[:k]:
            edge_set.add((min(i, j), max(i, j)))

    for h in hub_indices:
        dists = sorted((dist(h, j), j) for j in range(n) if j != h)
        for _, j in dists[: k + hub_extra_links]:
            edge_set.add((min(h, j), max(h, j)))

    hubs_sorted = sorted(hub_indices)
    for a_idx in range(len(hubs_sorted)):
        b_idx = (a_idx + 1) % len(hubs_sorted)
        a, b = hubs_sorted[a_idx], hubs_sorted[b_idx]
        if a != b:
            edge_set.add((min(a, b), max(a, b)))

    return sorted(edge_set)


def slerp(p0, p1, t, radius):
    """Spherical linear interpolation between two points that lie on a
    sphere of the given radius, so the interpolated arc hugs the surface
    instead of cutting a straight chord through the interior."""
    v0 = tuple(c / radius for c in p0)
    v1 = tuple(c / radius for c in p1)
    dot = max(-1.0, min(1.0, sum(a * b for a, b in zip(v0, v1))))
    omega = math.acos(dot)
    if omega < 1e-6:
        mixed = tuple((1 - t) * a + t * b for a, b in zip(v0, v1))
    else:
        s0 = math.sin((1 - t) * omega) / math.sin(omega)
        s1 = math.sin(t * omega) / math.sin(omega)
        mixed = tuple(s0 * a + s1 * b for a, b in zip(v0, v1))
    length = math.sqrt(sum(c * c for c in mixed)) or 1.0
    return tuple((c / length) * radius for c in mixed)


def build_shell_object(shell_name, node_indices, positions, hub_indices, node_radius,
                        edges, sphere_radius, arc_segments):
    """One shell = one bmesh holding both the node icosahedra (faces) and
    this shell's intra-wedge lattice edges (loose edges), so the glTF
    exporter emits a single mesh with a TRIANGLES primitive and a LINES
    primitive under one object name."""
    bm = bmesh.new()
    hub_set = set(hub_indices)
    node_set = set(node_indices)

    node_vert_ranges = {}  # node_idx -> (start_vert_count_before, count)
    for idx in node_indices:
        pos = positions[idx]
        r = node_radius * (1.7 if idx in hub_set else 1.0)
        start = len(bm.verts)
        seg = bmesh.ops.create_icosphere(bm, subdivisions=0, radius=r)
        for v in seg["verts"]:
            v.co.x += pos[0]
            v.co.y += pos[1]
            v.co.z += pos[2]
        node_vert_ranges[idx] = (start, len(bm.verts) - start)

    face_vert_count = len(bm.verts)

    intra_shell_edges = [
        (a, b) for (a, b) in edges if a in node_set and b in node_set
    ]
    for a, b in intra_shell_edges:
        p0, p1 = positions[a], positions[b]
        arc_verts = [
            bm.verts.new(slerp(p0, p1, t / arc_segments, sphere_radius))
            for t in range(arc_segments + 1)
        ]
        for i in range(arc_segments):
            try:
                bm.edges.new((arc_verts[i], arc_verts[i + 1]))
            except ValueError:
                pass

    bm.verts.ensure_lookup_table()
    obj = new_mesh_object(shell_name, bm)

    def color_fn(vert_idx, co):
        if vert_idx >= face_vert_count:
            return PALETTE["dim_teal"]  # edge geometry (no faces -> unused by exporter, kept for parity)
        for node_idx, (start, count) in node_vert_ranges.items():
            if start <= vert_idx < start + count:
                return PALETTE["orange"] if node_idx in hub_set else PALETTE["teal"]
        return PALETTE["teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material(f"{shell_name}_mat", PALETTE["teal"]))
    return obj, len(intra_shell_edges)


def generate(spec):
    name, count, k, hub_count, hub_extra_links, node_radius, sphere_radius, arc_segments = spec
    rng = random.Random(SEED)  # fresh, identical seed per LOD -> reproducible

    positions = fibonacci_sphere(count, sphere_radius)
    hub_indices = sorted(rng.sample(range(count), min(hub_count, count)))
    edges = build_edges(positions, k, hub_indices, hub_extra_links)

    shells = {i: [] for i in range(6)}
    for idx, pos in enumerate(positions):
        shells[classify_shell(pos)].append(idx)

    reset_scene()
    shell_objs = []
    total_intra_edges = 0
    for shell_idx in range(6):
        node_indices = shells[shell_idx]
        if not node_indices:
            continue
        obj, intra_edge_count = build_shell_object(
            SHELL_NAMES[shell_idx], node_indices, positions, hub_indices,
            node_radius, edges, sphere_radius, arc_segments,
        )
        shell_objs.append(obj)
        total_intra_edges += intra_edge_count

    dropped_edges = len(edges) - total_intra_edges
    print(
        f"[{name}] nodes={count} hubs={len(hub_indices)} shells={len(shell_objs)} "
        f"total_edges={len(edges)} intra_shell_edges={total_intra_edges} "
        f"cross_shell_edges_dropped={dropped_edges} node_tris={20 * count} "
        f"shell_sizes={[len(shells[i]) for i in range(6)]}"
    )

    out_path = os.path.join(OUT_DIR, f"{name}.glb")
    export_glb(out_path, objects=shell_objs, use_mesh_edges=True)


def main():
    for spec in LOD_SPECS:
        generate(spec)


if __name__ == "__main__":
    main()
