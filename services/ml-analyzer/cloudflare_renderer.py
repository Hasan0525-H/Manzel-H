from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import time
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

from render_images_v2 import render_exterior, render_interior

MODEL = os.getenv(
    "CLOUDFLARE_MODEL",
    "@cf/black-forest-labs/flux-2-klein-9b",
)
ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "").strip()
TIMEOUT_SECONDS = int(os.getenv("CLOUDFLARE_RENDER_TIMEOUT", "240"))
MAX_RETRIES = max(1, min(4, int(os.getenv("CLOUDFLARE_MAX_RETRIES", "3"))))
LOGGER = logging.getLogger("manzel.cloudflare")


def configured() -> bool:
    return bool(ACCOUNT_ID and API_TOKEN)


def primary_model() -> str:
    return MODEL


def fallback_model() -> None:
    return None


def _floorplan_reference(payload: dict[str, Any], size: int = 480) -> bytes:
    walls = payload.get("walls") or []
    openings = payload.get("openings") or []
    if not walls:
        raise RuntimeError("No walls available for geometry reference")

    xs = [float(w[k]["x"]) for w in walls for k in ("a", "b")]
    ys = [float(w[k]["y"]) for w in walls for k in ("a", "b")]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(1.0, max_x - min_x)
    span_y = max(1.0, max_y - min_y)
    margin = 34
    scale = min((size - margin * 2) / span_x, (size - margin * 2) / span_y)

    image = Image.new("RGB", (size, size), (250, 250, 248))
    draw = ImageDraw.Draw(image)

    def pt(x: float, y: float) -> tuple[int, int]:
        ox = margin + (size - margin * 2 - span_x * scale) / 2
        oy = margin + (size - margin * 2 - span_y * scale) / 2
        return (
            int(round(ox + (x - min_x) * scale)),
            int(round(oy + (y - min_y) * scale)),
        )

    exterior_ids = set(str(x) for x in (payload.get("exteriorWallIds") or []))
    wall_by_id = {}
    for wall in walls:
        wid = str(wall.get("id") or "")
        wall_by_id[wid] = wall
        a = pt(float(wall["a"]["x"]), float(wall["a"]["y"]))
        b = pt(float(wall["b"]["x"]), float(wall["b"]["y"]))
        is_exterior = wid in exterior_ids
        width = 7 if is_exterior else 5
        color = (20, 20, 20) if is_exterior else (48, 48, 48)
        draw.line((*a, *b), fill=color, width=width)

    # Mark detected doors/windows in a different tone without obscuring geometry.
    for opening in openings:
        wall = wall_by_id.get(str(opening.get("wallId") or ""))
        if not wall:
            continue
        ax, ay = float(wall["a"]["x"]), float(wall["a"]["y"])
        bx, by = float(wall["b"]["x"]), float(wall["b"]["y"])
        t = max(0.0, min(1.0, float(opening.get("centerT", 0.5))))
        cx, cy = ax + (bx - ax) * t, ay + (by - ay) * t
        px, py = pt(cx, cy)
        if opening.get("kind") == "window":
            draw.ellipse((px - 5, py - 5, px + 5, py + 5), fill=(44, 125, 174))
        else:
            draw.ellipse((px - 6, py - 6, px + 6, py + 6), fill=(174, 92, 44))

    # A thin border makes the entire authoritative footprint obvious to the model.
    draw.rectangle((6, 6, size - 7, size - 7), outline=(205, 205, 200), width=2)

    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _resize_reference(png: bytes, max_side: int = 480) -> bytes:
    image = Image.open(io.BytesIO(png)).convert("RGB")
    image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _reference_images(kind: str, payload: dict[str, Any]) -> list[bytes]:
    # Image 0: strict top-down geometry. This is the authoritative plan reference.
    refs = [_floorplan_reference(payload)]

    # Image 1: volumetric/isometric geometry reference derived from the same walls.
    geometry = render_interior(payload, size=900)
    refs.append(_resize_reference(geometry))

    if kind == "exterior":
        # Image 2: facade composition only. It must never override images 0/1 geometry.
        composition = render_exterior(payload, width=720, height=960)
        refs.append(_resize_reference(composition))
    return refs


