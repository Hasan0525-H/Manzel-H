from __future__ import annotations

import base64
import io
import os
from pathlib import Path
from typing import Any

import modal

APP_NAME = "manzel-h-pipeline"
MODEL_ID = "Qwen/Qwen-Image-Edit-2509"
MODEL_DIR = Path("/models/qwen-image-edit-2509")

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name("manzel-h-model-cache", create_if_missing=True)

api_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(
        "fastapi>=0.116,<1",
        "pillow>=11,<12",
        "numpy>=2,<3",
        "opencv-python-headless>=4.12,<5",
        "pymupdf>=1.26,<2",
    )
)

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .uv_pip_install(
        "torch==2.8.0",
        "torchvision==0.23.0",
        "diffusers==0.36.0",
        "transformers>=4.57,<5",
        "accelerate>=1.10,<2",
        "safetensors>=0.6,<1",
        "sentencepiece>=0.2,<1",
        "modelscope>=1.30,<2",
        "pillow>=11,<12",
        "pymupdf>=1.26,<2",
    )
)

_PIPELINE = None


def _decode_bytes(payload: dict[str, Any]) -> tuple[bytes, str, str]:
    encoded = payload.get("imageBase64")
    if not isinstance(encoded, str) or len(encoded) < 100:
        raise ValueError("image_required")

    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("invalid_base64") from exc

    if len(raw) < 1000:
        raise ValueError("image_too_small")
    if len(raw) > 18 * 1024 * 1024:
        raise ValueError("image_too_large")

    filename = str(payload.get("filename") or "floorplan.jpg")
    content_type = str(payload.get("contentType") or "application/octet-stream")
    return raw, filename, content_type


def _open_plan(raw: bytes, filename: str, content_type: str):
    from PIL import Image

    is_pdf = content_type.lower() == "application/pdf" or filename.lower().endswith(".pdf")
    if is_pdf:
        import fitz

        doc = fitz.open(stream=raw, filetype="pdf")
        if not doc.page_count:
            raise ValueError("empty_pdf")
        page = doc.load_page(0)
        pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
        return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")

    return Image.open(io.BytesIO(raw)).convert("RGB")


def _render_prompt(payload: dict[str, Any]) -> str:
    kind = str(payload.get("kind") or "exterior")
    floors = max(1, min(4, int(payload.get("floors") or 1)))
    furnishing = str(payload.get("furnishing") or "full")
    style = str(payload.get("style") or "سعودي حديث")
    garden = bool(payload.get("garden", True))
    parking = bool(payload.get("parking", True))
    fence = bool(payload.get("fence", True))
    entrance = str(payload.get("entrance") or "formal")

    constraints = (
        f"Preserve the exact floor-plan geometry, footprint, room adjacency, wall positions, "
        f"openings and orientation from the reference image. Do not mirror, rotate, stretch, "
        f"merge rooms, remove rooms, or invent structural walls. Exactly {floors} storeys. "
        f"Architectural style: {style}. "
    )

    if kind == "interior":
        furniture_rule = {
            "none": "No furniture; architecture and finishes only.",
            "light": "Light furnishing only with generous empty space.",
        }.get(furnishing, "Fully furnished with coherent premium contemporary furniture.")
        return (
            constraints
            + furniture_rule
            + " Create a photorealistic isometric cutaway / dollhouse architectural visualization. "
            + "Keep the plan traceable one-to-one. Saudi residential scale and materials. "
            + "No labels, no watermark."
        )

    site = " ".join(
        [
            "Include a Saudi-climate landscaped garden." if garden else "No garden.",
            "Include usable residential parking." if parking else "No parking or garage.",
            "Include a privacy boundary wall." if fence else "No boundary wall.",
            "Use a prominent formal entrance." if entrance == "formal" else "Use a simple entrance.",
        ]
    )
    return (
        constraints
        + site
        + " Create a straight-on eye-level photorealistic Saudi villa exterior. "
        + "Keep straight verticals, realistic daylight and physically plausible materials. "
        + "No text, no watermark."
    )


