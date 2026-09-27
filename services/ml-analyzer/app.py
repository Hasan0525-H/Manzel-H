from __future__ import annotations

import base64
import io
import math
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from pydantic import BaseModel, Field

from cloudflare_renderer import (
    configured as cloudflare_configured,
    fallback_model,
    primary_model,
    render_plan_with_cloudflare,
    render_with_cloudflare,
)

MAX_UPLOAD = 18 * 1024 * 1024

app = FastAPI(title="Manzel H Cloud Renderer", version="2.0.0")

allowed_origin = os.getenv("ALLOWED_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allowed_origin == "*" else [allowed_origin],
    allow_credentials=allowed_origin != "*",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "opencv-lightweight-direct-flux",
        "model_loaded": False,
        "render_platform": "cloudflare-workers-ai-flux2",
        "render_configured": cloudflare_configured(),
        "render_model": primary_model(),
        "render_fallback_model": fallback_model(),
        "direct_plan_render": True,
    }


def _read_plan_image(raw: bytes, filename: str, content_type: str | None) -> Image.Image:
    is_pdf = content_type == "application/pdf" or filename.lower().endswith(".pdf")
    try:
        if is_pdf:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(raw)
            if len(pdf) < 1:
                raise ValueError("empty pdf")
            page = pdf[0]
            bitmap = page.render(scale=1.6)
            return bitmap.to_pil().convert("RGB")

        if content_type and not content_type.startswith("image/"):
            raise HTTPException(status_code=415, detail="image or pdf required")
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid image or pdf") from exc


def _plan_png(image: Image.Image, max_side: int = 1800) -> bytes:
    copy = image.copy()
    copy.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    copy.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _orientation(x1: float, y1: float, x2: float, y2: float) -> str:
    dx, dy = abs(x2 - x1), abs(y2 - y1)
    if dy <= max(4.0, dx * 0.10):
        return "horizontal"
    if dx <= max(4.0, dy * 0.10):
        return "vertical"
    return "diagonal"


def _merge_lines(lines: list[dict], fixed_tol: float, gap_tol: float) -> list[dict]:
    output: list[dict] = []
    for axis in ("horizontal", "vertical"):
        group = [line for line in lines if line["orientation"] == axis]
        group.sort(
            key=lambda item: (
                (item["a"]["y"] + item["b"]["y"]) / 2 if axis == "horizontal"
                else (item["a"]["x"] + item["b"]["x"]) / 2,
                min(item["a"]["x"], item["b"]["x"]) if axis == "horizontal"
                else min(item["a"]["y"], item["b"]["y"]),
            )
        )
        merged: list[dict] = []
        for item in group:
            a, b = item["a"], item["b"]
            fixed = (a["y"] + b["y"]) / 2 if axis == "horizontal" else (a["x"] + b["x"]) / 2
            start = min(a["x"], b["x"]) if axis == "horizontal" else min(a["y"], b["y"])
            end = max(a["x"], b["x"]) if axis == "horizontal" else max(a["y"], b["y"])

            joined = False
            for idx, old in enumerate(merged):
                oa, ob = old["a"], old["b"]
                old_fixed = (oa["y"] + ob["y"]) / 2 if axis == "horizontal" else (oa["x"] + ob["x"]) / 2
                old_start = min(oa["x"], ob["x"]) if axis == "horizontal" else min(oa["y"], ob["y"])
                old_end = max(oa["x"], ob["x"]) if axis == "horizontal" else max(oa["y"], ob["y"])
                if abs(fixed - old_fixed) > fixed_tol:
                    continue
                if start > old_end + gap_tol or old_start > end + gap_tol:
                    continue

                new_start, new_end = min(start, old_start), max(end, old_end)
                new_fixed = (fixed + old_fixed) / 2
                merged[idx] = {
                    **old,
                    "a": {"x": new_start, "y": new_fixed} if axis == "horizontal"
                         else {"x": new_fixed, "y": new_start},
                    "b": {"x": new_end, "y": new_fixed} if axis == "horizontal"
                         else {"x": new_fixed, "y": new_end},
                }
                joined = True
                break

            if not joined:
                merged.append(item)
        output.extend(merged)

    output.extend(line for line in lines if line["orientation"] == "diagonal")
    return output


