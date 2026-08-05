"""
Generate the coordination-mesh lattice: a network of nodes + edges meant to
read as a purposeful coordination graph (agents + hub coordinators), not a
random point cloud, in the spirit of igloo.inc's scene-5 wireframe lattice.

Produces three LOD variants driven by the site's low/mid/high device-tier
system:
    mesh-lattice-low.glb   ~40  nodes  (phones / low tier)
    mesh-lattice-mid.glb   ~120 nodes  (mid tier)
    mesh-lattice-high.glb  ~320 nodes  (high tier / desktop)

Each .glb contains two mesh objects:
    lattice_nodes  - small icosahedra (12 verts/20 tris each) at each node
                     position, vertex-colored
                     orange (#FF6B35) for "hub" coordinator nodes and teal
                     (#4fd1c5) for regular agent nodes.
    lattice_edges  - a loose-edge (no faces) mesh exported as glTF LINES,
                     connecting each node to its nearest neighbors, with
                     denser connectivity around hub nodes so the structure
                     reads as hierarchical coordination rather than noise.

Run headless:
    blender --background --python tools/blender/gen_mesh_lattice.py

Deterministic: every random choice goes through random.Random(SEED), no
Blender operators with implicit randomness are used.
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh
import bpy
from common import PALETTE, apply_vertex_colors, export_glb, make_vertex_color_material, new_mesh_object, reset_scene

SEED = 1729

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "apps", "site", "public", "models")

# (name, node_count, neighbor_k, hub_count, hub_extra_links, node_radius, area, z_spread)
LOD_SPECS = [
    ("mesh-lattice-low", 40, 2, 3, 3, 0.045, 3.2, 0.5),
    ("mesh-lattice-mid", 120, 3, 6, 5, 0.032, 4.2, 0.65),
    ("mesh-lattice-high", 320, 3, 10, 7, 0.022, 5.4, 0.85),
]


def jittered_grid_positions(rng, count, area, z_spread):
    """Evenly-spaced-but-organic node layout: lay out a square-ish grid
    covering `area` x `area`, jitter each cell center, and jitter Z for a
    sense of depth. Deterministic given rng."""
    cols = max(1, math.ceil(math.sqrt(count)))
    rows = max(1, math.ceil(count / cols))
    cell = area / max(cols, rows)
    positions = []
    for i in range(count):
        col = i % cols
        row = i // cols
        cx = (col - cols / 2.0 + 0.5) * cell
        cy = (row - rows / 2.0 + 0.5) * cell
        jx = cx + rng.uniform(-0.4, 0.4) * cell
        jy = cy + rng.uniform(-0.4, 0.4) * cell
        jz = rng.uniform(-z_spread, z_spread) * 0.5
        positions.append((jx, jy, jz))
    return positions


def build_edges(rng, positions, k, hub_indices, hub_extra_links):
    n = len(positions)

    def dist(a, b):
        pa, pb = positions[a], positions[b]
        return math.dist(pa, pb)

    edge_set = set()

    # Base connectivity: every node links to its k nearest neighbors.
    for i in range(n):
        dists = sorted((dist(i, j), j) for j in range(n) if j != i)
        for _, j in dists[:k]:
            edge_set.add((min(i, j), max(i, j)))

    # Hub nodes get extra links to nearby non-hub nodes -> denser local
    # clusters that read as coordinators fanning work out to agents.
    for h in hub_indices:
        dists = sorted((dist(h, j), j) for j in range(n) if j != h)
        for _, j in dists[: k + hub_extra_links]:
            edge_set.add((min(h, j), max(h, j)))

    # Sparse long-range links between hubs themselves, so hubs read as an
    # interconnected coordination backbone rather than isolated stars.
    hubs_sorted = sorted(hub_indices)
    for a_idx in range(len(hubs_sorted)):
        b_idx = (a_idx + 1) % len(hubs_sorted)
        a, b = hubs_sorted[a_idx], hubs_sorted[b_idx]
        if a != b:
            edge_set.add((min(a, b), max(a, b)))

    return sorted(edge_set)


def build_node_mesh(name, positions, hub_indices, node_radius):
    bm = bmesh.new()
    hub_set = set(hub_indices)
    for idx, pos in enumerate(positions):
        r = node_radius * (1.6 if idx in hub_set else 1.0)
        seg = bmesh.ops.create_icosphere(bm, subdivisions=0, radius=r)
        verts = seg["verts"]
        for v in verts:
            v.co.x += pos[0]
            v.co.y += pos[1]
            v.co.z += pos[2]
    bm.verts.ensure_lookup_table()
    obj = new_mesh_object(name, bm)

    # icosphere(subdivisions=0) = 12 verts each, created in position order,
    # so integer-dividing the vertex index recovers which node it belongs to.
    verts_per_node = 12
    hub_set = set(hub_indices)

    def color_fn(vert_idx, co):
        node_idx = vert_idx // verts_per_node
        if node_idx in hub_set:
            return PALETTE["orange"]
        return PALETTE["teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material(f"{name}_mat", PALETTE["teal"]))
    return obj


def build_edge_mesh(name, positions, edges):
    bm = bmesh.new()
    bm_verts = [bm.verts.new(p) for p in positions]
    bm.verts.ensure_lookup_table()
    for a, b in edges:
        try:
            bm.edges.new((bm_verts[a], bm_verts[b]))
        except ValueError:
            pass  # duplicate edge, ignore
    obj = new_mesh_object(name, bm)

    def color_fn(vert_idx, co):
        return PALETTE["dim_teal"]

    apply_vertex_colors(obj.data, color_fn)
    obj.data.materials.append(make_vertex_color_material(f"{name}_mat", PALETTE["dim_teal"]))
    return obj


def generate(spec):
    name, count, k, hub_count, hub_extra_links, node_radius, area, z_spread = spec
    rng = random.Random(SEED)  # fresh, identical seed per LOD -> reproducible

    positions = jittered_grid_positions(rng, count, area, z_spread)
    hub_indices = sorted(rng.sample(range(count), min(hub_count, count)))
    edges = build_edges(rng, positions, k, hub_indices, hub_extra_links)

    reset_scene()
    nodes_obj = build_node_mesh("lattice_nodes", positions, hub_indices, node_radius)
    edges_obj = build_edge_mesh("lattice_edges", positions, edges)

    print(
        f"[{name}] nodes={count} hubs={len(hub_indices)} edges={len(edges)} "
        f"node_tris={20 * count} edge_segments={len(edges)}"
    )

    out_path = os.path.join(OUT_DIR, f"{name}.glb")
    export_glb(out_path, objects=[nodes_obj, edges_obj], use_mesh_edges=True)


def main():
    for spec in LOD_SPECS:
        generate(spec)


if __name__ == "__main__":
    main()
