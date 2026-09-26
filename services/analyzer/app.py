from __future__ import annotations

import io
import math
import os
from typing import Literal

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

app = FastAPI(title="Manzel H Analyzer", version="0.1.0")

allowed_origin = os.getenv("ALLOWED_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[allowed_origin] if allowed_origin != "*" else ["*"],
    allow_credentials=allowed_origin != "*",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class Point(BaseModel):
    x: float
    y: float


class WallProposal(BaseModel):
    id: str
    a: Point
    b: Point
    thickness: float
    confidence: float
    orientation: Literal["horizontal", "vertical", "diagonal"]


class AnalyzeResponse(BaseModel):
    width: int
    height: int
    walls: list[WallProposal]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _orientation(x1: float, y1: float, x2: float, y2: float) -> str:
    dx = abs(x2 - x1)
    dy = abs(y2 - y1)
    if dy <= max(3.0, dx * 0.08):
        return "horizontal"
    if dx <= max(3.0, dy * 0.08):
        return "vertical"
    return "diagonal"


def _normalize_segment(line: np.ndarray) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = map(float, line.reshape(4))
    if (x2 < x1) or (x1 == x2 and y2 < y1):
        x1, x2 = x2, x1
        y1, y2 = y2, y1
    return x1, y1, x2, y2


def _merge_axis_segments(
    segments: list[tuple[float, float, float, float, float]],
    orientation: str,
    fixed_tolerance: float,
    gap_tolerance: float,
) -> list[tuple[float, float, float, float, float]]:
    if orientation == "horizontal":
        entries = sorted(
            segments,
            key=lambda s: ((s[1] + s[3]) / 2.0, min(s[0], s[2])),
        )
    else:
        entries = sorted(
            segments,
            key=lambda s: ((s[0] + s[2]) / 2.0, min(s[1], s[3])),
        )

    merged: list[tuple[float, float, float, float, float]] = []
    for seg in entries:
        x1, y1, x2, y2, score = seg
        fixed = (y1 + y2) / 2.0 if orientation == "horizontal" else (x1 + x2) / 2.0
        start = min(x1, x2) if orientation == "horizontal" else min(y1, y2)
        end = max(x1, x2) if orientation == "horizontal" else max(y1, y2)

        matched = False
        for idx, existing in enumerate(merged):
            ex1, ey1, ex2, ey2, escore = existing
            efixed = (ey1 + ey2) / 2.0 if orientation == "horizontal" else (ex1 + ex2) / 2.0
            estart = min(ex1, ex2) if orientation == "horizontal" else min(ey1, ey2)
            eend = max(ex1, ex2) if orientation == "horizontal" else max(ey1, ey2)
            if abs(fixed - efixed) > fixed_tolerance:
                continue
            if start > eend + gap_tolerance or estart > end + gap_tolerance:
                continue

            nstart = min(start, estart)
            nend = max(end, eend)
            nfixed = (fixed + efixed) / 2.0
            nscore = min(0.99, max(score, escore) + 0.03)
            if orientation == "horizontal":
                merged[idx] = (nstart, nfixed, nend, nfixed, nscore)
            else:
                merged[idx] = (nfixed, nstart, nfixed, nend, nscore)
            matched = True
            break

        if not matched:
            merged.append(seg)
    return merged


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(file: UploadFile = File(...)) -> AnalyzeResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Only image uploads are supported")

    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image is too large")

    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid image") from exc

    rgb = np.asarray(image)
    height, width = rgb.shape[:2]

    max_side = 1800
    scale = min(1.0, max_side / float(max(width, height)))
    if scale < 1.0:
        work = cv2.resize(
            cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
            (round(width * scale), round(height * scale)),
            interpolation=cv2.INTER_AREA,
        )
    else:
        work = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blur, 45, 130)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=1)

    min_line = max(35, round(min(work.shape[:2]) * 0.045))
    raw_lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=max(30, min_line // 2),
        minLineLength=min_line,
        maxLineGap=max(8, round(min_line * 0.22)),
    )

    if raw_lines is None:
        return AnalyzeResponse(width=width, height=height, walls=[])

    inv_scale = 1.0 / scale
    horizontal: list[tuple[float, float, float, float, float]] = []
    vertical: list[tuple[float, float, float, float, float]] = []
    diagonal: list[tuple[float, float, float, float, float]] = []

    for line in raw_lines:
        x1, y1, x2, y2 = _normalize_segment(line)
        length = math.hypot(x2 - x1, y2 - y1)
        if length < min_line:
            continue
        ori = _orientation(x1, y1, x2, y2)
        confidence = min(0.96, 0.55 + length / max(work.shape[:2]) * 0.7)
        item = (x1, y1, x2, y2, confidence)
        if ori == "horizontal":
            horizontal.append(item)
        elif ori == "vertical":
            vertical.append(item)
        else:
            diagonal.append(item)

    fixed_tolerance = max(4.0, min(work.shape[:2]) * 0.007)
    gap_tolerance = max(12.0, min(work.shape[:2]) * 0.018)
    horizontal = _merge_axis_segments(horizontal, "horizontal", fixed_tolerance, gap_tolerance)
    vertical = _merge_axis_segments(vertical, "vertical", fixed_tolerance, gap_tolerance)

    proposals: list[WallProposal] = []
    combined = [
        ("horizontal", horizontal),
        ("vertical", vertical),
        ("diagonal", diagonal[:30]),
    ]
    counter = 1
    default_thickness = max(8.0, min(width, height) * 0.008)

    for ori, lines in combined:
        for x1, y1, x2, y2, confidence in lines:
            proposals.append(
                WallProposal(
                    id=f"cv-{counter}",
                    a=Point(x=x1 * inv_scale, y=y1 * inv_scale),
                    b=Point(x=x2 * inv_scale, y=y2 * inv_scale),
                    thickness=default_thickness,
                    confidence=confidence,
                    orientation=ori,
                )
            )
            counter += 1

    proposals.sort(
        key=lambda w: math.hypot(w.b.x - w.a.x, w.b.y - w.a.y),
        reverse=True,
    )
    return AnalyzeResponse(width=width, height=height, walls=proposals[:220])
