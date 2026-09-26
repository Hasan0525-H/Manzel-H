from __future__ import annotations

import io
import math
import os
import threading

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
from house_builder import build_house_glb

MODEL_REPO = os.getenv("MODEL_REPO", "Yytsi/floorplan-to-3d-walls")
DEVICE_NAME = os.getenv("DEVICE", "auto")
MAX_UPLOAD = 18 * 1024 * 1024
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def choose_device():
    import torch
    if DEVICE_NAME != "auto":
        return torch.device(DEVICE_NAME)
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def pick_repo_file(files: list[str], candidates: list[str]) -> str:
    lower = {f.lower(): f for f in files}
    for candidate in candidates:
        if candidate.lower() in lower:
            return lower[candidate.lower()]
    for file in files:
        name = file.lower()
        if any(token in name for token in candidates):
            return file
    raise RuntimeError(f"required model file not found in {MODEL_REPO}: {candidates}")


def load_checkpoint(path: str, device):
    import torch
    if path.endswith(".safetensors"):
        from safetensors.torch import load_file as load_safetensors
        state = load_safetensors(path, device=str(device))
    else:
        checkpoint = torch.load(path, map_location=device, weights_only=False)
        if isinstance(checkpoint, dict):
            state = (
                checkpoint.get("model_state")
                or checkpoint.get("state_dict")
                or checkpoint.get("model")
                or checkpoint
            )
        else:
            state = checkpoint

    if any(str(k).startswith("module.") for k in state.keys()):
        state = {str(k).removeprefix("module."): v for k, v in state.items()}
    return state


def build_model():
    import segmentation_models_pytorch as smp
    import yaml
    from huggingface_hub import hf_hub_download, list_repo_files

    files = list_repo_files(MODEL_REPO)
    config_name = pick_repo_file(files, ["config.yaml", "config.yml"])
    weights_name = pick_repo_file(
        files,
        ["best.safetensors", "model.safetensors", "best.pt", "best.pth", "pytorch_model.bin"],
    )

    config_path = hf_hub_download(MODEL_REPO, config_name)
    weights_path = hf_hub_download(MODEL_REPO, weights_name)

    with open(config_path, "r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle)

    device = choose_device()
    model = smp.Unet(
        encoder_name=cfg["model"].get("encoder_name", "resnet34"),
        encoder_weights=None,
        in_channels=3,
        classes=4,
    ).to(device)
    model.load_state_dict(load_checkpoint(weights_path, device), strict=True)
    model.eval()

    size = tuple(int(v) for v in cfg.get("data", {}).get("image_size", [512, 512]))
    return model, size, device, weights_name


MODEL_LOCK = threading.Lock()

app = FastAPI(title="Manzel H ML Analyzer", version="1.2.0")
app.state.model = None
app.state.image_size = (512, 512)
app.state.device = choose_device()
app.state.weights_name = None


def ensure_model():
    if app.state.model is not None:
        return
    with MODEL_LOCK:
        if app.state.model is not None:
            return
        model, image_size, device, weights_name = build_model()
        app.state.model = model
        app.state.image_size = image_size
        app.state.device = device
        app.state.weights_name = weights_name
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
        "engine": "cubicasa-resnet34-unet",
        "device": str(app.state.device),
        "image_size": list(app.state.image_size),
        "weights": app.state.weights_name,
        "model_loaded": app.state.model is not None,
        "house_builder": True,
    }


def letterbox(image: np.ndarray, out_h: int, out_w: int):
    height, width = image.shape[:2]
    scale = min(out_w / width, out_h / height)
    inner_w = max(1, round(width * scale))
    inner_h = max(1, round(height * scale))
    resized = cv2.resize(image, (inner_w, inner_h), interpolation=cv2.INTER_AREA)

    fill = (IMAGENET_MEAN * 255).astype(np.uint8)
    canvas = np.empty((out_h, out_w, 3), dtype=np.uint8)
    canvas[:] = fill

    left = (out_w - inner_w) // 2
    top = (out_h - inner_h) // 2
    canvas[top:top + inner_h, left:left + inner_w] = resized
    return canvas, scale, left, top, inner_w, inner_h


