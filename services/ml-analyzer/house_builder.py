from __future__ import annotations

import math
from typing import Any

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals


PALETTES = {
    "سعودي حديث": {
        "wall": (0.86, 0.81, 0.72, 1.0),
        "accent": (0.30, 0.22, 0.16, 1.0),
        "stone": (0.55, 0.44, 0.31, 1.0),
        "floor": (0.72, 0.66, 0.57, 1.0),
        "glass": (0.18, 0.38, 0.46, 0.58),
    },
    "نجدي حديث": {
        "wall": (0.67, 0.51, 0.34, 1.0),
        "accent": (0.30, 0.20, 0.12, 1.0),
        "stone": (0.46, 0.32, 0.20, 1.0),
        "floor": (0.64, 0.52, 0.38, 1.0),
        "glass": (0.16, 0.33, 0.39, 0.58),
    },
    "حجازي حديث": {
        "wall": (0.86, 0.76, 0.61, 1.0),
        "accent": (0.12, 0.30, 0.38, 1.0),
        "stone": (0.54, 0.40, 0.26, 1.0),
        "floor": (0.72, 0.62, 0.48, 1.0),
        "glass": (0.12, 0.38, 0.49, 0.58),
    },
    "Minimal": {
        "wall": (0.90, 0.88, 0.84, 1.0),
        "accent": (0.24, 0.23, 0.21, 1.0),
        "stone": (0.64, 0.60, 0.55, 1.0),
        "floor": (0.77, 0.73, 0.67, 1.0),
        "glass": (0.20, 0.40, 0.48, 0.58),
    },
}


def material(name: str, rgba: tuple[float, float, float, float], roughness: float, metallic: float = 0.0):
    return PBRMaterial(
        name=name,
        baseColorFactor=np.array(rgba, dtype=np.float64),
        metallicFactor=metallic,
        roughnessFactor=roughness,
        alphaMode="BLEND" if rgba[3] < 0.999 else "OPAQUE",
        doubleSided=True,
    )


def box_mesh(extents, center, angle_y, mat):
    mesh = trimesh.creation.box(extents=np.asarray(extents, dtype=np.float64))
    rotation = trimesh.transformations.rotation_matrix(angle_y, [0.0, 1.0, 0.0])
    translation = trimesh.transformations.translation_matrix(center)
    mesh.apply_transform(translation @ rotation)
    mesh.visual = TextureVisuals(material=mat)
    return mesh


def add(scene: trimesh.Scene, name: str, mesh: trimesh.Trimesh):
    scene.add_geometry(mesh, node_name=name, geom_name=name)



def merge_scene_by_material(scene: trimesh.Scene) -> trimesh.Scene:
    buckets: dict[str, list[trimesh.Trimesh]] = {}
    materials: dict[str, Any] = {}

    for geometry in scene.geometry.values():
        if not isinstance(geometry, trimesh.Trimesh):
            continue
        mat = getattr(getattr(geometry, "visual", None), "material", None)
        name = getattr(mat, "name", None) or "default"
        buckets.setdefault(name, []).append(geometry)
        if name not in materials:
            materials[name] = mat

    merged_scene = trimesh.Scene()
    for name, meshes in buckets.items():
        if not meshes:
            continue
        merged = trimesh.util.concatenate(meshes)
        mat = materials.get(name)
        if mat is not None:
            merged.visual = TextureVisuals(material=mat)
        merged_scene.add_geometry(merged, node_name=name, geom_name=name)

    return merged_scene

def point_on_wall(wall: dict[str, Any], t: float, scale: float, cx: float, cy: float):
    ax = float(wall["a"]["x"]) * scale - cx
    az = float(wall["a"]["y"]) * scale - cy
    bx = float(wall["b"]["x"]) * scale - cx
    bz = float(wall["b"]["y"]) * scale - cy
    return ax + (bx - ax) * t, az + (bz - az) * t