def _stable_seed(kind: str, payload: dict[str, Any]) -> int:
    source = {
        "kind": kind,
        "walls": payload.get("walls") or [],
        "openings": payload.get("openings") or [],
        "rooms": payload.get("rooms") or [],
        "style": payload.get("style"),
        "floors": payload.get("floors"),
        "furnishing": payload.get("furnishing"),
        "garden": payload.get("garden"),
        "parking": payload.get("parking"),
        "fence": payload.get("fence"),
        "entrance": payload.get("entrance"),
    }
    raw = json.dumps(source, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


def _prompt(kind: str, payload: dict[str, Any]) -> str:
    style = str(payload.get("style") or "سعودي حديث")
    furnishing = str(payload.get("furnishing") or "full")
    floors = max(1, int(payload.get("floors") or 1))
    garden = bool(payload.get("garden", True))
    parking = bool(payload.get("parking", True))
    fence = bool(payload.get("fence", True))
    entrance = str(payload.get("entrance") or "formal")

    shared = f"""
Image 0 is the authoritative top-down architectural plan.
Image 1 is the authoritative volumetric/isometric interpretation of that same plan.
Preserve the exact footprint, wall positions, room adjacency, openings, proportions,
floor count ({floors}), and overall massing shown in image 0.
Do not move, remove, or invent structural walls, doors, windows, stairs, or columns.
Do not change the plan geometry to make the picture prettier.
Use the architectural style: {style}.
Create premium high-end Saudi residential archviz, photorealistic materials,
physically plausible lighting, realistic scale, clean construction details,
natural shadows, professional architectural photography, no text, no labels,
no watermark, no fantasy shapes, no distorted perspective.
"""

    if kind == "interior":
        furnishing_text = {
            "full": "fully furnished with tasteful high-end contemporary furniture",
            "light": "lightly furnished with only essential elegant furniture",
            "none": "unfurnished, showing architecture and finishes only",
        }.get(furnishing, "fully furnished")
        return shared + f"""
Produce an interior/isometric architectural visualization based on images 0 and 1.
Keep the same camera orientation as image 1 and exact room geometry from image 0.
The result should be {furnishing_text}.
Use realistic stone, plaster, wood, glass, tile, fabric, indirect lighting,
and daylight appropriate for a luxury Saudi home.
"""

    return shared + f"""
Produce a photorealistic exterior architectural visualization.
Image 2, when present, is only a composition and landscaping reference.
If image 2 conflicts with image 0 or image 1, always follow images 0 and 1 geometry.
Use a realistic street-level architectural camera, correct verticals, premium facade detailing.
Garden: {garden}. Parking: {parking}. Boundary fence: {fence}. Entrance style: {entrance}.
Use believable Saudi climate landscaping, paving, facade stone, plaster, glass,
wood/metal accents, warm exterior lighting, and realistic sky.
"""


def _normalize_output_png(image_bytes: bytes) -> bytes:
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as exc:
        raise RuntimeError("Cloudflare returned invalid image bytes") from exc

    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    png = out.getvalue()
    if len(png) < 10_000:
        raise RuntimeError("Normalized Cloudflare image is unexpectedly small")
    return png


def _decode_cloudflare_response(response: requests.Response) -> bytes:
    content_type = response.headers.get("content-type", "")
    if content_type.startswith("image/"):
        return response.content

    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("Cloudflare returned a non-JSON image response") from exc

    result = data.get("result", data) if isinstance(data, dict) else data
    image_value = result.get("image") if isinstance(result, dict) else None
    if not image_value and isinstance(data, dict):
        image_value = data.get("image")

    if not isinstance(image_value, str) or not image_value:
        errors = data.get("errors") if isinstance(data, dict) else None
        raise RuntimeError(f"Cloudflare response missing image: {errors or 'unknown error'}")

    if image_value.startswith("data:"):
        image_value = image_value.split(",", 1)[1]
    return base64.b64decode(image_value)


def _direct_plan_references(plan_png: bytes) -> list[bytes]:
    original = _resize_reference(plan_png)

    image = Image.open(io.BytesIO(original)).convert("RGB")
    gray = ImageOps.autocontrast(ImageOps.grayscale(image))

    contrast = ImageEnhance.Contrast(gray).enhance(2.6)
    blueprint = contrast.point(lambda value: 255 if value > 205 else 24).convert("RGB")

    edges = gray.filter(ImageFilter.FIND_EDGES)
    edges = ImageOps.autocontrast(edges)
    edges = ImageOps.invert(edges)
    edges = edges.point(lambda value: 255 if value > 218 else 18).convert("RGB")

    structure = blueprint.filter(ImageFilter.MinFilter(3))

    refs = [original]
    for ref in (blueprint, edges, structure):
        out = io.BytesIO()
        ref.save(out, format="PNG", optimize=True)
        refs.append(out.getvalue())
    return refs


def _direct_plan_prompt(kind: str, options: dict[str, Any]) -> str:
    style = str(options.get("style") or "سعودي حديث")
    furnishing = str(options.get("furnishing") or "full")
    floors = max(1, int(options.get("floors") or 1))
    garden = bool(options.get("garden", True))
    parking = bool(options.get("parking", True))
    fence = bool(options.get("fence", True))
    entrance = str(options.get("entrance") or "formal")

    base = f"""
Image 0 is the original user architectural floor plan and is the authoritative geometry.
Image 1 is a high-contrast copy of the exact same plan.
Image 2 is an edge map of the exact same plan.
Image 3 is a thick structural-line mask of the exact same plan.
All four references describe one identical geometry. Cross-check them before rendering.
Preserve the exact outer footprint, all visible wall positions, room adjacency,
corridors, stairs, doors, windows, voids, columns, proportions and orientation.
Do not simplify, merge, move, remove, rotate, mirror, stretch or invent rooms or structural walls.
Do not reinterpret the plan into a different house.
If any decorative goal conflicts with the plan geometry, the plan geometry always wins.
Floor count: {floors}. Architectural style: {style}.
Premium photorealistic Saudi residential archviz, physically plausible materials,
realistic scale, natural lighting, professional architectural photography,
clean construction details, no text, no labels, no watermark, no fantasy geometry.
"""

    if kind == "interior":
        furnishing_text = {
            "full": "fully furnished with elegant high-end contemporary furniture",
            "light": "lightly furnished with only essential furniture",
            "none": "unfurnished, showing architecture and finishes only",
        }.get(furnishing, "fully furnished")
        return base + f"""
Create a high-end isometric cutaway / dollhouse interior visualization.
The floor plan must remain visibly traceable one-to-one to image 0.
Keep the exact room arrangement and circulation. {furnishing_text}.
Use realistic stone, plaster, timber, glass, tile, fabric, daylight and indirect lighting.
"""

    return base + f"""
Create a premium photorealistic exterior residence consistent with the exact footprint
in image 0 and the requested {floors} floor(s). The plan does not define a full elevation,
so design facade finishes and elevation details without changing the footprint.
Garden: {garden}. Parking: {parking}. Boundary fence: {fence}. Entrance: {entrance}.
Use a realistic eye-level architectural camera, straight verticals, Saudi-climate
landscaping, premium stone/plaster/glass/wood/metal, realistic sky and warm lighting.
"""


def _direct_plan_seed(kind: str, plan_png: bytes, options: dict[str, Any]) -> int:
    payload = json.dumps(options, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(kind.encode("utf-8") + plan_png + payload).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


def render_plan_with_cloudflare(kind: str, plan_png: bytes, options: dict[str, Any]) -> bytes:
    if kind not in ("interior", "exterior"):
        raise ValueError("unknown render kind")
    if not configured():
        raise RuntimeError("Cloudflare Workers AI credentials are not configured")

    refs = _direct_plan_references(plan_png)
    width, height = ((1920, 1920) if kind == "interior" else (1440, 1920))
    seed = _direct_plan_seed(kind, plan_png, options)

    files = {
        f"input_image_{index}": (f"plan-reference-{index}.png", image, "image/png")
        for index, image in enumerate(refs[:4])
    }
    form = {
        "prompt": _direct_plan_prompt(kind, options),
        "width": str(width),
        "height": str(height),
        "guidance": os.getenv("CLOUDFLARE_GUIDANCE", "4.5"),
        "seed": str(seed),
    }

    def run_model(model_name: str) -> requests.Response:
        endpoint = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model_name}"
        started = time.monotonic()
        response = requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            data=form,
            files=files,
            timeout=TIMEOUT_SECONDS,
        )
        LOGGER.info(
            "cloudflare_direct_plan model=%s kind=%s refs=%s size=%sx%s status=%s elapsed=%.2fs ray=%s seed=%s",
            model_name,
            kind,
            len(refs),
            width,
            height,
            response.status_code,
            time.monotonic() - started,
            response.headers.get("cf-ray", "-"),
            seed,
        )
        return response

    retryable = {429, 500, 502, 503, 504}
    response = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = run_model(MODEL)
        except requests.RequestException as exc:
            LOGGER.warning(
                "cloudflare_direct_retry model=%s attempt=%s/%s reason=%s",
                MODEL,
                attempt,
                MAX_RETRIES,
                type(exc).__name__,
            )
            if attempt >= MAX_RETRIES:
                raise RuntimeError("Cloudflare Workers AI request failed") from exc
            time.sleep(min(8.0, 1.5 * (2 ** (attempt - 1))))
            continue

        if response.status_code not in retryable or attempt >= MAX_RETRIES:
            break

        LOGGER.warning(
            "cloudflare_direct_retry model=%s attempt=%s/%s status=%s ray=%s",
            MODEL,
            attempt,
            MAX_RETRIES,
            response.status_code,
            response.headers.get("cf-ray", "-"),
        )
        time.sleep(min(8.0, 1.5 * (2 ** (attempt - 1))))

    if response is None:
        raise RuntimeError("Cloudflare Workers AI returned no response")

    if response.status_code >= 400:
        detail = response.text[:700].replace("\n", " ")
        LOGGER.error(
            "cloudflare_direct_failed status=%s ray=%s detail=%s",
            response.status_code,
            response.headers.get("cf-ray", "-"),
            detail,
        )
        raise RuntimeError(f"Cloudflare Workers AI HTTP {response.status_code}")

    image_bytes = _decode_cloudflare_response(response)
    return _normalize_output_png(image_bytes)


