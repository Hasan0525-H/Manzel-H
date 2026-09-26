import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type Point = { x: number; y: number };
type Wall = { id: string; a: Point; b: Point; thickness: number };
type Opening = {
  id: string;
  wallId: string;
  kind: "door" | "window";
  centerT: number;
  widthM: number;
  heightM: number;
  sillM: number;
};
type Tool = "select" | "calibrate" | "wall" | "door" | "window";

const uid = () => Math.random().toString(36).slice(2, 10);

function dist(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function snapPoint(p: Point, step = 5): Point {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

function projectToSegment(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  const q = { x: a.x + vx * t, y: a.y + vy * t };
  return { t, q, distance: dist(p, q) };
}

function pointOnWall(w: Wall, t: number): Point {
  return { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
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

  const scaleReady = !!metersPerPixel && metersPerPixel > 0;

  const totalWallLength = useMemo(() => {
    if (!scaleReady) return null;
    return walls.reduce((sum, w) => sum + dist(w.a, w.b) * metersPerPixel!, 0);
  }, [walls, metersPerPixel, scaleReady]);

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
      setMessage("تم رفع المخطط. عاير القياس أولاً للحصول على أبعاد حقيقية.");
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

  const addOpeningAt = (p: Point, kind: "door" | "window") => {
    if (!scaleReady || walls.length === 0) {
      setMessage("عاير القياس وارسم/اكتشف الجدران قبل إضافة الفتحات.");
      return;
    }
    const candidates = walls
      .map((wall) => ({ wall, ...projectToSegment(p, wall.a, wall.b) }))
      .sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    const hitTolerancePx = Math.max(22, 0.35 / metersPerPixel!);
    if (!best || best.distance > hitTolerancePx) {
      setMessage("اضغط قريبًا من الجدار لإضافة الفتحة.");
      return;
    }

    const wallLengthM = dist(best.wall.a, best.wall.b) * metersPerPixel!;
    const widthM = kind === "door" ? 0.95 : 1.4;
    const marginT = Math.min(0.2, (widthM / 2 + 0.15) / Math.max(wallLengthM, 0.1));
    const centerT = Math.max(marginT, Math.min(1 - marginT, best.t));
    setOpenings((v) => [
      ...v,
      {
        id: uid(),
        wallId: best.wall.id,
        kind,
        centerT,
        widthM,
        heightM: kind === "door" ? 2.2 : 1.35,
        sillM: kind === "door" ? 0 : 0.9,
      },
    ]);
    setMessage(kind === "door" ? "تمت إضافة باب على الجدار." : "تمت إضافة نافذة على الجدار.");
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
          const mpp = knownMeters / px;
          setMetersPerPixel(mpp);
          setMessage(`تمت المعايرة: ${(mpp * 1000).toFixed(2)} مم لكل بكسل.`);
        }
      }
      return;
    }

    if (tool === "door" || tool === "window") {
      addOpeningAt(p, tool);
      return;
    }

    if (tool === "wall") {
      if (!draftStart) {
        setDraftStart(p);
        setMessage("حدد نقطة نهاية الجدار.");
        return;
      }
      const dx = Math.abs(p.x - draftStart.x);
      const dy = Math.abs(p.y - draftStart.y);
      const end = dx > dy ? { x: p.x, y: draftStart.y } : { x: draftStart.x, y: p.y };
      if (dist(draftStart, end) > 8) {
        const thicknessPx = scaleReady ? wallThicknessM / metersPerPixel! : 12;
        setWalls((v) => [...v, { id: uid(), a: draftStart, b: end, thickness: thicknessPx }]);
        setMessage("تمت إضافة الجدار.");
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

    const maxW = 1000;
    const sc = Math.min(1, maxW / img.naturalWidth);
    const w = Math.round(img.naturalWidth * sc);
    const h = Math.round(img.naturalHeight * sc);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;

    const isWallPixel = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const blue = b > 115 && b > r * 1.18 && b > g * 1.04;
      const dark = r + g + b < 200;
      return blue || dark;
    };

    const scoreRow = (y: number) => {
      let count = 0;
      for (let x = 0; x < w; x += 2) if (isWallPixel(x, y)) count++;
      return count;
    };
    const scoreCol = (x: number) => {
      let count = 0;
      for (let y = 0; y < h; y += 2) if (isWallPixel(x, y)) count++;
      return count;
    };

    const rowScores = Array.from({ length: h }, (_, y) => scoreRow(y));
    const colScores = Array.from({ length: w }, (_, x) => scoreCol(x));
    const rowThreshold = Math.max(8, Math.floor(w * 0.035));
    const colThreshold = Math.max(8, Math.floor(h * 0.035));

    const pickPeaks = (scores: number[], threshold: number) => {
      const out: number[] = [];
      let start = -1;
      for (let i = 0; i <= scores.length; i++) {
        const on = i < scores.length && scores[i] >= threshold;
        if (on && start < 0) start = i;
        if ((!on || i === scores.length) && start >= 0) {
          const end = i - 1;
          let best = start;
          for (let j = start + 1; j <= end; j++) if (scores[j] > scores[best]) best = j;
          out.push(best);
          start = -1;
        }
      }
      return out;
    };

    const rows = pickPeaks(rowScores, rowThreshold);
    const cols = pickPeaks(colScores, colThreshold);
    const candidates: Wall[] = [];
    const k = 1 / sc;
    const minRun = Math.max(35, Math.floor(Math.min(w, h) * 0.055));

    for (const y of rows) {
      let start = -1, misses = 0;
      for (let x = 0; x <= w; x++) {
        const on = x < w && isWallPixel(x, y);
        if (on) {
          if (start < 0) start = x;
          misses = 0;
        } else if (start >= 0) {
          misses++;
          if (misses > 5 || x === w) {
            const end = x - misses;
            if (end - start >= minRun) {
              candidates.push({
                id: uid(),
                a: { x: start * k, y: y * k },
                b: { x: end * k, y: y * k },
                thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12,
              });
            }
            start = -1; misses = 0;
          }
        }
      }
    }

    for (const x of cols) {
      let start = -1, misses = 0;
      for (let y = 0; y <= h; y++) {
        const on = y < h && isWallPixel(x, y);
        if (on) {
          if (start < 0) start = y;
          misses = 0;
        } else if (start >= 0) {
          misses++;
          if (misses > 5 || y === h) {
            const end = y - misses;
            if (end - start >= minRun) {
              candidates.push({
                id: uid(),
                a: { x: x * k, y: start * k },
                b: { x: x * k, y: end * k },
                thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12,
              });
            }
            start = -1; misses = 0;
          }
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
          const near = Math.abs(m.a.y - wall.a.y) < 16;
          const overlap = Math.max(Math.min(m.a.x, m.b.x), Math.min(wall.a.x, wall.b.x)) <=
            Math.min(Math.max(m.a.x, m.b.x), Math.max(wall.a.x, wall.b.x)) + 28;
          return near && overlap;
        }
        const near = Math.abs(m.a.x - wall.a.x) < 16;
        const overlap = Math.max(Math.min(m.a.y, m.b.y), Math.min(wall.a.y, wall.b.y)) <=
          Math.min(Math.max(m.a.y, m.b.y), Math.max(wall.a.y, wall.b.y)) + 28;
        return near && overlap;
      });
      if (!duplicate) merged.push(wall);
      if (merged.length >= 180) break;
    }

    setWalls(merged);
    setOpenings([]);
    setMessage(`تم اقتراح ${merged.length} جدارًا. راجعها ثم أضف الأبواب والنوافذ.`);
  };

  const removeWall = (id: string) => {
    setWalls((v) => v.filter((w) => w.id !== id));
    setOpenings((v) => v.filter((o) => o.wallId !== id));
  };

  const removeOpening = (id: string) => setOpenings((v) => v.filter((o) => o.id !== id));

  const exportJson = () => {
    const payload = {
      version: 2,
      units: scaleReady ? "meter" : "pixel",
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
          <div className="brand">منزل H <span>ENGINE</span></div>
          <div className="subtitle">المخطط أولاً • هندسة ثابتة • طراز سعودي فوقها</div>
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
        <label className="upload">رفع المخطط<input type="file" accept="image/*" onChange={(e) => onUpload(e.target.files?.[0])} /></label>
        <button className={tool === "calibrate" ? "active" : ""} onClick={() => { setTool("calibrate"); setCalibration([]); }}>معايرة</button>
        <button className={tool === "wall" ? "active" : ""} onClick={() => setTool("wall")}>جدار</button>
        <button className={tool === "door" ? "active" : ""} onClick={() => setTool("door")}>باب</button>
        <button className={tool === "window" ? "active" : ""} onClick={() => setTool("window")}>نافذة</button>
        <button onClick={autoTrace} disabled={!imageUrl}>اقتراح الجدران</button>
        <button onClick={() => { setWalls([]); setOpenings([]); }} disabled={!walls.length}>مسح</button>
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
                <p>المعايرة بنقطتين تجعل كل جدار وكل فتحة تُحفظ بوحدة حقيقية.</p>
              </div>
            ) : (
              <svg ref={svgRef} className="plan" viewBox={`0 0 ${imageSize.w} ${imageSize.h}`} onClick={onCanvasClick}>
                <image href={imageUrl} x="0" y="0" width={imageSize.w} height={imageSize.h} opacity="0.48" />
                {walls.map((w) => (
                  <line
                    key={w.id}
                    x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y}
                    strokeWidth={Math.max(4, w.thickness)}
                    strokeLinecap="square"
                    className="wall-line"
                    onDoubleClick={(e) => { e.stopPropagation(); removeWall(w.id); }}
                  />
                ))}
                {openings.map((o) => {
                  const w = walls.find((x) => x.id === o.wallId);
                  if (!w || !scaleReady) return null;
                  const lenPx = o.widthM / metersPerPixel!;
                  const lenWall = dist(w.a, w.b);
                  const dt = lenPx / Math.max(lenWall, 1);
                  const p1 = pointOnWall(w, Math.max(0, o.centerT - dt / 2));
                  const p2 = pointOnWall(w, Math.min(1, o.centerT + dt / 2));
                  const mid = pointOnWall(w, o.centerT);
                  return (
                    <g key={o.id} onDoubleClick={(e) => { e.stopPropagation(); removeOpening(o.id); }}>
                      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="opening-cut" strokeWidth={Math.max(7, w.thickness + 5)} />
                      <circle cx={mid.x} cy={mid.y} r={o.kind === "door" ? 10 : 8} className={o.kind === "door" ? "door-mark" : "window-mark"} />
                    </g>
                  );
                })}
                {calibration.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="10" className="cal-point" />)}
                {calibration.length === 2 && <line x1={calibration[0].x} y1={calibration[0].y} x2={calibration[1].x} y2={calibration[1].y} className="cal-line" />}
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
          <span><b>{totalWallLength ? `${totalWallLength.toFixed(1)} م` : "—"}</b> أطوال الجدران</span>
        </div>
        <div className="help">حذف جدار أو فتحة: نقرتان متتاليتان عليها. الفتحات في 3D تُقص فعليًا من الجدار وليست مجرد رموز.</div>
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
    scene.background = new THREE.Color(0xf0ede6);

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(el.clientHeight, 1), 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    el.replaceChildren(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7761, 2.15));
    const sun = new THREE.DirectionalLight(0xffffff, 2.7);
    sun.position.set(12, 24, 8);
    sun.castShadow = true;
    scene.add(sun);

    const scale = props.metersPerPixel ?? 0.02;
    const cx = props.imageSize.w * scale / 2;
    const cy = props.imageSize.h * scale / 2;
    const group = new THREE.Group();

    const palette: Record<string, number> = {
      "سعودي حديث": 0xe7dfd2,
      "نجدي حديث": 0xc7a477,
      "حجازي حديث": 0xead6b8,
      "Minimal دافئ": 0xf1ece4,
    };
    const wallMat = new THREE.MeshStandardMaterial({ color: palette[props.style] ?? 0xe7dfd2, roughness: 0.72 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3b342c, roughness: 0.6 });

    const addBox = (length: number, height: number, thickness: number, x: number, y: number, z: number, angle: number, mat = wallMat) => {
      if (length <= 0.02 || height <= 0.02) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, thickness), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = angle;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    for (const wall of props.walls) {
      const ax = wall.a.x * scale - cx, az = wall.a.y * scale - cy;
      const bx = wall.b.x * scale - cx, bz = wall.b.y * scale - cy;
      const dx = bx - ax, dz = bz - az;
      const length = Math.hypot(dx, dz);
      if (length < 0.05) continue;
      const angle = -Math.atan2(dz, dx);
      const thickness = props.metersPerPixel ? Math.max(0.08, wall.thickness * scale) : props.wallThicknessM;
      const wallOpenings = props.openings.filter((o) => o.wallId === wall.id).sort((a, b) => a.centerT - b.centerT);

      if (!wallOpenings.length) {
        addBox(length, props.wallHeight, thickness, (ax + bx) / 2, props.wallHeight / 2, (az + bz) / 2, angle);
        continue;
      }

      const ux = dx / length, uz = dz / length;
      let cursor = 0;
      for (const o of wallOpenings) {
        const center = o.centerT * length;
        const half = Math.min(o.widthM / 2, length * 0.45);
        const start = Math.max(cursor, center - half);
        const end = Math.min(length, center + half);

        if (start > cursor) {
          const seg = start - cursor;
          const sMid = cursor + seg / 2;
          addBox(seg, props.wallHeight, thickness, ax + ux * sMid, props.wallHeight / 2, az + uz * sMid, angle);
        }

        const openingWidth = Math.max(0.05, end - start);
        const sill = Math.max(0, Math.min(o.sillM, props.wallHeight));
        const top = Math.min(props.wallHeight, sill + o.heightM);
        if (sill > 0.01) {
          const m = start + openingWidth / 2;
          addBox(openingWidth, sill, thickness, ax + ux * m, sill / 2, az + uz * m, angle);
        }
        if (top < props.wallHeight - 0.01) {
          const m = start + openingWidth / 2;
          const h = props.wallHeight - top;
          addBox(openingWidth, h, thickness, ax + ux * m, top + h / 2, az + uz * m, angle);
        }

        const fm = start + openingWidth / 2;
        if (o.kind === "window") {
          addBox(openingWidth, 0.07, thickness + 0.03, ax + ux * fm, sill + 0.035, az + uz * fm, angle, frameMat);
        }
        cursor = Math.max(cursor, end);
      }

      if (cursor < length) {
        const seg = length - cursor;
        const sMid = cursor + seg / 2;
        addBox(seg, props.wallHeight, thickness, ax + ux * sMid, props.wallHeight / 2, az + uz * sMid, angle);
      }
    }
    scene.add(group);

    const planW = Math.max(10, props.imageSize.w * scale);
    const planH = Math.max(10, props.imageSize.h * scale);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(planW + 4, planH + 4),
      new THREE.MeshStandardMaterial({ color: 0xd8d0c3, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(Math.max(planW, planH) + 8, 24, 0x8c8275, 0xc7beb1);
    grid.position.y = 0.003;
    scene.add(grid);

    let dragging = false, lastX = 0, lastY = 0;
    let yaw = 0.7, pitch = 0.72;
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
      lastX = e.clientX; lastY = e.clientY;
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
      const w = el.clientWidth, h = Math.max(1, el.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resize.observe(el);

    let frame = 0;
    const loop = () => { renderer.render(scene, camera); frame = requestAnimationFrame(loop); };
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
      {!props.walls.length && <div className="three-hint">اكتشف أو ارسم الجدران لتظهر هنا</div>}
      <div className="three-badge">اسحب للدوران • عجلة للتقريب</div>
    </div>
  );
}

export default App;