def build_house_glb(payload: dict[str, Any]) -> bytes:
    walls = payload.get("walls") or []
    openings = payload.get("openings") or []
    if not walls:
        raise ValueError("walls are required")

    scale = float(payload.get("metersPerPixel") or 0.02)
    width_px = float((payload.get("imageSize") or {}).get("w") or 1200)
    height_px = float((payload.get("imageSize") or {}).get("h") or 800)
    wall_height = max(2.4, min(5.0, float(payload.get("wallHeight") or 3.2)))
    default_thickness = max(0.10, min(0.45, float(payload.get("wallThicknessM") or 0.20)))
    style = str(payload.get("style") or "سعودي حديث")
    exterior_wall_ids = {str(value) for value in (payload.get("exteriorWallIds") or [])}
    palette = PALETTES.get(style, PALETTES["سعودي حديث"])

    mats = {
        "wall": material("stucco", palette["wall"], 0.82),
        "accent": material("wood_metal", palette["accent"], 0.54, 0.08),
        "stone": material("stone", palette["stone"], 0.94),
        "floor": material("tile", palette["floor"], 0.80),
        "glass": material("glass", palette["glass"], 0.12, 0.05),
        "site": material("site_stone", (0.63, 0.58, 0.49, 1.0), 0.98),
        "drive": material("driveway", (0.23, 0.24, 0.24, 1.0), 0.98),
        "grass": material("grass", (0.25, 0.43, 0.23, 1.0), 1.0),
        "white": material("white_detail", (0.93, 0.91, 0.87, 1.0), 0.80),
    }

    cx = width_px * scale / 2.0
    cy = height_px * scale / 2.0
    scene = trimesh.Scene()

    openings_by_wall: dict[str, list[dict[str, Any]]] = {}
    for opening in openings:
        openings_by_wall.setdefault(str(opening.get("wallId")), []).append(opening)

    wall_counter = 0
    for wall in walls:
        ax = float(wall["a"]["x"]) * scale - cx
        az = float(wall["a"]["y"]) * scale - cy
        bx = float(wall["b"]["x"]) * scale - cx
        bz = float(wall["b"]["y"]) * scale - cy
        dx, dz = bx - ax, bz - az
        length = math.hypot(dx, dz)
        if length < 0.08:
            continue

        angle = -math.atan2(dz, dx)
        ux, uz = dx / length, dz / length
        raw_thickness = float(wall.get("thickness") or 0)
        thickness = raw_thickness * scale if raw_thickness > 0 else default_thickness
        thickness = max(0.10, min(0.45, thickness))

        hosted = sorted(openings_by_wall.get(str(wall.get("id")), []), key=lambda item: float(item.get("centerT", 0.5)))
        cursor = 0.0

        def wall_box(start: float, end: float, bottom: float, top: float, mat_key="wall"):
            nonlocal wall_counter
            segment = end - start
            height = top - bottom
            if segment <= 0.03 or height <= 0.03:
                return
            mid = (start + end) / 2
            x, z = ax + ux * mid, az + uz * mid
            mesh = box_mesh([segment, height, thickness], [x, bottom + height / 2, z], angle, mats[mat_key])
            add(scene, f"wall_{wall_counter}", mesh)
            wall_counter += 1

        for opening in hosted:
            center = max(0.0, min(1.0, float(opening.get("centerT", 0.5)))) * length
            opening_width = max(0.55, min(3.2, float(opening.get("widthM", 0.95))))
            start = max(cursor, center - opening_width / 2)
            end = min(length, center + opening_width / 2)
            if start > cursor:
                wall_box(cursor, start, 0.0, wall_height)

            sill = max(0.0, min(wall_height, float(opening.get("sillM", 0.0))))
            opening_height = max(0.5, min(wall_height, float(opening.get("heightM", 2.2))))
            top = min(wall_height, sill + opening_height)
            if sill > 0.02:
                wall_box(start, end, 0.0, sill)
            if top < wall_height - 0.02:
                wall_box(start, end, top, wall_height)

            x, z = ax + ux * ((start + end) / 2), az + uz * ((start + end) / 2)
            actual_width = max(0.05, end - start)
            if opening.get("kind") == "window":
                glass = box_mesh(
                    [actual_width * 0.91, max(0.30, opening_height * 0.88), max(0.035, thickness * 0.15)],
                    [x, sill + opening_height / 2, z],
                    angle,
                    mats["glass"],
                )
                add(scene, f"glass_{wall_counter}", glass)
                for yy in (sill + 0.035, top - 0.035):
                    frame = box_mesh([actual_width, 0.07, thickness + 0.035], [x, yy, z], angle, mats["accent"])
                    add(scene, f"window_frame_{wall_counter}_{yy}", frame)
            else:
                door = box_mesh(
                    [actual_width * 0.92, max(0.4, opening_height * 0.95), max(0.045, thickness * 0.16)],
                    [x, opening_height / 2, z],
                    angle,
                    mats["accent"],
                )
                add(scene, f"door_{wall_counter}", door)
            cursor = max(cursor, end)

        if cursor < length:
            wall_box(cursor, length, 0.0, wall_height)

        # Exterior facade treatment only; never decorate internal partitions.
        if str(wall.get("id")) in exterior_wall_ids:
            band = box_mesh(
                [length, 0.085, thickness + 0.035],
                [(ax + bx) / 2, wall_height - 0.09, (az + bz) / 2],
                angle,
                mats["accent"],
            )
            add(scene, f"band_{wall_counter}", band)

            cladding_len = min(1.10, length * 0.22)
            if cladding_len > 0.55:
                x, z = ax + ux * (cladding_len / 2), az + uz * (cladding_len / 2)
                cladding = box_mesh(
                    [cladding_len, wall_height * 0.62, thickness + 0.025],
                    [x, wall_height * 0.31, z],
                    angle,
                    mats["stone"],
                )
                add(scene, f"cladding_{wall_counter}", cladding)

    xs = []
    zs = []
    for wall in walls:
        for key in ("a", "b"):
            xs.append(float(wall[key]["x"]) * scale - cx)
            zs.append(float(wall[key]["y"]) * scale - cy)

    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    house_w = max(3.0, max_x - min_x)
    house_d = max(3.0, max_z - min_z)
    house_cx = (min_x + max_x) / 2
    house_cz = (min_z + max_z) / 2

    slab = box_mesh([house_w + 0.18, 0.10, house_d + 0.18], [house_cx, 0.05, house_cz], 0, mats["floor"])
    add(scene, "ground_floor", slab)
    # Interactive inspection stays open from above; parapet preserves the exterior silhouette.
    # Parapet frame.
    parapet_h = 0.55
    for name, extents, center in (
        ("parapet_n", [house_w + 0.38, parapet_h, 0.16], [house_cx, wall_height + parapet_h / 2 + 0.16, min_z - 0.11]),
        ("parapet_s", [house_w + 0.38, parapet_h, 0.16], [house_cx, wall_height + parapet_h / 2 + 0.16, max_z + 0.11]),
        ("parapet_w", [0.16, parapet_h, house_d + 0.38], [min_x - 0.11, wall_height + parapet_h / 2 + 0.16, house_cz]),
        ("parapet_e", [0.16, parapet_h, house_d + 0.38], [max_x + 0.11, wall_height + parapet_h / 2 + 0.16, house_cz]),
    ):
        add(scene, name, box_mesh(extents, center, 0, mats["wall"]))

    site_w, site_d = house_w + 7.0, house_d + 7.0
    add(scene, "site", box_mesh([site_w, 0.08, site_d], [house_cx, -0.04, house_cz], 0, mats["site"]))
    driveway_w = max(3.4, min(5.5, house_w * 0.28))
    add(scene, "driveway", box_mesh([driveway_w, 0.035, site_d], [house_cx + house_w * 0.34, 0.018, house_cz], 0, mats["drive"]))
    add(scene, "garden", box_mesh([max(2.2, house_w * 0.22), 0.04, max(3.0, house_d * 0.50)], [house_cx - house_w * 0.36, 0.02, house_cz - house_d * 0.15], 0, mats["grass"]))

    boundary_h = 1.8
    for name, extents, center in (
        ("boundary_n", [site_w, boundary_h, 0.18], [house_cx, boundary_h / 2, house_cz - site_d / 2]),
        ("boundary_s", [site_w, boundary_h, 0.18], [house_cx, boundary_h / 2, house_cz + site_d / 2]),
        ("boundary_w", [0.18, boundary_h, site_d], [house_cx - site_w / 2, boundary_h / 2, house_cz]),
        ("boundary_e", [0.18, boundary_h, site_d], [house_cx + site_w / 2, boundary_h / 2, house_cz]),
    ):
        add(scene, name, box_mesh(extents, center, 0, mats["stone"]))

    # Main entrance canopy, portal and gate.
    front_z = max_z + 0.55
    portal_x = house_cx
    add(scene, "entrance_step", box_mesh([3.2, 0.16, 1.6], [portal_x, 0.08, front_z], 0, mats["stone"]))
    add(scene, "entrance_canopy", box_mesh([3.5, 0.18, 1.45], [portal_x, 2.72, front_z], 0, mats["accent"]))
    add(scene, "portal_left", box_mesh([0.22, 2.85, 0.32], [portal_x - 1.62, 1.43, front_z], 0, mats["accent"]))
    add(scene, "portal_right", box_mesh([0.22, 2.85, 0.32], [portal_x + 1.62, 1.43, front_z], 0, mats["accent"]))
    gate_z = house_cz + site_d / 2 - 0.04
    add(scene, "vehicle_gate", box_mesh([3.8, 1.55, 0.09], [house_cx + house_w * 0.30, 0.78, gate_z], 0, mats["accent"]))

    optimized = merge_scene_by_material(scene)
    return optimized.export(file_type="glb")