def infer_mask(image_rgb: np.ndarray):
    import torch
    ensure_model()
    out_h, out_w = app.state.image_size
    canvas, scale, left, top, inner_w, inner_h = letterbox(image_rgb, out_h, out_w)

    arr = canvas.astype(np.float32) / 255.0
    arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    tensor = (
        torch.from_numpy(arr)
        .permute(2, 0, 1)
        .unsqueeze(0)
        .contiguous()
        .to(app.state.device)
    )

    with torch.inference_mode():
        logits = app.state.model(tensor)
        pred = logits.argmax(dim=1).squeeze(0).cpu().numpy().astype(np.uint8)

    cropped = pred[top:top + inner_h, left:left + inner_w]
    return cropped, scale


def skeletonize(binary: np.ndarray) -> np.ndarray:
    image = (binary > 0).astype(np.uint8) * 255
    skeleton = np.zeros_like(image)
    kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))

    for _ in range(1024):
        opened = cv2.morphologyEx(image, cv2.MORPH_OPEN, kernel)
        skeleton = cv2.bitwise_or(skeleton, cv2.subtract(image, opened))
        image = cv2.erode(image, kernel)
        if cv2.countNonZero(image) == 0:
            break
    return skeleton


def orientation(x1: float, y1: float, x2: float, y2: float) -> str:
    dx, dy = abs(x2 - x1), abs(y2 - y1)
    if dy <= max(3.0, dx * 0.10):
        return "horizontal"
    if dx <= max(3.0, dy * 0.10):
        return "vertical"
    return "diagonal"


def merge_axis_segments(items: list[dict], fixed_tol: float, gap_tol: float) -> list[dict]:
    output: list[dict] = []

    for axis in ("horizontal", "vertical"):
        group = [item for item in items if item["orientation"] == axis]
        if axis == "horizontal":
            group.sort(key=lambda item: ((item["a"]["y"] + item["b"]["y"]) / 2, min(item["a"]["x"], item["b"]["x"])))
        else:
            group.sort(key=lambda item: ((item["a"]["x"] + item["b"]["x"]) / 2, min(item["a"]["y"], item["b"]["y"])))

        merged: list[dict] = []
        for item in group:
            a, b = item["a"], item["b"]
            fixed = (a["y"] + b["y"]) / 2 if axis == "horizontal" else (a["x"] + b["x"]) / 2
            start = min(a["x"], b["x"]) if axis == "horizontal" else min(a["y"], b["y"])
            end = max(a["x"], b["x"]) if axis == "horizontal" else max(a["y"], b["y"])

            did_merge = False
            for index, old in enumerate(merged):
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
                merged[index] = {
                    **old,
                    "a": {"x": new_start, "y": new_fixed} if axis == "horizontal" else {"x": new_fixed, "y": new_start},
                    "b": {"x": new_end, "y": new_fixed} if axis == "horizontal" else {"x": new_fixed, "y": new_end},
                    "confidence": max(old["confidence"], item["confidence"]),
                }
                did_merge = True
                break

            if not did_merge:
                merged.append(item)

        output.extend(merged)

    output.extend(item for item in items if item["orientation"] == "diagonal")
    return output


def project_to_wall(px: float, py: float, wall: dict):
    ax, ay = wall["a"]["x"], wall["a"]["y"]
    bx, by = wall["b"]["x"], wall["b"]["y"]
    vx, vy = bx - ax, by - ay
    length2 = vx * vx + vy * vy
    if length2 <= 1e-9:
        return 0.0, math.hypot(px - ax, py - ay)

    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / length2))
    qx, qy = ax + vx * t, ay + vy * t
    return t, math.hypot(px - qx, py - qy)