def _lightweight_geometry(image: Image.Image):
    rgb = np.asarray(image)
    height, width = rgb.shape[:2]

    # Work on a bounded analysis copy to keep RAM stable on the free 512 MB service.
    max_analysis = 1400
    analysis = rgb
    scale_back = 1.0
    if max(height, width) > max_analysis:
        ratio = max_analysis / max(height, width)
        aw, ah = max(1, round(width * ratio)), max(1, round(height * ratio))
        analysis = cv2.resize(rgb, (aw, ah), interpolation=cv2.INTER_AREA)
        scale_back = 1.0 / ratio

    gray = cv2.cvtColor(analysis, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 31, 11,
    )

    # Remove tiny text/noise while preserving architectural strokes.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    min_line = max(28, round(min(binary.shape[:2]) * 0.035))
    raw = cv2.HoughLinesP(
        binary,
        rho=1,
        theta=np.pi / 180,
        threshold=max(35, min_line // 2),
        minLineLength=min_line,
        maxLineGap=max(12, round(min_line * 0.35)),
    )

    candidates: list[dict] = []
    if raw is not None:
        for idx, line in enumerate(raw[:700]):
            x1, y1, x2, y2 = map(float, line.reshape(4))
            if math.hypot(x2 - x1, y2 - y1) < min_line:
                continue
            axis = _orientation(x1, y1, x2, y2)
            candidates.append({
                "id": f"cv-{idx}",
                "a": {"x": x1 * scale_back, "y": y1 * scale_back},
                "b": {"x": x2 * scale_back, "y": y2 * scale_back},
                "thickness": 9.0 * scale_back,
                "confidence": 0.78 if axis != "diagonal" else 0.58,
                "orientation": axis,
            })

    fixed_tol = max(7.0, min(width, height) * 0.006)
    gap_tol = max(18.0, min(width, height) * 0.016)
    walls = _merge_lines(candidates, fixed_tol, gap_tol)
    walls.sort(
        key=lambda wall: math.hypot(
            wall["b"]["x"] - wall["a"]["x"],
            wall["b"]["y"] - wall["a"]["y"],
        ),
        reverse=True,
    )
    walls = walls[:180]

    # Guarantee compatibility with older APKs that require at least one wall.
    if not walls:
        margin_x = width * 0.08
        margin_y = height * 0.08
        walls = [
            {"a": {"x": margin_x, "y": margin_y}, "b": {"x": width-margin_x, "y": margin_y}},
            {"a": {"x": width-margin_x, "y": margin_y}, "b": {"x": width-margin_x, "y": height-margin_y}},
            {"a": {"x": width-margin_x, "y": height-margin_y}, "b": {"x": margin_x, "y": height-margin_y}},
            {"a": {"x": margin_x, "y": height-margin_y}, "b": {"x": margin_x, "y": margin_y}},
        ]
        for wall in walls:
            wall.update({"thickness": 10.0, "confidence": 0.4, "orientation": _orientation(
                wall["a"]["x"], wall["a"]["y"], wall["b"]["x"], wall["b"]["y"]
            )})

    for idx, wall in enumerate(walls, start=1):
        wall["id"] = f"cv-wall-{idx}"

    return width, height, walls


def _reference_payload(image: Image.Image) -> dict:
    original = image.copy()
    original.thumbnail((480, 480), Image.Resampling.LANCZOS)

    gray = ImageOps.autocontrast(ImageOps.grayscale(original))
    contrast = ImageEnhance.Contrast(gray).enhance(2.6)
    blueprint = contrast.point(lambda value: 255 if value > 205 else 24).convert("RGB")

    edges = gray.filter(ImageFilter.FIND_EDGES)
    edges = ImageOps.autocontrast(edges)
    edges = ImageOps.invert(edges)
    edges = edges.point(lambda value: 255 if value > 218 else 18).convert("RGB")

    structure = blueprint.filter(ImageFilter.MinFilter(3))

    encoded = []
    for ref in (original.convert("RGB"), blueprint, edges, structure):
        out = io.BytesIO()
        ref.save(out, format="PNG", optimize=True)
        encoded.append(base64.b64encode(out.getvalue()).decode("ascii"))

    return {
        "images": encoded,
        "width": image.width,
        "height": image.height,
    }


@app.post("/prepare-references")
async def prepare_references(file: UploadFile = File(...)):
    raw = await file.read()
    if not raw or len(raw) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="invalid upload size")

    image = _read_plan_image(raw, file.filename or "floorplan", file.content_type)
    return _reference_payload(image)


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    meters_per_pixel: float = Form(0.02),
):
    raw = await file.read()
    if not raw or len(raw) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="invalid upload size")

    image = _read_plan_image(raw, file.filename or "floorplan", file.content_type)
    width, height, walls = _lightweight_geometry(image)

    return {
        "width": width,
        "height": height,
        "engine": "opencv-lightweight",
        "walls": walls,
        "openings": [],
        "rooms": [],
        "exteriorWallIds": [],
    }


