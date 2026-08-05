"""
Shared helpers for Gitamesh Blender asset generators.

All generator scripts import this module. Since Blender's bundled Python
does not automatically see the repo on sys.path, each generator script
inserts its own directory (tools/blender/) before importing common.

Design rules enforced here (see tools/blender/README.md for the full brief):
  - Deterministic: every RNG call goes through a seeded random.Random instance
    that generator scripts create explicitly. No use of the global `random`
    module or Blender's non-deterministic operators (bpy.ops.mesh.primitive_*
    with 'random' options, particle systems, etc).
  - No textures/images: color comes from either vertex colors or plain
    (non-textured) material base color, so exports carry zero image payload.
  - +Y up, real-world-ish scale: handled by the glTF exporter's default
    export_yup=True, which converts Blender's Z-up to glTF's Y-up. We just
    need to build geometry in Blender's native Z-up space and let the
    exporter do the conversion.
"""

import bpy
import bmesh
import os


PALETTE = {
    "orange": (1.0, 0.4196, 0.2078, 1.0),      # #FF6B35 active/claimed
    "teal": (0.3098, 0.8196, 0.7725, 1.0),     # #4fd1c5 idle/primary
    "dim_teal": (0.1725, 0.3529, 0.3373, 1.0), # #2c5a56
    "black_1": (0.0196, 0.0275, 0.0392, 1.0),  # #05070a
    "black_2": (0.0510, 0.0706, 0.1020, 1.0),  # #0d121a
    "black_3": (0.1098, 0.1373, 0.1804, 1.0),  # #1c232e
}


def reset_scene():
    """Clear the default scene (cube/camera/light) down to nothing."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block_collection in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.objects,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for block in list(block_collection):
            block_collection.remove(block)


def make_vertex_color_material(name, base_color):
    """A plain, textureless material. If vertex colors are present on the
    mesh they drive appearance via the Color Attribute node; base_color is
    the fallback used by parts with no per-vertex variation."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    mat.use_backface_culling = False
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = base_color
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.55
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.05

        attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def apply_vertex_colors(mesh, color_fn):
    """color_fn(vertex_index, vertex_coord) -> (r, g, b, a). Writes a 'Col'
    color attribute (Blender 4/5 byte-color domain=CORNER) so it survives
    the glTF exporter's export_vertex_color path."""
    if "Col" in mesh.color_attributes:
        mesh.color_attributes.remove(mesh.color_attributes["Col"])
    col_attr = mesh.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    for loop in mesh.loops:
        v = mesh.vertices[loop.vertex_index]
        col_attr.data[loop.index].color = color_fn(loop.vertex_index, v.co)


def new_mesh_object(name, bm):
    """Build a bpy.types.Object from a bmesh and link it into the scene."""
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def export_glb(filepath, objects=None, use_mesh_edges=False):
    """Export objects (or the whole scene if objects is None) to a binary
    glTF (.glb), textures OFF, Draco OFF, +Y up (default)."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)

    bpy.ops.object.select_all(action="DESELECT")
    use_selection = objects is not None
    if objects:
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]

    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=use_selection,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        # NOTE: export_image_format="NONE" (no textures) makes the exporter
        # skip node-tree inspection entirely for base color, so
        # export_vertex_color="MATERIAL" silently drops vertex colors in
        # that mode. "ACTIVE" forces the mesh's active color attribute
        # ("Col", set up by apply_vertex_colors) to be exported as COLOR_0
        # regardless of the material node graph.
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=True,
        export_attributes=False,
        export_draco_mesh_compression_enable=False,
        use_mesh_edges=use_mesh_edges,
        use_mesh_vertices=False,
        export_lights=False,
        export_cameras=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
        export_original_specular=False,
        will_save_settings=False,
    )
    print(f"[export_glb] wrote {filepath} ({os.path.getsize(filepath)} bytes)")