def extract_geometry(mask: np.ndarray, original_w: int, original_h: int, scale: float, meters_per_pixel: float):
    wall_mask = (mask == 1).astype(np.uint8) * 255
    wall_mask = cv2.morphologyEx(
        wall_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
        iterations=1,
    )
    skeleton = skeletonize(wall_mask)

    min_line = max(24, round(min(mask.shape[:2]) * 0.045))
    raw_lines = cv2.HoughLinesP(
        skeleton,
        rho=1,
        theta=np.pi / 180,
        threshold=max(22, min_line // 2),
        minLineLength=min_line,
        maxLineGap=max(8, round(min_line * 0.35)),
    )

    distance_map = cv2.distanceTransform(wall_mask, cv2.DIST_L2, 5)
    widths = distance_map[skeleton > 0] * 2
    thickness_model_px = float(np.median(widths[widths > 1])) if np.any(widths > 1) else 8.0

    inv_scale = 1.0 / scale
    candidates: list[dict] = []

    if raw_lines is not None:
        for index, line in enumerate(raw_lines[:500]):
            x1, y1, x2, y2 = map(float, line.reshape(4))
            length = math.hypot(x2 - x1, y2 - y1)
            if length < min_line:
                continue

            axis = orientation(x1, y1, x2, y2)
            candidates.append({
                "id": f"raw-{index}",
                "a": {"x": x1 * inv_scale, "y": y1 * inv_scale},
                "b": {"x": x2 * inv_scale, "y": y2 * inv_scale},
                "thickness": max(5.0, min(60.0, thickness_model_px * inv_scale)),
                "confidence": 0.92 if axis != "diagonal" else 0.76,
                "orientation": axis,
            })

    fixed_tolerance = max(7.0, min(original_w, original_h) * 0.005)
    gap_tolerance = max(15.0, min(original_w, original_h) * 0.012)
    walls = merge_axis_segments(candidates, fixed_tolerance, gap_tolerance)

    walls.sort(
        key=lambda wall: math.hypot(
            wall["b"]["x"] - wall["a"]["x"],
            wall["b"]["y"] - wall["a"]["y"],
        ),
        reverse=True,
    )
    walls = walls[:220]
    for index, wall in enumerate(walls):
        wall["id"] = f"ml-wall-{index + 1}"

    openings: list[dict] = []
    for class_id, kind in ((2, "door"), (3, "window")):
        binary = (mask == class_id).astype(np.uint8) * 255
        binary = cv2.morphologyEx(
            binary,
            cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
            iterations=1,
        )
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for contour in contours:
            if cv2.contourArea(contour) < 12:
                continue

            x, y, width, height = cv2.boundingRect(contour)
            center_x = (x + width / 2) * inv_scale
            center_y = (y + height / 2) * inv_scale

            if not walls:
                continue

            ranked = []
            for wall in walls:
                t, distance = project_to_wall(center_x, center_y, wall)
                ranked.append((distance, t, wall))
            ranked.sort(key=lambda item: item[0])

            distance, t, host = ranked[0]
            if distance > max(original_w, original_h) * 0.07:
                continue

            detected_px = max(width, height) * inv_scale
            detected_m = detected_px * meters_per_pixel

            if kind == "door":
                opening_width = max(0.72, min(1.6, detected_m))
                opening_height = 2.2
                sill = 0.0
            else:
                opening_width = max(0.65, min(2.8, detected_m))
                opening_height = 1.35
                sill = 0.9

            openings.append({
                "id": f"ml-{kind}-{len(openings) + 1}",
                "wallId": host["id"],
                "kind": kind,
                "centerT": t,
                "widthM": opening_width,
                "heightM": opening_height,
                "sillM": sill,
                "confidence": 0.90,
            })

    return walls, openings[:120]


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    meters_per_pixel: float = Form(0.02),
):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="image required")

    raw = await file.read()
    if not raw or len(raw) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="invalid upload size")

    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid image") from exc

    rgb = np.asarray(image)
    height, width = rgb.shape[:2]
    mask, model_scale = infer_mask(rgb)

    walls, openings = extract_geometry(
        mask=mask,
        original_w=width,
        original_h=height,
        scale=model_scale,
        meters_per_pixel=max(0.003, min(0.08, meters_per_pixel)),
    )

    return {
        "width": width,
        "height": height,
        "engine": "cubicasa-resnet34-unet",
        "walls": walls,
        "openings": openings,
    }


class HouseBuildRequest(BaseModel):
    walls: list[dict]
    openings: list[dict] = []
    imageSize: dict
    metersPerPixel: float
    wallHeight: float = 3.2
    wallThicknessM: float = 0.2
    style: str = "سعودي حديث"
    exteriorWallIds: list[str] = []


@app.post("/build-house")
def build_house(payload: HouseBuildRequest):
    try:
        glb = build_house_glb(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="house build failed") from exc

    return Response(
        content=glb,
        media_type="model/gltf-binary",
        headers={"Content-Disposition": 'inline; filename="manzel-h.glb"'},
    )
