from __future__ import annotations

import io
import math
import random
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

STYLES = {
    "سعودي حديث": {
        "wall": (232, 226, 216),
        "stone": (176, 151, 120),
        "wood": (95, 67, 47),
        "glass": (91, 140, 160),
        "accent": (73, 66, 59),
        "floor": (216, 205, 191),
        "fabric": (154, 143, 130),
        "green": (78, 111, 67),
    },
    "نجدي حديث": {
        "wall": (218, 195, 164),
        "stone": (157, 118, 82),
        "wood": (86, 58, 40),
        "glass": (72, 119, 137),
        "accent": (83, 59, 41),
        "floor": (205, 183, 155),
        "fabric": (145, 123, 102),
        "green": (74, 103, 62),
    },
    "حجازي حديث": {
        "wall": (241, 229, 210),
        "stone": (190, 151, 109),
        "wood": (93, 60, 42),
        "glass": (67, 125, 150),
        "accent": (50, 88, 104),
        "floor": (220, 202, 178),
        "fabric": (156, 140, 122),
        "green": (76, 111, 68),
    },
    "مودرن فاخر": {
        "wall": (232, 231, 228),
        "stone": (178, 174, 168),
        "wood": (76, 63, 54),
        "glass": (72, 115, 133),
        "accent": (46, 46, 46),
        "floor": (214, 210, 204),
        "fabric": (132, 128, 124),
        "green": (68, 102, 63),
    },
}


def palette(name: str) -> dict[str, tuple[int, int, int]]:
    return STYLES.get(name, STYLES["سعودي حديث"])


def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def bounds(walls):
    xs, ys = [], []
    for wall in walls:
        for key in ("a", "b"):
            xs.append(float(wall[key]["x"]))
            ys.append(float(wall[key]["y"]))
    return (min(xs), min(ys), max(xs), max(ys)) if xs else (0.0, 0.0, 1.0, 1.0)


def room_bounds(room):
    cells = room.get("cells") or []
    if not cells:
        return None
    return (
        min(float(c["x1"]) for c in cells),
        min(float(c["y1"]) for c in cells),
        max(float(c["x2"]) for c in cells),
        max(float(c["y2"]) for c in cells),
    )


def gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line((0, y, w, y), fill=mix(top, bottom, t))
    return img


