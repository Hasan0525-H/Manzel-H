from __future__ import annotations

import base64
import io
import os
from typing import Any

import requests
from PIL import Image

from render_images_v2 import render_exterior, render_interior

MODEL = os.getenv(
    "CLOUDFLARE_MODEL",
    "@cf/black-forest-labs/flux-2-klein-9b",
)
FALLBACK_MODEL = os.getenv(
    "CLOUDFLARE_FALLBACK_MODEL",
    "@cf/black-forest-labs/flux-2-klein-4b",
)
ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "").strip()
TIMEOUT_SECONDS = int(os.getenv("CLOUDFLARE_RENDER_TIMEOUT", "150"))


def configured() -> bool:
    return bool(ACCOUNT_ID and API_TOKEN)


def primary_model() -> str:
    return MODEL


def fallback_model() -> str:
    return FALLBACK_MODEL


def _resize_reference(png: bytes, max_side: int = 480) -> bytes:
    image = Image.open(io.BytesIO(png)).convert("RGB")
    image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _reference_images(kind: str, payload: dict[str, Any]) -> list[bytes]:
    # Reference 0 is always the authoritative geometry reference.
    geometry = render_interior(payload, size=900)
    refs = [_resize_reference(geometry)]

    if kind == "exterior":
        # Reference 1 is composition-only. Geometry from image 0 remains authoritative.
        composition = render_exterior(payload, width=720, height=960)
        refs.append(_resize_reference(composition))
    return refs


def _prompt(kind: str, payload: dict[str, Any]) -> str:
    style = str(payload.get("style") or "سعودي حديث")
    furnishing = str(payload.get("furnishing") or "full")
    floors = max(1, int(payload.get("floors") or 1))
    garden = bool(payload.get("garden", True))
    parking = bool(payload.get("parking", True))
    fence = bool(payload.get("fence", True))
    entrance = str(payload.get("entrance") or "formal")

    shared = f"""
Image 0 is the authoritative architectural geometry reference.
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
Produce an interior/isometric architectural visualization based on image 0.
Keep the same camera orientation and exact room geometry.
The result should be {furnishing_text}.
Use realistic stone, plaster, wood, glass, tile, fabric, indirect lighting,
and daylight appropriate for a luxury Saudi home.
"""

    return shared + f"""
Produce a photorealistic exterior architectural visualization.
Image 1, when present, is only a composition and landscaping reference;
if image 1 conflicts with image 0, always follow image 0 geometry.
Use a realistic street-level architectural camera, correct verticals, premium facade detailing.
Garden: {garden}. Parking: {parking}. Boundary fence: {fence}. Entrance style: {entrance}.
Use believable Saudi climate landscaping, paving, facade stone, plaster, glass,
wood/metal accents, warm exterior lighting, and realistic sky.
"""


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


def render_with_cloudflare(kind: str, payload: dict[str, Any]) -> bytes:
    if kind not in ("interior", "exterior"):
        raise ValueError("unknown render kind")
    if not configured():
        raise RuntimeError("Cloudflare Workers AI credentials are not configured")

    refs = _reference_images(kind, payload)
    width, height = ((1536, 1536) if kind == "interior" else (1440, 1920))

    files = {
        f"input_image_{index}": (f"reference-{index}.png", image, "image/png")
        for index, image in enumerate(refs[:4])
    }
    form = {
        "prompt": _prompt(kind, payload),
        "width": str(width),
        "height": str(height),
        "guidance": os.getenv("CLOUDFLARE_GUIDANCE", "4.0"),
    }

    def run_model(model_name: str) -> requests.Response:
        endpoint = (
            f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model_name}"
        )
        return requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            data=form,
            files=files,
            timeout=TIMEOUT_SECONDS,
        )

    response = run_model(MODEL)
    if (
        response.status_code in (429, 500, 502, 503, 504)
        and FALLBACK_MODEL
        and FALLBACK_MODEL != MODEL
    ):
        response = run_model(FALLBACK_MODEL)

    if response.status_code >= 400:
        detail = response.text[:700]
        raise RuntimeError(
            f"Cloudflare Workers AI HTTP {response.status_code}: {detail}"
        )

    image_bytes = _decode_cloudflare_response(response)
    if len(image_bytes) < 10_000:
        raise RuntimeError("Cloudflare returned an unexpectedly small image")
    return image_bytes
