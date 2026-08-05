"""
Generate the DAUGHTER globe: a small, low-poly instance of the same globe
lattice visual language (Fibonacci-sphere node placement, slerp'd
surface-hugging arcs) as gen_globe_lattice.py's main globe, but designed to
be instanced dozens of times simultaneously for the Act II/III "fission"
beat ("the large globe is being broken into smaller globes ... flying
around the universe in sync but sporadically" -- GITAMESH_ODYSSEY_CONCEPT.md).

Deliberately NOT shell-segmented (unlike the main globe) -- a daughter is
the thing a shell becomes after it separates and re-forms, so it is
authored as a single self-contained mesh (globe_daughter_nodes +
globe_daughter_edges), ready to be instanced directly with
three.js/InstancedMesh or drei's <Merged>/<Instances>.

Poly budget rationale: designed for 30-50 simultaneous on-screen instances
on a mid-tier laptop. At 18 nodes x 20 tris/icosahedron = 360 tris plus
~20 logical edges x 3 arc segments = 60 line segments, a single daughter
is a few hundred vertices. Fifty instances is on the order of 18,000
triangles total for the daughter swarm -- trivial next to the exploded
mechanism or a single high-LOD main globe, and well within an instanced
draw call's budget.

Run headless:
    blender --background --python tools/blender/gen_globe_daughter.py

Deterministic: random.Random(SEED) only picks hub indices; Fibonacci-sphere
placement and arc interpolation are fully parametric.
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh
import bpy
from common import PALETTE, apply_vertex_colors, export_glb, make_vertex_color_material, new_mesh_object, reset_scene

SEED = 5252

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "apps", "site", "public", "models")
OUT_PATH = os.path.join(OUT_DIR, "globe-daughter.glb")

GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))

NODE_COUNT = 18
NEIGHBOR_K = 2
HUB_COUNT = 1
HUB_EXTRA_LINKS = 2
NODE_RADIUS = 0.09
SPHERE_RADIUS = 0.7   # ~1/2.5 the smallest main-globe LOD radius (1.6) -> visually reads as "a smaller one of those"
ARC_SEGMENTS = 3       # keep arcs cheap; instanced dozens of times


def fibonacci_sphere(count, radius):
    points = []
    for i in range(count):
        y = 1.0 - (i / max(1, count - 1)) * 2.0
        r_at_y = math.sqrt(max(0.0, 1.0 - y * y))
        theta = GOLDEN_ANGLE * i
        x = math.cos(theta) * r_at_y
        z = math.sin(theta) * r_at_y
        points.append((x * radius, z * radius, y * radius))
    return points


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
    return sorted(edge_set)


def slerp(p0, p1, t, radius):
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


def build_node_mesh(name, positions, hub_indices, node_radius):
    bm = bmesh.new()
    hub_set = set(hub_indices)
    for idx, pos in enumerate(positions):
        r = node_radius * (1.7 if idx in hub_set else 1.0)
        seg = bmesh.ops.create_icosphere(bm, subdivisions=0, radius=r)
        for v in seg["verts"]:
            v.co.x += pos[0]
            v.co.y += pos[1]
            v.co.z += pos[2]
    bm.verts.ensure_lookup_table()
    obj = new_mesh_object(name, bm)

    verts_per_node = 12

    def color_fn(vert_idx, co):
        node_idx = vert_idx // verts_per_node
        return PALETTE["orange"] if node_idx in hub_set else PALETTE["teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material(f"{name}_mat", PALETTE["teal"]))
    return obj


def build_edge_mesh(name, positions, edges, sphere_radius, arc_segments):
    bm = bmesh.new()
    for a, b in edges:
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
    obj = new_mesh_object(name, bm)

    def color_fn(vert_idx, co):
        return PALETTE["dim_teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material(f"{name}_mat", PALETTE["dim_teal"]))
    return obj


def main():
    rng = random.Random(SEED)
    reset_scene()

    positions = fibonacci_sphere(NODE_COUNT, SPHERE_RADIUS)
    hub_indices = sorted(rng.sample(range(NODE_COUNT), min(HUB_COUNT, NODE_COUNT)))
    edges = build_edges(positions, NEIGHBOR_K, hub_indices, HUB_EXTRA_LINKS)

    nodes_obj = build_node_mesh("globe_daughter_nodes", positions, hub_indices, NODE_RADIUS)
    edges_obj = build_edge_mesh("globe_daughter_edges", positions, edges, SPHERE_RADIUS, ARC_SEGMENTS)

    print(
        f"[globe-daughter] nodes={NODE_COUNT} hubs={len(hub_indices)} edges={len(edges)} "
        f"node_tris={20 * NODE_COUNT} edge_line_segments={len(edges) * ARC_SEGMENTS} "
        f"designed_for_instances=30-50"
    )

    export_glb(OUT_PATH, objects=[nodes_obj, edges_obj], use_mesh_edges=True)


if __name__ == "__main__":
    main()
