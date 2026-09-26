import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type Point = { x: number; y: number };
type Wall = { id: string; a: Point; b: Point; thickness: number };
type Tool = "select" | "calibrate" | "wall";

const uid = () => Math.random().toString(36).slice(2, 9);

function dist(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function snapPoint(p: Point, step = 5): Point {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

function App() {
  const [imageUrl, setImageUrl] = useState<string>("");
  const [imageSize, setImageSize] = useState({ w: 1200, h: 800 });
  const [walls, setWalls] = useState<Wall[]>([]);
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
      setCalibration([]);
      setMetersPerPixel(null);
      setMessage("تم رفع المخطط. اختر «معايرة» واضغط نقطتين على بُعد مكتوب بالمخطط.");
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
          setMessage(`تمت المعايرة: ${(knownMeters / px * 1000).toFixed(2)} مم لكل بكسل.`);
        }
      }
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
    const scale = Math.min(1, maxW / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const dark = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const blueWall = b > 110 && b > r * 1.15 && b > g * 1.05;
      const ink = r + g + b < 260;
      return blueWall || ink;
    };

    const candidates: Wall[] = [];
    const minRun = Math.max(45, Math.floor(w * 0.06));
    const rowStep = Math.max(4, Math.round(h / 160));
    const colStep = Math.max(4, Math.round(w / 160));

    for (let y = 0; y < h; y += rowStep) {
      let start = -1;
      for (let x = 0; x <= w; x++) {
        const on = x < w && dark(x, y);
        if (on && start < 0) start = x;
        if ((!on || x === w) && start >= 0) {
          if (x - start >= minRun) {
            const k = 1 / scale;
            candidates.push({ id: uid(), a: { x: start * k, y: y * k }, b: { x: (x - 1) * k, y: y * k }, thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12 });
          }
          start = -1;
        }
      }
    }

    for (let x = 0; x < w; x += colStep) {
      let start = -1;
      for (let y = 0; y <= h; y++) {
        const on = y < h && dark(x, y);
        if (on && start < 0) start = y;
        if ((!on || y === h) && start >= 0) {
          if (y - start >= minRun) {
            const k = 1 / scale;
            candidates.push({ id: uid(), a: { x: x * k, y: start * k }, b: { x: x * k, y: (y - 1) * k }, thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12 });
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
          return Math.abs(m.a.y - wall.a.y) < 18 &&
            Math.max(m.a.x, wall.a.x) <= Math.min(m.b.x, wall.b.x) + 35;
        }
        return Math.abs(m.a.x - wall.a.x) < 18 &&
          Math.max(m.a.y, wall.a.y) <= Math.min(m.b.y, wall.b.y) + 35;
      });
      if (!duplicate) merged.push(wall);
      if (merged.length >= 120) break;
    }

    setWalls(merged);
    setMessage(`تم اقتراح ${merged.length} جدارًا. راجعها قبل اعتماد النموذج ثلاثي الأبعاد.`);
  };

  const exportJson = () => {
    const payload = {
      version: 1,
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
        <button className={tool === "wall" ? "active" : ""} onClick={() => setTool("wall")}>رسم جدار</button>
        <button onClick={autoTrace} disabled={!imageUrl}>اقتراح الجدران</button>
        <button onClick={() => setWalls([])} disabled={!walls.length}>مسح الجدران</button>
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
                <p>أفضل نتيجة تبدأ بمعايرة بُعد واحد معروف، ثم مراجعة الجدران المقترحة.</p>
              </div>
            ) : (
              <svg
                ref={svgRef}
                className="plan"
                viewBox={`0 0 ${imageSize.w} ${imageSize.h}`}
                onClick={onCanvasClick}
              >
                <image href={imageUrl} x="0" y="0" width={imageSize.w} height={imageSize.h} opacity="0.55" />
                {walls.map((w) => (
                  <line
                    key={w.id}
                    x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y}
                    stroke="currentColor"
                    strokeWidth={Math.max(4, w.thickness)}
                    strokeLinecap="square"
                    className="wall-line"
                    onDoubleClick={(e) => { e.stopPropagation(); setWalls((all) => all.filter((x) => x.id !== w.id)); }}
                  />
                ))}
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
          <span><b>{scaleReady ? `${(metersPerPixel! * 1000).toFixed(2)} مم/px` : "غير معاير"}</b> مقياس</span>
          <span><b>{floorAreaEstimate ? `${floorAreaEstimate.toFixed(0)} م²` : "—"}</b> مساحة إطار الصورة</span>
        </div>
      </aside>
    </div>
  );
}

function ThreePreview(props: {
  walls: Wall[];
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
    camera.position.set(14, 16, 18);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    el.replaceChildren(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8d7c66, 2.2);
    scene.add(hemi);
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

    for (const wall of props.walls) {
      const ax = wall.a.x * scale - cx;
      const az = wall.a.y * scale - cy;
      const bx = wall.b.x * scale - cx;
      const bz = wall.b.y * scale - cy;
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.05) continue;
      const thickness = props.metersPerPixel ? Math.max(0.08, wall.thickness * scale) : props.wallThicknessM;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, props.wallHeight, thickness), wallMat);
      mesh.position.set((ax + bx) / 2, props.wallHeight / 2, (az + bz) / 2);
      mesh.rotation.y = -Math.atan2(bz - az, bx - ax);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
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
  }, [props.walls, props.imageSize, props.metersPerPixel, props.wallHeight, props.wallThicknessM, props.style]);

  return (
    <div className="three-wrap" ref={mount}>
      {!props.walls.length && <div className="three-hint">ارسم أو اكتشف الجدران لتظهر هنا مباشرة</div>}
      <div className="three-badge">اسحب للدوران • عجلة للتقريب</div>
    </div>
  );
}

export default App;
