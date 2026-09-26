from __future__ import annotations

import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
ML_DIR = ROOT / "ml-analyzer"
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from render_images_v2 import render_exterior, render_interior  # noqa: E402

app = FastAPI(title="Manzel H AI Render Gateway", version="15.0")

allowed_origin = os.getenv("ALLOWED_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allowed_origin == "*" else [allowed_origin],
    allow_credentials=allowed_origin != "*",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class RenderRequest(BaseModel):
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


@app.get("/health")
def health():
    return {
        "ok": True,
        "platform": "server-cpu",
        "model": "deterministic-pillow-renderer",
        "configured": True,
    }


@app.post("/render-image/{kind}")
def render_image(kind: str, payload: RenderRequest):
    if kind not in ("interior", "exterior"):
        raise HTTPException(status_code=404, detail="unknown render kind")
    try:
        data = payload.model_dump()
        image = render_interior(data, size=1536) if kind == "interior" else render_exterior(data, width=1536, height=2048)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"server render failed: {type(exc).__name__}") from exc

    return Response(
        content=image,
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="manzel-h-v15-{kind}.png"'},
    )