def _ensure_pipeline():
    global _PIPELINE
    if _PIPELINE is not None:
        return _PIPELINE

    import torch
    from diffusers import QwenImageEditPlusPipeline
    from modelscope import snapshot_download

    if not MODEL_DIR.exists() or not any(MODEL_DIR.iterdir()):
        MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
        snapshot_download(
            MODEL_ID,
            local_dir=str(MODEL_DIR),
        )
        model_cache.commit()

    _PIPELINE = QwenImageEditPlusPipeline.from_pretrained(
        str(MODEL_DIR),
        torch_dtype=torch.bfloat16,
        local_files_only=True,
    )
    _PIPELINE.to("cuda")
    _PIPELINE.set_progress_bar_config(disable=True)
    return _PIPELINE


@app.function(
    image=gpu_image,
    gpu="A100-80GB",
    volumes={"/models": model_cache},
    timeout=900,
    startup_timeout=900,
    scaledown_window=180,
    max_containers=1,
)
def render_qwen(payload: dict[str, Any]) -> dict[str, str]:
    import torch

    raw, filename, content_type = _decode_bytes(payload)
    reference = _open_plan(raw, filename, content_type)

    max_side = 1536
    if max(reference.size) > max_side:
        scale = max_side / max(reference.size)
        reference = reference.resize(
            (max(1, round(reference.width * scale)), max(1, round(reference.height * scale)))
        )

    pipe = _ensure_pipeline()
    seed = int(payload.get("seed") or 20260929)
    inputs = {
        "image": [reference],
        "prompt": _render_prompt(payload),
        "generator": torch.manual_seed(seed),
        "true_cfg_scale": 4.0,
        "negative_prompt": "distorted floor plan, changed geometry, extra rooms, missing walls, text, watermark",
        "num_inference_steps": 36,
        "guidance_scale": 1.0,
        "num_images_per_prompt": 1,
    }

    with torch.inference_mode():
        output = pipe(**inputs)

    image = output.images[0]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    result = buffer.getvalue()
    if len(result) < 10_000:
        raise RuntimeError("render_result_too_small")

    return {
        "imageBase64": base64.b64encode(result).decode("ascii"),
        "mime": "image/png",
        "engine": "modal-qwen-image-edit-2509",
    }


def _analyze_plan(payload: dict[str, Any]) -> dict[str, Any]:
    import cv2
    import numpy as np

    raw, filename, content_type = _decode_bytes(payload)
    image = _open_plan(raw, filename, content_type)
    rgb = np.array(image)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    # Architectural plans usually have dark walls on a light sheet.
    binary = cv2.threshold(gray, 210, 255, cv2.THRESH_BINARY_INV)[1]
    kernel = np.ones((3, 3), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    min_length = max(35, int(min(image.size) * 0.035))
    lines = cv2.HoughLinesP(
        binary,
        rho=1,
        theta=np.pi / 360,
        threshold=50,
        minLineLength=min_length,
        maxLineGap=max(8, min_length // 5),
    )

    walls: list[dict[str, Any]] = []
    if lines is not None:
        for index, raw_line in enumerate(lines[:600]):
            x1, y1, x2, y2 = map(int, raw_line[0])
            length = float(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5)
            if length < min_length:
                continue
            dx, dy = abs(x2 - x1), abs(y2 - y1)
            orientation = "horizontal" if dy <= dx * 0.15 else "vertical" if dx <= dy * 0.15 else "diagonal"
            confidence = min(0.98, 0.55 + length / max(image.size) * 0.7)
            walls.append(
                {
                    "id": f"wall-{index + 1}",
                    "a": {"x": x1, "y": y1},
                    "b": {"x": x2, "y": y2},
                    "thickness": 8,
                    "confidence": round(confidence, 3),
                    "orientation": orientation,
                }
            )

    return {
        "width": image.width,
        "height": image.height,
        "engine": "modal-opencv-v1",
        "walls": walls,
        "openings": [],
        "rooms": [],
        "exteriorWallIds": [],
    }


@app.function(image=api_image, timeout=900)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, HTTPException

    api = FastAPI(title="Manzel H Cloud Pipeline", version="1.0.0")

    @api.get("/health")
    def health():
        return {
            "ok": True,
            "platform": "modal",
            "analysis": "opencv",
            "render": "qwen-image-edit-2509",
            "model_source": "modelscope",
        }

    @api.post("/analyze")
    def analyze(payload: dict[str, Any]):
        try:
            return _analyze_plan(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"analyze_failed:{type(exc).__name__}") from exc

    @api.post("/render")
    def render(payload: dict[str, Any]):
        try:
            return render_qwen.remote(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"render_failed:{type(exc).__name__}") from exc

    return api