def render_with_cloudflare(kind: str, payload: dict[str, Any]) -> bytes:
    if kind not in ("interior", "exterior"):
        raise ValueError("unknown render kind")
    if not configured():
        raise RuntimeError("Cloudflare Workers AI credentials are not configured")

    refs = _reference_images(kind, payload)
    width, height = ((1920, 1920) if kind == "interior" else (1440, 1920))

    files = {
        f"input_image_{index}": (f"reference-{index}.png", image, "image/png")
        for index, image in enumerate(refs[:4])
    }
    form = {
        "prompt": _prompt(kind, payload),
        "width": str(width),
        "height": str(height),
        "guidance": os.getenv("CLOUDFLARE_GUIDANCE", "4.5"),
        "seed": str(_stable_seed(kind, payload)),
    }

    def run_model(model_name: str) -> tuple[requests.Response, float]:
        endpoint = (
            f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model_name}"
        )
        started = time.monotonic()
        response = requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            data=form,
            files=files,
            timeout=TIMEOUT_SECONDS,
        )
        elapsed = time.monotonic() - started
        LOGGER.info(
            "cloudflare_render model=%s kind=%s refs=%s size=%sx%s status=%s elapsed=%.2fs ray=%s seed=%s",
            model_name,
            kind,
            len(refs),
            width,
            height,
            response.status_code,
            elapsed,
            response.headers.get("cf-ray", "-"),
            form["seed"],
        )
        return response, elapsed

    retryable = {429, 500, 502, 503, 504}
    response = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response, _ = run_model(MODEL)
        except requests.RequestException as exc:
            LOGGER.warning(
                "cloudflare_render_retry model=%s attempt=%s/%s reason=%s",
                MODEL,
                attempt,
                MAX_RETRIES,
                type(exc).__name__,
            )
            if attempt >= MAX_RETRIES:
                raise RuntimeError("Cloudflare Workers AI request failed") from exc
            time.sleep(min(8.0, 1.5 * (2 ** (attempt - 1))))
            continue

        if response.status_code not in retryable or attempt >= MAX_RETRIES:
            break

        LOGGER.warning(
            "cloudflare_render_retry model=%s attempt=%s/%s status=%s ray=%s",
            MODEL,
            attempt,
            MAX_RETRIES,
            response.status_code,
            response.headers.get("cf-ray", "-"),
        )
        time.sleep(min(8.0, 1.5 * (2 ** (attempt - 1))))

    if response is None:
        raise RuntimeError("Cloudflare Workers AI returned no response")

    if response.status_code >= 400:
        detail = response.text[:700].replace("\n", " ")
        LOGGER.error(
            "cloudflare_render_failed status=%s ray=%s detail=%s",
            response.status_code,
            response.headers.get("cf-ray", "-"),
            detail,
        )
        raise RuntimeError(
            f"Cloudflare Workers AI HTTP {response.status_code}"
        )

    image_bytes = _decode_cloudflare_response(response)
    if len(image_bytes) < 10_000:
        raise RuntimeError("Cloudflare returned an unexpectedly small image")
    return _normalize_output_png(image_bytes)