@app.post("/render-plan/{kind}")
async def render_plan(
    kind: str,
    file: UploadFile = File(...),
    floors: int = Form(1),
    furnishing: str = Form("full"),
    style: str = Form("سعودي حديث"),
    garden: bool = Form(True),
    parking: bool = Form(True),
    fence: bool = Form(True),
    entrance: str = Form("formal"),
):
    if kind not in ("interior", "exterior"):
        raise HTTPException(status_code=404, detail="unknown render kind")
    if not cloudflare_configured():
        raise HTTPException(status_code=503, detail="Cloudflare Workers AI is not configured")

    raw = await file.read()
    if not raw or len(raw) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="invalid upload size")

    image = _read_plan_image(raw, file.filename or "floorplan", file.content_type)
    plan_png = _plan_png(image)
    options = {
        "floors": max(1, min(4, int(floors))),
        "furnishing": furnishing,
        "style": style,
        "garden": bool(garden),
        "parking": bool(parking),
        "fence": bool(fence),
        "entrance": entrance,
    }

    try:
        png = render_plan_with_cloudflare(kind, plan_png, options)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Cloudflare direct-plan render failed: {type(exc).__name__}",
        ) from exc

    return Response(
        content=png,
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="manzel-h-{kind}.png"'},
    )


# Backward-compatible JSON render endpoint for older APKs.
class HouseBuildRequest(BaseModel):
    walls: list[dict]
    openings: list[dict] = Field(default_factory=list)
    rooms: list[dict] = Field(default_factory=list)
    imageSize: dict
    metersPerPixel: float
    wallHeight: float = 3.2
    wallThicknessM: float = 0.2
    style: str = "سعودي حديث"
    exteriorWallIds: list[str] = Field(default_factory=list)
    floors: int = 1
    furnishing: str = "full"
    garden: bool = True
    parking: bool = True
    fence: bool = True
    entrance: str = "formal"


@app.post("/render-image/{kind}")
def render_image(kind: str, payload: HouseBuildRequest):
    if kind not in ("interior", "exterior"):
        raise HTTPException(status_code=404, detail="unknown render kind")
    if not cloudflare_configured():
        raise HTTPException(status_code=503, detail="Cloudflare Workers AI is not configured")

    try:
        png = render_with_cloudflare(kind, payload.model_dump())
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Cloudflare render failed: {type(exc).__name__}",
        ) from exc

    return Response(content=png, media_type="image/png")
