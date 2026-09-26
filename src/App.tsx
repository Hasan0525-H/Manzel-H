import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type Point = { x: number; y: number };
type Wall = { id: string; a: Point; b: Point; thickness: number };
type OpeningKind = "door" | "window";
type Opening = {
  id: string;
  wallId: string;
  kind: OpeningKind;
  t: number;
  widthM: number;
  heightM: number;
  sillM: number;
};
type Tool = "select" | "calibrate" | "wall" | "door" | "window";

const uid = () => Math.random().toString(36).slice(2, 9);

function dist(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function snapPoint(p: Point, step = 5): Point {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

function nearestWallPoint(p: Point, walls: Wall[]) {
  let best: { wall: Wall; t: number; point: Point; d: number } | null = null;
  for (const wall of walls) {
    const vx = wall.b.x - wall.a.x;
    const vy = wall.b.y - wall.a.y;
    const len2 = vx * vx + vy * vy;
    if (!len2) continue;
    const rawT = ((p.x - wall.a.x) * vx + (p.y - wall.a.y) * vy) / len2;
    const t = Math.max(0, Math.min(1, rawT));
    const point = { x: wall.a.x + vx * t, y: wall.a.y + vy * t };
    const d = dist(p, point);
    if (!best || d < best.d) best = { wall, t, point, d };
  }
  return best;
}

function openingPoint(opening: Opening, wall: Wall): Point {
  return {
    x: wall.a.x + (wall.b.x - wall.a.x) * opening.t,
    y: wall.a.y + (wall.b.y - wall.a.y) * opening.t,
  };
}

function App() {
  const [imageUrl, setImageUrl] = useState("");
  const [imageSize, setImageSize] = useState({ w: 1200, h: 800 });
  const [walls, setWalls] = useState<Wall[]>([]);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [draftStart, setDraftStart] = useState<Point | null>(null);
  const [calibration, setCalibration] = useState<Point[]>([]);
  const [knownMeters, setKnownMeters] = useState(4);
  const [metersPerPixel, setMetersPerPixel] = useState<number | null>(null);
  const [wallHeight, setWallHeight] = useState(3.2);
  const [wallThicknessM, setWallThicknessM] = useState(0.2);
  const [style, setStyle] = useState("سعودي حديث");
  const [view, setView] = useState<"2d" | "3d" | "split">("split");
  const [message, setMessage] = useState("ارفع المخطط، ثم عاير القياس من بُعد معروف.");
  const svgRef = useRef<SVGSVGElement | null>(null);

  const scaleReady = metersPerPixel !== null && metersPerPixel > 0;

  const floorAreaEstimate = useMemo(() => {
    if (!scaleReady || !imageSize.w || !imageSize.h) return null;
    return imageSize.w * metersPerPixel! * imageSize.h * metersPerPixel!;
  }, [scaleReady, imageSize, metersPerPixel]);

  const onUpload = (file?: File) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
      setImageUrl(url);
      setWalls([]);
      setOpenings([]);
      setCalibration([]);
      setMetersPerPixel(null);
      setMessage("تم رفع المخطط. عاير بُعدًا معروفًا ثم استخرج الجدران.");
    };
    img.src = url;
  };

  const eventPoint = (e: React.MouseEvent<SVGSVGElement>): Point => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    return snapPoint({
      x: ((e.clientX - rect.left) / rect.width) * imageSize.w,
      y: ((e.clientY - rect.top) / rect.height) * imageSize.h,
    });
  };

  const addOpening = (kind: OpeningKind, p: Point) => {
    if (!scaleReady) {
      setMessage("عاير المقياس أولاً حتى يكون عرض الباب أو النافذة حقيقيًا.");
      return;
    }
    const nearest = nearestWallPoint(p, walls);
    if (!nearest) return;
    const maxPxDistance = Math.max(30, 0.45 / metersPerPixel!);
    if (nearest.d > maxPxDistance) {
      setMessage("اضغط قريبًا من الجدار المطلوب.");
      return;
    }
    const opening: Opening = kind === "door"
      ? { id: uid(), wallId: nearest.wall.id, kind, t: nearest.t, widthM: 0.95, heightM: 2.2, sillM: 0 }
      : { id: uid(), wallId: nearest.wall.id, kind, t: nearest.t, widthM: 1.4, heightM: 1.3, sillM: 0.9 };
    setOpenings((v) => [...v, opening]);
    setMessage(kind === "door" ? "تمت إضافة باب 95 سم. انقر مزدوجًا على رمزه لحذفه." : "تمت إضافة نافذة 140 سم.");
  };

  const onCanvasClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!imageUrl) return;
    const p = eventPoint(e);

    if (tool === "calibrate") {
      const next = calibration.length >= 2 ? [p] : [...calibration, p];
      setCalibration(next);
      if (next.length === 2) {
        const px = dist(next[0], next[1]);
        if (px > 0 && knownMeters > 0) {
          setMetersPerPixel(knownMeters / px);
          setMessage(`تمت المعايرة: ${(knownMeters / px * 1000).toFixed(2)} مم/بكسل.`);
        }
      }
      return;
    }

    if (tool === "door" || tool === "window") {
      addOpening(tool, p);
      return;
    }

    if (tool === "wall") {
      if (!draftStart) {
        setDraftStart(p);
        return;
      }
      const dx = Math.abs(p.x - draftStart.x);
      const dy = Math.abs(p.y - draftStart.y);
      const end = dx > dy ? { x: p.x, y: draftStart.y } : { x: draftStart.x, y: p.y };
      if (dist(draftStart, end) > 8) {
        const thicknessPx = scaleReady ? wallThicknessM / metersPerPixel! : 12;
        setWalls((v) => [...v, { id: uid(), a: draftStart, b: end, thickness: thicknessPx }]);
      }
      setDraftStart(null);
    }
  };

  const autoTrace = async () => {
    if (!imageUrl) return;
    setMessage("جاري اقتراح الجدران من الصورة...");
    const img = new Image();
    img.src = imageUrl;
    await img.decode();

    const maxW = 900;
    const downScale = Math.min(1, maxW / img.naturalWidth);
    const w = Math.round(img.naturalWidth * downScale);
    const h = Math.round(img.naturalHeight * downScale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const isWallPixel = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const blueWall = b > 105 && b > r * 1.14 && b > g * 1.03;
      const darkInk = r + g + b < 210;
      return blueWall || darkInk;
    };

    const candidates: Wall[] = [];
    const minRun = Math.max(45, Math.floor(w * 0.055));
    const rowStep = Math.max(3, Math.round(h / 190));
    const colStep = Math.max(3, Math.round(w / 190));

    for (let y = 0; y < h; y += rowStep) {
      let start = -1;
      for (let x = 0; x <= w; x++) {
        const on = x < w && isWallPixel(x, y);
        if (on && start < 0) start = x;
        if ((!on || x === w) && start >= 0) {
          if (x - start >= minRun) {
            const k = 1 / downScale;
            candidates.push({
              id: uid(),
              a: { x: start * k, y: y * k },
              b: { x: (x - 1) * k, y: y * k },
              thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12,
            });
          }
          start = -1;
        }
      }
    }

    for (let x = 0; x < w; x += colStep) {
      let start = -1;
      for (let y = 0; y <= h; y++) {
        const on = y < h && isWallPixel(x, y);
        if (on && start < 0) start = y;
        if ((!on || y === h) && start >= 0) {
          if (y - start >= minRun) {
            const k = 1 / downScale;
            candidates.push({
              id: uid(),
              a: { x: x * k, y: start * k },
              b: { x: x * k, y: (y - 1) * k },
              thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12,
            });
          }
          start = -1;
        }
      }
    }

    const merged: Wall[] = [];
    for (const wall of candidates) {
      const horizontal = Math.abs(wall.a.y - wall.b.y) < 1;
      const duplicate = merged.some((m) => {
        const mh = Math.abs(m.a.y - m.b.y) < 1;
        if (mh !== horizontal) return false;
        if (horizontal) {
          return Math.abs(m.a.y - wall.a.y) < 16 &&
            Math.max(m.a.x, wall.a.x) <= Math.min(m.b.x, wall.b.x) + 40;
        }
        return Math.abs(m.a.x - wall.a.x) < 16 &&
          Math.max(m.a.y, wall.a.y) <= Math.min(m.b.y, wall.b.y) + 40;
      });
      if (!duplicate) merged.push(wall);
      if (merged.length >= 140) break;
    }

    setWalls(merged);
    setOpenings([]);
    setMessage(`تم اقتراح ${merged.length} جدارًا. الآن راجعها وأضف الأبواب والنوافذ.`);
  };

  const exportJson = () => {
    const payload = {
      version: 2,
      units: "meter",
      image: { width: imageSize.w, height: imageSize.h },
      calibration: { knownMeters, metersPerPixel },
      building: { wallHeight, wallThicknessM, style },
      walls: walls.map((w) => ({
        id: w.id,
        a: scaleReady ? { x: w.a.x * metersPerPixel!, y: w.a.y * metersPerPixel! } : w.a,
        b: scaleReady ? { x: w.b.x * metersPerPixel!, y: w.b.y * metersPerPixel! } : w.b,
        thickness: scaleReady ? w.thickness * metersPerPixel! : w.thickness,
      })),
      openings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "manzel-h-plan.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">منزل H <span>LAB</span></div>
          <div className="subtitle">2D → هندسة دقيقة → منزل سعودي 3D</div>
        </div>
        <div className="view-switch">
          {(["2d", "split", "3d"] as const).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {v === "2d" ? "2D" : v === "3d" ? "3D" : "مزدوج"}
            </button>
          ))}
        </div>
      </header>

      <section className="toolbar">
        <label className="upload">
          رفع المخطط
          <input type="file" accept="image/*" onChange={(e) => onUpload(e.target.files?.[0])} />
        </label>
        <button className={tool === "calibrate" ? "active" : ""} onClick={() => { setTool("calibrate"); setCalibration([]); }}>معايرة</button>
        <button className={tool === "wall" ? "active" : ""} onClick={() => setTool("wall")}>جدار</button>
        <button className={tool === "door" ? "active" : ""} onClick={() => setTool("door")} disabled={!walls.length}>باب</button>
        <button className={tool === "window" ? "active" : ""} onClick={() => setTool("window")} disabled={!walls.length}>نافذة</button>
        <button onClick={autoTrace} disabled={!imageUrl}>اقتراح الجدران</button>
        <button onClick={() => { setWalls([]); setOpenings([]); }} disabled={!walls.length}>مسح الهندسة</button>
        <button onClick={exportJson} disabled={!walls.length}>تصدير JSON</button>
      </section>

      <section className="status">{message}</section>

      <main className={`workspace ${view}`}>
        {view !== "3d" && (
          <section className="panel plan-panel">
            {!imageUrl ? (
              <div className="empty">
                <div className="upload-mark">＋</div>
                <h2>ارفع صورة المخطط</h2>
                <p>عاير بُعدًا واحدًا معروفًا، ثم راجع الجدران وأضف الفتحات قبل اعتماد 3D.</p>
              </div>
            ) : (
              <svg ref={svgRef} className="plan" viewBox={`0 0 ${imageSize.w} ${imageSize.h}`} onClick={onCanvasClick}>
                <image href={imageUrl} x="0" y="0" width={imageSize.w} height={imageSize.h} opacity="0.5" />
                {walls.map((w) => (
                  <line
                    key={w.id}
                    x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y}
                    stroke="currentColor"
                    strokeWidth={Math.max(4, w.thickness)}
                    strokeLinecap="square"
                    className="wall-line"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setWalls((all) => all.filter((x) => x.id !== w.id));
                      setOpenings((all) => all.filter((o) => o.wallId !== w.id));
                    }}
                  />
                ))}
                {openings.map((o) => {
                  const wall = walls.find((w) => w.id === o.wallId);
                  if (!wall || !scaleReady) return null;
                  const p = openingPoint(o, wall);
                  const len = dist(wall.a, wall.b);
                  const ux = (wall.b.x - wall.a.x) / len;
                  const uy = (wall.b.y - wall.a.y) / len;
                  const half = (o.widthM / metersPerPixel!) / 2;
                  return (
                    <line
                      key={o.id}
                      x1={p.x - ux * half}
                      y1={p.y - uy * half}
                      x2={p.x + ux * half}
                      y2={p.y + uy * half}
                      className={o.kind === "door" ? "opening door-opening" : "opening window-opening"}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setOpenings((all) => all.filter((x) => x.id !== o.id));
                      }}
                    />
                  );
                })}
                {calibration.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="10" className="cal-point" />)}
                {calibration.length === 2 && (
                  <line x1={calibration[0].x} y1={calibration[0].y} x2={calibration[1].x} y2={calibration[1].y} className="cal-line" />
                )}
                {draftStart && <circle cx={draftStart.x} cy={draftStart.y} r="9" className="draft-point" />}
              </svg>
            )}
          </section>
        )}

        {view !== "2d" && (
          <section className="panel render-panel">
            <ThreePreview
              walls={walls}
              openings={openings}
              imageSize={imageSize}
              metersPerPixel={metersPerPixel}
              wallHeight={wallHeight}
              wallThicknessM={wallThicknessM}
              style={style}
            />
          </section>
        )}
      </main>

      <aside className="inspector">
        <div className="inspector-grid">
          <label>البُعد المعروف (م)
            <input type="number" step="0.01" value={knownMeters} onChange={(e) => setKnownMeters(Number(e.target.value))} />
          </label>
          <label>ارتفاع الجدار (م)
            <input type="number" step="0.1" value={wallHeight} onChange={(e) => setWallHeight(Number(e.target.value))} />
          </label>
          <label>سماكة الجدار (م)
            <input type="number" step="0.01" value={wallThicknessM} onChange={(e) => setWallThicknessM(Number(e.target.value))} />
          </label>
          <label>الطراز
            <select value={style} onChange={(e) => setStyle(e.target.value)}>
              <option>سعودي حديث</option>
              <option>نجدي حديث</option>
              <option>حجازي حديث</option>
              <option>Minimal دافئ</option>
            </select>
          </label>
        </div>
        <div className="metrics">
          <span><b>{walls.length}</b> جدار</span>
          <span><b>{openings.filter((o) => o.kind === "door").length}</b> باب</span>
          <span><b>{openings.filter((o) => o.kind === "window").length}</b> نافذة</span>
          <span><b>{scaleReady ? `${(metersPerPixel! * 1000).toFixed(2)} مم/px` : "غير معاير"}</b> مقياس</span>
          <span><b>{floorAreaEstimate ? `${floorAreaEstimate.toFixed(0)} م²` : "—"}</b> إطار الصورة</span>
        </div>
      </aside>
    </div>
  );
}