def add_soft_glow(img, center, radius, color, alpha):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x, y = center
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(radius // 2))
    return Image.alpha_composite(img.convert("RGBA"), layer)


def project_iso(xm, zm, ym, cx, cz, scale, origin_x, origin_y):
    x = xm - cx
    z = zm - cz
    px = origin_x + (x - z) * scale * 0.86
    py = origin_y + (x + z) * scale * 0.43 - ym * scale
    return (px, py)


def draw_iso_box(draw, center, size, height, proj, top_color, side_color, edge=(80, 72, 65)):
    cx, cz = center
    sx, sz = size
    y0 = 0.0
    y1 = height
    pts0 = [
        proj(cx - sx / 2, cz - sz / 2, y0),
        proj(cx + sx / 2, cz - sz / 2, y0),
        proj(cx + sx / 2, cz + sz / 2, y0),
        proj(cx - sx / 2, cz + sz / 2, y0),
    ]
    pts1 = [
        proj(cx - sx / 2, cz - sz / 2, y1),
        proj(cx + sx / 2, cz - sz / 2, y1),
        proj(cx + sx / 2, cz + sz / 2, y1),
        proj(cx - sx / 2, cz + sz / 2, y1),
    ]
    draw.polygon([pts0[1], pts0[2], pts1[2], pts1[1]], fill=mix(side_color, (0, 0, 0), .08))
    draw.polygon([pts0[2], pts0[3], pts1[3], pts1[2]], fill=mix(side_color, (0, 0, 0), .16))
    draw.polygon(pts1, fill=top_color, outline=edge)


def render_interior(payload: dict[str, Any], size: int = 1536) -> bytes:
    p = palette(str(payload.get("style") or "سعودي حديث"))
    walls = payload.get("walls") or []
    rooms = payload.get("rooms") or []
    openings = payload.get("openings") or []
    furnishing = str(payload.get("furnishing") or "full")
    if not walls:
        raise ValueError("walls are required")

    mpp = float(payload.get("metersPerPixel") or 0.02)
    wall_h = clamp(float(payload.get("wallHeight") or 3.2), 2.4, 4.5)
    minx, minz, maxx, maxz = bounds(walls)
    cx_px, cz_px = (minx + maxx) / 2, (minz + maxz) / 2
    house_w = max(1.0, (maxx - minx) * mpp)
    house_d = max(1.0, (maxz - minz) * mpp)
    scale = min(size * 0.46 / max(house_w, 1.0), size * 0.34 / max(house_d, 1.0))
    scale = clamp(scale, 30, 115)
    origin_x = size * 0.50
    origin_y = size * 0.66

    def proj_px(x, z, y=0.0):
        return project_iso((x - cx_px) * mpp, (z - cz_px) * mpp, y, 0.0, 0.0, scale, origin_x, origin_y)

    img = gradient((size, size), (241, 239, 234), (211, 204, 194)).convert("RGBA")

    # Large soft floor shadow for depth.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    footprint = [
        proj_px(minx, minz),
        proj_px(maxx, minz),
        proj_px(maxx, maxz),
        proj_px(minx, maxz),
    ]
    sd.polygon([(x + 24, y + 30) for x, y in footprint], fill=(0, 0, 0, 74))
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    img = Image.alpha_composite(img, shadow)
    draw = ImageDraw.Draw(img)

    # Architectural floor plates.
    for i, room in enumerate(rooms):
        rb = room_bounds(room)
        if not rb:
            continue
        x1, z1, x2, z2 = rb
        poly = [proj_px(x1, z1), proj_px(x2, z1), proj_px(x2, z2), proj_px(x1, z2)]
        floor_col = mix(p["floor"], (255, 255, 255), .08 if i % 2 else .16)
        draw.polygon(poly, fill=floor_col, outline=mix(floor_col, (80, 70, 60), .16))

        # subtle tile seams
        if i < 12:
            for t in (.33, .66):
                ax = x1 + (x2 - x1) * t
                a = proj_px(ax, z1)
                b = proj_px(ax, z2)
                draw.line((*a, *b), fill=mix(floor_col, (120, 110, 100), .10), width=2)

    # Furniture blocks sorted behind walls.
    if furnishing != "none":
        limit = 16 if furnishing == "full" else 8
        room_data = []
        for i, room in enumerate(rooms[:limit]):
            rb = room_bounds(room)
            if not rb:
                continue
            x1, z1, x2, z2 = rb
            xm1, zm1 = (x1 - cx_px) * mpp, (z1 - cz_px) * mpp
            xm2, zm2 = (x2 - cx_px) * mpp, (z2 - cz_px) * mpp
            room_data.append((xm1 + zm1 + xm2 + zm2, i, room, xm1, zm1, xm2, zm2))
        room_data.sort()

        for _, i, room, x1, z1, x2, z2 in room_data:
            rw, rd = x2 - x1, z2 - z1
            if rw < 1.3 or rd < 1.3:
                continue
            rx, rz = (x1 + x2) / 2, (z1 + z2) / 2
            name = str(room.get("name") or "")
            if "نوم" in name or "bed" in name.lower() or i % 5 in (0, 1):
                sx, sz, hh = min(1.8, rw * .48), min(2.0, rd * .55), .42
                top = mix((236, 231, 224), p["fabric"], .25)
                draw_iso_box(draw, (rx, rz), (sx, sz), hh, lambda x, z, y: project_iso(x, z, y, 0, 0, scale, origin_x, origin_y), top, p["fabric"])
                # headboard
                if rd > 1.8:
                    draw_iso_box(draw, (rx, rz - sz * .46), (sx, .12), .95, lambda x, z, y: project_iso(x, z, y, 0, 0, scale, origin_x, origin_y), p["wood"], p["wood"])
            elif "مطبخ" in name or "kitchen" in name.lower() or i % 5 == 2:
                sx = min(2.2, rw * .58)
                draw_iso_box(draw, (rx, z1 + min(.48, rd * .20)), (sx, .62), .92, lambda x, z, y: project_iso(x, z, y, 0, 0, scale, origin_x, origin_y), mix(p["stone"], (245,245,240), .18), p["wood"])
            else:
                sx = min(2.1, rw * .54)
                draw_iso_box(draw, (rx, rz), (sx, min(.82, rd * .24)), .68, lambda x, z, y: project_iso(x, z, y, 0, 0, scale, origin_x, origin_y), mix(p["fabric"], (235,230,222), .12), p["fabric"])
                draw_iso_box(draw, (rx, rz + min(.70, rd * .28)), (min(.95, rw * .28), min(.58, rd * .18)), .34, lambda x, z, y: project_iso(x, z, y, 0, 0, scale, origin_x, origin_y), p["wood"], p["wood"])

    # Walls: draw vertical architectural faces from back to front.
    wall_sorted = sorted(
        walls,
        key=lambda w: (
            ((float(w["a"]["x"]) + float(w["b"]["x"])) / 2 - cx_px) * mpp
            + ((float(w["a"]["y"]) + float(w["b"]["y"])) / 2 - cz_px) * mpp
        ),
    )

    for wall in wall_sorted:
        ax, az = float(wall["a"]["x"]), float(wall["a"]["y"])
        bx, bz = float(wall["b"]["x"]), float(wall["b"]["y"])
        p0 = proj_px(ax, az, 0)
        p1 = proj_px(bx, bz, 0)
        p2 = proj_px(bx, bz, wall_h)
        p3 = proj_px(ax, az, wall_h)
        dx, dz = bx - ax, bz - az
        face_t = .07 if abs(dx) >= abs(dz) else .15
        face = mix(p["wall"], (0, 0, 0), face_t)

        # wall shadow
        draw.polygon([(x + 7, y + 10) for x, y in (p0, p1, p2, p3)], fill=(0, 0, 0, 34))
        draw.polygon([p0, p1, p2, p3], fill=face, outline=mix(face, (75, 68, 62), .18))
        draw.line((*p3, *p2), fill=mix(p["wall"], (255,255,255), .55), width=4)

    # Openings over wall faces.
    by_id = {str(w.get("id")): w for w in walls}
    for opening in openings:
        wall = by_id.get(str(opening.get("wallId")))
        if not wall:
            continue
        ax, az = float(wall["a"]["x"]), float(wall["a"]["y"])
        bx, bz = float(wall["b"]["x"]), float(wall["b"]["y"])
        dx, dz = bx - ax, bz - az
        length_px = max(1e-6, math.hypot(dx, dz))
        ux, uz = dx / length_px, dz / length_px
        center_t = clamp(float(opening.get("centerT", .5)), 0.0, 1.0)
        width_m = clamp(float(opening.get("widthM", 1.0)), .55, 3.2)
        width_px = width_m / max(mpp, 1e-6)
        center_x = ax + dx * center_t
        center_z = az + dz * center_t
        sx, sz = center_x - ux * width_px / 2, center_z - uz * width_px / 2
        ex, ez = center_x + ux * width_px / 2, center_z + uz * width_px / 2
        sill = clamp(float(opening.get("sillM", 0.0)), 0.0, wall_h - .2)
        oh = clamp(float(opening.get("heightM", 2.1)), .45, wall_h - sill)
        q0, q1 = proj_px(sx, sz, sill), proj_px(ex, ez, sill)
        q2, q3 = proj_px(ex, ez, sill + oh), proj_px(sx, sz, sill + oh)
        if opening.get("kind") == "window":
            draw.polygon([q0, q1, q2, q3], fill=mix(p["glass"], (210,235,244), .22), outline=(55, 67, 72))
            draw.line((*q0, *q2), fill=(82, 95, 100), width=2)
        else:
            draw.polygon([q0, q1, q2, q3], fill=p["wood"], outline=mix(p["wood"], (0,0,0), .28))

    # Presentation lighting.
    img = add_soft_glow(img, (int(size * .20), int(size * .16)), int(size * .22), (255, 224, 174), 46)
    img = add_soft_glow(img, (int(size * .82), int(size * .52)), int(size * .16), (191, 226, 240), 24)
    out_img = img.convert("RGB")
    out_img = ImageEnhance.Contrast(out_img).enhance(1.08)
    out_img = ImageEnhance.Color(out_img).enhance(1.04)
    out_img = ImageEnhance.Sharpness(out_img).enhance(1.13)

    out = io.BytesIO()
    out_img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def facade_window(draw, box, p, balcony=False):
    x1, y1, x2, y2 = box
    stone = p["stone"]
    glass = p["glass"]
    frame = mix(p["accent"], (0,0,0), .12)
    draw.rounded_rectangle((x1 - 10, y1 - 10, x2 + 10, y2 + 10), radius=6, fill=mix(stone, (240,235,225), .20))
    draw.rectangle((x1, y1, x2, y2), fill=glass)
    draw.polygon([(x1 + 5, y1 + 5), (x2 - 6, y1 + 5), (x2 - 28, y2 - 6), (x1 + 24, y2 - 6)], fill=mix(glass, (210,235,244), .30))
    mx = (x1 + x2) / 2
    draw.line((mx, y1, mx, y2), fill=frame, width=5)
    if balcony:
        by = y2 + 14
        draw.rectangle((x1 - 24, by, x2 + 24, by + 12), fill=mix(stone, (255,255,255), .22))
        for xx in range(int(x1 - 12), int(x2 + 12), 18):
            draw.line((xx, by - 36, xx, by), fill=(95, 98, 97), width=3)
        draw.line((x1 - 16, by - 36, x2 + 16, by - 36), fill=(90, 93, 92), width=4)


