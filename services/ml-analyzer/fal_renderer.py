from __future__ import annotations

import base64
import io
import os
import urllib.request
from typing import Any

import fal_client

from render_images_v2 import render_exterior as render_exterior_draft
from render_images_v2 import render_interior as render_interior_draft


MODEL_ID = os.getenv("FAL_RENDER_MODEL", "fal-ai/flux-control-lora-canny/image-to-image")


def configured() -> bool:
    return bool(os.getenv("FAL_KEY", "").strip())


def _data_uri(payload: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(payload).decode("ascii")


def _style_text(name: str) -> str:
    mapping = {
        "سعودي حديث": "contemporary Saudi villa, warm limestone, refined off-white stucco, dark bronze window frames, elegant timber entrance",
        "نجدي حديث": "contemporary Najdi architecture, warm sand plaster, local stone, subtle geometric Najdi detailing, deep shaded openings",
        "حجازي حديث": "contemporary Hijazi villa, warm white plaster, natural stone, dark timber mashrabiya inspired details, elegant tall windows",
        "مودرن فاخر": "luxury minimalist modern villa, premium limestone, smooth microcement, black aluminum glazing, restrained high-end detailing",
    }
    return mapping.get(name, mapping["سعودي حديث"])


def _prompt(kind: str, payload: dict[str, Any]) -> str:
    floors = max(1, min(3, int(payload.get("floors") or 1)))
    style = _style_text(str(payload.get("style") or "سعودي حديث"))
    furnishing = str(payload.get("furnishing") or "full")
    furnishing_text = {
        "full": "fully furnished with realistic premium furniture and accessories",
        "light": "lightly furnished with a few carefully placed premium pieces",
        "none": "unfurnished, clean architectural shell only",
    }.get(furnishing, "fully furnished")

    if kind == "interior":
        return (
            "Ultra photorealistic architectural visualization, bird's-eye dollhouse floor plan render. "
            f"{style}. {furnishing_text}. "
            "Preserve the exact room layout, wall positions, openings, circulation and proportions from the control image. "
            "Do not invent rooms, do not move walls, do not change the plan geometry. "
            "Real PBR materials, marble and porcelain where appropriate, warm wood flooring in bedrooms, realistic fabric, "
            "high-end Saudi residential interior design, physically plausible daylight, soft indirect lighting, ambient occlusion, "
            "sharp professional archviz, V-Ray / Corona quality, 8k detail, no labels, no text, no diagram style, no cartoon."
        )

    return (
        "Ultra photorealistic professional exterior architectural visualization of the exact villa massing from the control image. "
        f"{floors} floor residential villa, {style}. "
        "Preserve the exact facade width, building mass, entrance position and visible opening rhythm from the control image. "
        "Premium natural stone, realistic stucco, dark aluminum frames, physically correct glass reflections, detailed entrance, "
        "Saudi residential landscaping with tasteful palms and drought-tolerant plants, realistic driveway and boundary treatment, "
        "golden late-afternoon daylight, ray-traced global illumination, soft contact shadows, photographic dynamic range, "
        "35mm architectural photography, V-Ray / Corona / Unreal quality, highly realistic, 8k detail, "
        "no illustration, no flat vector shapes, no cartoon, no text, no logo."
    )


def render_with_fal(kind: str, payload: dict[str, Any]) -> bytes:
    if not configured():
        raise RuntimeError("FAL_KEY is not configured")

    if kind == "interior":
        draft = render_interior_draft(payload, size=1536)
        image_size: str | dict[str, int] = "square_hd"
        strength = 0.68
        control_strength = 0.95
    elif kind == "exterior":
        draft = render_exterior_draft(payload, width=1536, height=2048)
        image_size = "portrait_4_3"
        strength = 0.72
        control_strength = 0.92
    else:
        raise ValueError("unknown render kind")

    source = _data_uri(draft)
    result = fal_client.subscribe(
        MODEL_ID,
        arguments={
            "prompt": _prompt(kind, payload),
            "image_url": source,
            "control_lora_image_url": source,
            "image_size": image_size,
            "num_inference_steps": 32,
            "guidance_scale": 3.6,
            "num_images": 1,
            "enable_safety_checker": True,
            "output_format": "png",
            "control_lora_strength": control_strength,
            "strength": strength,
        },
        timeout=150,
    )

    images = result.get("images") or []
    if not images or not images[0].get("url"):
        raise RuntimeError("fal returned no image")

    with urllib.request.urlopen(images[0]["url"], timeout=60) as response:
        data = response.read()
    if len(data) < 2048:
        raise RuntimeError("fal returned an empty image")
    return data