function ThreePreview(props: {
  walls: Wall[];
  openings: Opening[];
  imageSize: { w: number; h: number };
  metersPerPixel: number | null;
  wallHeight: number;
  wallThicknessM: number;
  style: string;
}) {
  const mount = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mount.current) return;
    const el = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1eee7);

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(el.clientHeight, 1), 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    el.replaceChildren(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8d7c66, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.8);
    sun.position.set(12, 24, 8);
    sun.castShadow = true;
    scene.add(sun);

    const scale = props.metersPerPixel ?? 0.02;
    const cx = props.imageSize.w * scale / 2;
    const cy = props.imageSize.h * scale / 2;
    const group = new THREE.Group();

    const palette: Record<string, number> = {
      "سعودي حديث": 0xe9e0d1,
      "نجدي حديث": 0xc9a778,
      "حجازي حديث": 0xe9d8bd,
      "Minimal دافئ": 0xf2eee8,
    };
    const wallMat = new THREE.MeshStandardMaterial({ color: palette[props.style] ?? 0xe9e0d1, roughness: 0.72 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x5b4635, roughness: 0.55 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xa9c7d8, roughness: 0.18, metalness: 0.08, transparent: true, opacity: 0.55 });

    const addBoxOnWall = (
      wall: Wall,
      alongStart: number,
      alongEnd: number,
      yStart: number,
      yEnd: number,
      material: THREE.Material
    ) => {
      const ax = wall.a.x * scale - cx;
      const az = wall.a.y * scale - cy;
      const bx = wall.b.x * scale - cx;
      const bz = wall.b.y * scale - cy;
      const fullLength = Math.hypot(bx - ax, bz - az);
      if (fullLength < 0.05 || alongEnd <= alongStart || yEnd <= yStart) return;
      const ux = (bx - ax) / fullLength;
      const uz = (bz - az) / fullLength;
      const length = alongEnd - alongStart;
      const mid = (alongStart + alongEnd) / 2;
      const thickness = props.metersPerPixel ? Math.max(0.08, wall.thickness * scale) : props.wallThicknessM;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, yEnd - yStart, thickness), material);
      mesh.position.set(ax + ux * mid, (yStart + yEnd) / 2, az + uz * mid);
      mesh.rotation.y = -Math.atan2(bz - az, bx - ax);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    for (const wall of props.walls) {
      const ax = wall.a.x * scale - cx;
      const az = wall.a.y * scale - cy;
      const bx = wall.b.x * scale - cx;
      const bz = wall.b.y * scale - cy;
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.05) continue;

      const wallOpenings = props.openings
        .filter((o) => o.wallId === wall.id)
        .map((o) => {
          const center = o.t * length;
          return { ...o, start: Math.max(0, center - o.widthM / 2), end: Math.min(length, center + o.widthM / 2) };
        })
        .sort((a, b) => a.start - b.start);

      let cursor = 0;
      for (const opening of wallOpenings) {
        if (opening.start > cursor) addBoxOnWall(wall, cursor, opening.start, 0, props.wallHeight, wallMat);
        const top = Math.min(props.wallHeight, opening.sillM + opening.heightM);
        if (opening.sillM > 0) addBoxOnWall(wall, opening.start, opening.end, 0, opening.sillM, wallMat);
        if (top < props.wallHeight) addBoxOnWall(wall, opening.start, opening.end, top, props.wallHeight, wallMat);

        const frameDepth = Math.max(0.08, props.wallThicknessM * 0.45);
        const openingCenter = (opening.start + opening.end) / 2;
        const ux = (bx - ax) / length;
        const uz = (bz - az) / length;
        const thickness = props.metersPerPixel ? Math.max(0.08, wall.thickness * scale) : props.wallThicknessM;
        const frame = new THREE.Mesh(
          new THREE.BoxGeometry(Math.max(0.08, opening.end - opening.start - 0.08), Math.max(0.1, opening.heightM - 0.08), frameDepth),
          opening.kind === "window" ? glassMat : frameMat
        );
        frame.position.set(
          ax + ux * openingCenter,
          opening.sillM + opening.heightM / 2,
          az + uz * openingCenter
        );
        frame.rotation.y = -Math.atan2(bz - az, bx - ax);
        frame.position.x += -uz * thickness * 0.15;
        frame.position.z += ux * thickness * 0.15;
        group.add(frame);
        cursor = Math.max(cursor, opening.end);
      }
      if (cursor < length) addBoxOnWall(wall, cursor, length, 0, props.wallHeight, wallMat);
    }
    scene.add(group);

    const planW = Math.max(10, props.imageSize.w * scale);
    const planH = Math.max(10, props.imageSize.h * scale);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(planW + 4, planH + 4),
      new THREE.MeshStandardMaterial({ color: 0xd9d1c5, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(Math.max(planW, planH) + 8, 24, 0x8c8275, 0xc7beb1);
    grid.position.y = 0.003;
    scene.add(grid);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let yaw = 0.7;
    let pitch = 0.72;
    let radius = Math.max(18, Math.max(planW, planH) * 1.05);

    const updateCamera = () => {
      pitch = Math.max(0.12, Math.min(1.42, pitch));
      camera.position.set(
        Math.cos(yaw) * Math.cos(pitch) * radius,
        Math.sin(pitch) * radius,
        Math.sin(yaw) * Math.cos(pitch) * radius
      );
      camera.lookAt(0, 1.2, 0);
    };
    updateCamera();

    const down = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; renderer.domElement.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.008;
      pitch += (e.clientY - lastY) * 0.006;
      lastX = e.clientX;
      lastY = e.clientY;
      updateCamera();
    };
    const up = () => { dragging = false; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      radius *= e.deltaY > 0 ? 1.08 : 0.92;
      radius = Math.max(5, Math.min(120, radius));
      updateCamera();
    };

    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("wheel", wheel, { passive: false });

    const resize = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = Math.max(1, el.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resize.observe(el);

    let frame = 0;
    const loop = () => {
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      renderer.dispose();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("wheel", wheel);
    };
  }, [props.walls, props.openings, props.imageSize, props.metersPerPixel, props.wallHeight, props.wallThicknessM, props.style]);

  return (
    <div className="three-wrap" ref={mount}>
      {!props.walls.length && <div className="three-hint">ارسم أو استخرج الجدران لتظهر هنا مباشرة</div>}
      <div className="three-badge">فتحات حقيقية • اسحب للدوران • عجلة للتقريب</div>
    </div>
  );
}

export default App;