def render_exterior(payload: dict[str, Any], width: int = 1536, height: int = 2048) -> bytes:
    p = palette(str(payload.get("style") or "سعودي حديث"))
    floors = max(1, min(4, int(payload.get("floors") or 1)))
    garden = bool(payload.get("garden", True))
    parking = bool(payload.get("parking", True))
    fence = bool(payload.get("fence", True))
    formal = str(payload.get("entrance") or "formal") == "formal"

    walls = payload.get("walls") or []
    minx, miny, maxx, maxy = bounds(walls)
    aspect = clamp((maxx - minx) / max(1.0, maxy - miny), .75, 2.3)

    img = gradient((width, height), (113, 174, 222), (236, 228, 210)).convert("RGBA")
    img = add_soft_glow(img, (int(width * .18), int(height * .14)), int(width * .28), (255, 222, 160), 80)
    draw = ImageDraw.Draw(img)

    horizon = int(height * .55)
    rng = random.Random(31)

    # distant urban context with atmospheric perspective
    for layer in range(2):
        base = horizon - layer * 26
        col = (205 + layer * 10, 207 + layer * 9, 204 + layer * 7)
        for _ in range(10):
            bw = rng.randint(90, 210)
            bh = rng.randint(90, 220)
            bx = rng.randint(-50, width)
            draw.rectangle((bx, base - bh, bx + bw, base), fill=col)

    draw.rectangle((0, horizon, width, height), fill=(192, 180, 158))
    draw.polygon([(0, int(height*.82)), (width, int(height*.75)), (width, height), (0, height)], fill=(150, 149, 142))

    front_w = int(width * clamp(.56 + (aspect - 1) * .05, .54, .72))
    fx = int(width * .11)
    depth = int(width * .16)
    base = int(height * .69)
    floor_h = int(height * .145)
    top = base - floors * floor_h

    # building cast shadow
    shadow = Image.new("RGBA", (width, height), (0,0,0,0))
    sd = ImageDraw.Draw(shadow)
    sh_poly = [
        (fx + 30, top + 34),
        (fx + front_w + 30, top + 34),
        (fx + front_w + depth + 42, top + int(depth*.23) + 45),
        (fx + front_w + depth + 42, base + int(depth*.23) + 42),
        (fx + 30, base + 42),
    ]
    sd.polygon(sh_poly, fill=(0,0,0,86))
    shadow = shadow.filter(ImageFilter.GaussianBlur(32))
    img = Image.alpha_composite(img, shadow)
    draw = ImageDraw.Draw(img)

    wall = p["wall"]
    stone = p["stone"]
    side = mix(wall, (75, 70, 64), .16)

    # stepped facade massing
    draw.rectangle((fx, top, fx + front_w, base), fill=wall)
    draw.polygon(
        [(fx + front_w, top), (fx + front_w + depth, top + int(depth*.23)),
         (fx + front_w + depth, base + int(depth*.23)), (fx + front_w, base)],
        fill=side,
    )

    # recessed central portal volume
    portal_cx = fx + int(front_w * .56)
    portal_w = int(front_w * (.20 if formal else .15))
    portal_top = top + int(floor_h * .12)
    draw.rectangle((portal_cx - portal_w//2, portal_top, portal_cx + portal_w//2, base), fill=mix(wall, (255,255,255), .15))
    draw.rectangle((portal_cx - portal_w//2 - 14, portal_top - 14, portal_cx + portal_w//2 + 14, portal_top), fill=mix(stone, (250,243,232), .24))

    # stone feature blade
    blade_w = int(front_w * .19)
    draw.rectangle((fx, top + 8, fx + blade_w, base), fill=stone)
    for yy in range(top + 24, base, 28):
        draw.line((fx, yy, fx + blade_w, yy), fill=mix(stone, (100,82,66), .12), width=2)

    # roof cap and horizontal bands
    draw.rectangle((fx - 10, top - 24, fx + front_w + 12, top + 6), fill=mix(stone, (244,236,223), .30))
    for f in range(1, floors):
        yy = base - f * floor_h
        draw.rectangle((fx, yy - 5, fx + front_w, yy + 5), fill=mix(wall, stone, .18))

    # windows and balconies
    for f in range(floors):
        fy = base - (f + 1) * floor_h
        y1 = fy + int(floor_h * .24)
        y2 = y1 + int(floor_h * .48)
        positions = (.08, .29, .70, .84)
        for j, pos in enumerate(positions):
            wx = fx + int(front_w * pos)
            ww = int(front_w * (.115 if j in (0,3) else .095))
            if portal_cx - portal_w//2 - 28 < wx < portal_cx + portal_w//2 + 28:
                continue
            facade_window(draw, (wx, y1, wx + ww, y2), p, balcony=(f > 0 and j in (1,2)))

    # entrance door, canopy and lighting
    door_w = int(portal_w * .56)
    door_h = int(floor_h * .66)
    dx = portal_cx - door_w // 2
    dy = base - door_h
    draw.rectangle((dx - 18, dy - 20, dx + door_w + 18, base), fill=mix(stone, (236,225,208), .24))
    draw.rounded_rectangle((dx, dy, dx + door_w, base), radius=9, fill=p["wood"])
    for yy in range(dy + 16, base - 7, 24):
        draw.line((dx + 12, yy, dx + door_w - 12, yy), fill=mix(p["wood"], (255,255,255), .18), width=3)
    canopy_y = dy - 38
    draw.polygon([(dx - 54, canopy_y), (dx + door_w + 62, canopy_y), (dx + door_w + 44, canopy_y + 22), (dx - 38, canopy_y + 22)], fill=p["accent"])

    # foreground landscaping
    lawn_top = base + 70
    draw.rectangle((0, lawn_top, width, height), fill=p["green"] if garden else (178,166,145))
    walkway = [(portal_cx - 150, base + 76), (portal_cx + 150, base + 76), (portal_cx + 330, height), (portal_cx - 330, height)]
    draw.polygon(walkway, fill=(155, 151, 142))
    for i in range(6):
        yy = base + 7 + i * 18
        pad = 8 + i * 18
        draw.rectangle((portal_cx - 100 - pad, yy, portal_cx + 100 + pad, yy + 15), fill=mix(stone, (180,166,146), .36))

    if parking:
        px = int(width * .79)
        draw.polygon([(px - 145, base + 90), (px + 105, base + 90), (width, height), (px - 285, height)], fill=(135, 138, 139))
        cy = int(height * .84)
        car = (px - 110, cy - 30, px + 120, cy + 74)
        draw.rounded_rectangle(car, radius=34, fill=(236, 238, 239), outline=(155,160,163), width=4)
        draw.polygon([(px - 66, cy - 22), (px + 72, cy - 22), (px + 94, cy + 12), (px - 86, cy + 12)], fill=(76, 101, 114))
        draw.ellipse((px - 92, cy + 52, px - 52, cy + 92), fill=(43,43,43))
        draw.ellipse((px + 67, cy + 52, px + 107, cy + 92), fill=(43,43,43))

    if garden:
        for _ in range(52):
            x = rng.randint(12, width - 12)
            y = rng.randint(lawn_top + 25, height - 16)
            if abs(x - portal_cx) < 330:
                continue
            r = rng.randint(7, 20)
            col = (
                clamp(p["green"][0] + rng.randint(-8, 16), 30, 130),
                clamp(p["green"][1] + rng.randint(-5, 22), 60, 150),
                clamp(p["green"][2] + rng.randint(-6, 12), 30, 120),
            )
            draw.ellipse((x-r, y-r, x+r, y+r), fill=col)

        # palms
        for x in (95, width - 125):
            ty = int(height * .68)
            draw.rectangle((x - 9, ty - 150, x + 9, ty + 28), fill=(105, 79, 57))
            for angle in range(0, 360, 30):
                ex = x + math.cos(math.radians(angle)) * 92
                ey = ty - 150 + math.sin(math.radians(angle)) * 45
                draw.line((x, ty - 150, ex, ey), fill=(40, 86, 49), width=12)

    if fence:
        fy = int(height * .82)
        fence_col = mix(stone, (238,226,209), .20)
        draw.rectangle((0, fy, width, fy + 34), fill=fence_col)
        for x in (34, fx - 38, fx + front_w + depth + 24, width - 76):
            draw.rectangle((x, fy - 112, x + 38, fy + 48), fill=stone)
        gate1, gate2 = portal_cx - 150, portal_cx + 150
        draw.rectangle((gate1, fy - 80, gate2, fy + 3), fill=(55, 57, 56))
        for x in range(gate1 + 12, gate2, 24):
            draw.line((x, fy - 74, x, fy + 1), fill=(116,113,106), width=4)

    # exterior light pools
    img = add_soft_glow(img, (portal_cx, base - 68), 82, (255, 199, 112), 58)
    img = add_soft_glow(img, (fx + front_w - 88, base - 64), 58, (255, 202, 122), 36)

    out_img = img.convert("RGB")
    out_img = ImageEnhance.Contrast(out_img).enhance(1.10)
    out_img = ImageEnhance.Color(out_img).enhance(1.04)
    out_img = ImageEnhance.Sharpness(out_img).enhance(1.16)

    out = io.BytesIO()
    out_img.save(out, format="PNG", optimize=True)
    return out.getvalue()
