# Gitamesh Blender asset pipeline

Headless, deterministic Python generators for gitamesh.com's 3D assets, targeting
the "Odyssey" three-act concept (globe of coordinating agents -> fission into
daughter globes -> exploded mechanism -> time corridor). All output is plain
glTF 2.0 binary (`.glb`), geometry + vertex colors only, no textures/image maps,
Draco off. Files are written directly into `apps/site/public/models/` so
`useGLTF` can fetch them as static assets from the Next.js static export.

Environment: Blender 5.2.0 LTS, invoked headless. `bpy`/`bmesh` only; no add-ons
beyond the bundled `io_scene_gltf2` exporter.

## Regenerate everything

Run from the repo root. Each script is independent and idempotent — safe to
re-run individually after tweaking one asset.

```bash
blender --background --python tools/blender/gen_globe_lattice.py
blender --background --python tools/blender/gen_globe_daughter.py
blender --background --python tools/blender/gen_exploded_mechanism.py
blender --background --python tools/blender/gen_time_ring.py
blender --background --python tools/blender/gen_filament_segment.py
blender --background --python tools/blender/gen_agent_node.py
blender --background --python tools/blender/gen_mesh_lattice.py
```

If `blender` isn't on `PATH`, use the full binary path:
`/Applications/Blender.app/Contents/MacOS/Blender`.

## Assets, in priority order

| Script | Output | Act | Purpose |
|---|---|---|---|
| `gen_globe_lattice.py` | `globe-lattice-{low,mid,high}.glb` | I / II | Hero globe: Fibonacci-sphere node lattice, surface-hugging (slerp'd) arcs, authored as **six named shells** (`shell_00`..`shell_05`) so the runtime can fling them apart for the fission beat with no runtime mesh-splitting. |
| `gen_globe_daughter.py` | `globe-daughter.glb` | II / III | Small single-mesh globe (same visual language, no shell split) designed to be instanced 30-50x simultaneously as the fission daughters. |
| `gen_exploded_mechanism.py` | `exploded-mechanism.glb` | II | The four coordination primitives as individually-named, individually-explodable parts. |
| `gen_time_ring.py` | `time-ring.glb` | III | One stratum of the event-log corridor; instance many, receding along Z. |
| `gen_filament_segment.py` | `filament-segment.glb` | II / III | Optional nicer cross-section for the runtime-built "telepathic" links between separated globes (endpoints move every frame, so the link itself is built at runtime — this is just the tube profile). |
| `gen_agent_node.py` | `agent-node.glb` | I | Standalone low-poly node module (more character than `sphereGeometry`) for contexts that need a single instanced unit outside the globe/daughter meshes. |
| `gen_mesh_lattice.py` | `mesh-lattice-{low,mid,high}.glb` | III (background strata) | The original flat/scattered constellation lattice. Superseded as the Act I hero by the globe, kept as reusable background geometry (e.g. corridor walls, transitional cross-fades). |

`common.py` holds shared helpers (scene reset, vertex-color material setup,
deterministic-safe glTF export wrapper) that every generator script imports.

## Determinism

Every generator seeds its own `random.Random(SEED)` instance — no script reads
Blender's or Python's global RNG state, and geometry that doesn't need
randomness (Fibonacci-sphere placement, shell classification, arc
interpolation, the exploded-mechanism part shapes) is fully parametric with no
RNG calls at all. Re-running a script with the same Blender version produces
mesh data with identical vertex/index counts, positions, and colors every time.

**Known caveat:** the exported `.glb` files are not always **byte-identical**
across repeated runs on this machine — a few hundred bytes differ inside the
binary buffer chunk (confirmed via `cmp`), while the JSON chunk (accessor
layout, node/mesh/material structure, attribute counts) is identical every
run. This traces to Blender's own glTF exporter internals (buffer packing /
attribute interleaving order), not to anything in these scripts — it persists
even with `PYTHONHASHSEED=0` forced. The **content** is reproducible (same
verts, same triangles, same colors, same file size); the **raw bytes** are
reproducible up to exporter-internal ordering. If true byte-for-byte
reproducibility becomes a requirement, the fix would live upstream in
`io_scene_gltf2`, not in these generator scripts.

## Coordinate + naming conventions for the implementing agent

- **+Y up**, real-world-ish scale (globe radii ~1.6-2.0 units, daughter ~0.7,
  exploded-mechanism parts ~0.5-1.2 units across). Blender authors in its
  native Z-up space; the glTF exporter's default `export_yup=True` does the
  Z-up -> Y-up conversion, so no runtime correction transform is needed.
- **Vertex colors, not materials, carry per-instance semantics.** Every mesh's
  `COLOR_0` attribute encodes orange (`#FF6B35`, active/claimed/hub) vs. teal
  (`#4fd1c5`, idle/primary) vs. dim teal (`#2c5a56`, dormant). Line-mode
  (edge/arc) primitives don't carry `COLOR_0` (glTF corner-domain colors need
  faces/loops, which loose edges don't have) — their material's flat
  `baseColorFactor` already encodes the intended color as a fallback.
- **Globe shells** (`shell_00`..`shell_05`): partitioned by dominant world
  axis (+X/-X/+Y/-Y/+Z/-Z). Each shell's lattice edges are intra-shell only —
  edges that would have crossed two shells are dropped at author time (kept
  count logged by the generator as `cross_shell_edges_dropped`) so a shell can
  be flung outward as a rigid unit without visibly tearing a line across the
  gap. Cross-shell connectivity (the "telepathic" links in Act III) is
  expected to be runtime-generated, since its endpoints move every frame.
- **Exploded-mechanism parts** (`part_claim`, `part_fencing`, `part_lease`,
  `part_eventlog`): each part's mesh origin is set to its own vertex
  centroid, and the *object* is placed at the assembled-state world position.
  A runtime explode = offset each part outward from its own object-space
  origin (e.g. along its assembled position vector) — no need to recompute a
  centroid at runtime.
- **LOD swap thresholds:** no hard rule authored here since device-tier
  logic lives in the app; as a starting point, match the existing low/mid/high
  device-tier gates already in `apps/site/lib` (mirrors the pattern the
  flat lattice was built to slot into). The daughter globe and time-ring are
  single-LOD by design (they're cheap because of instancing, not because of a
  reduced-detail variant).

## Size budget results (see the top-level report for the full table)

All high-tier assets are comfortably under the 2 MB ceiling and all low-tier
assets are well under the 300 KB ceiling — see per-file byte sizes and
triangle/line counts in the delivery report. `globe-lattice-high.glb` is the
largest single asset at well under 1 MB.
