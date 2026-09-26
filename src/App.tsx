import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeWithRemote } from "./analyzer";
import { createEvidence, robustScale } from "./calibration";
import { downloadTextFile, exportPlanDxf, exportQuantityCsv } from "./exporters";
import { canonicalizeAndInferOpenings, detectRooms, dist, pointOnWall, projectToSegment, snapOrthogonalIntersections, snapPoint } from "./geometry";
import { rasterizePlanFile } from "./importers";
import { analyzePlanLocally } from "./planAnalysis";
import ThreeScene from "./ThreeScene";
import type { CalibrationEvidence, Column, Opening, Point, ProjectSnapshot, Room, Stair, Wall } from "./types";
import { validateReconstruction } from "./validation";

type Screen = "home" | "plan" | "three" | "settings";
type Tool = "select" | "calibrate" | "wall" | "door" | "window" | "column" | "stair";

const uid = () => Math.random().toString(36).slice(2, 10);

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [imageUrl, setImageUrl] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [imageSize, setImageSize] = useState({ w: 1200, h: 800 });
  const [walls, setWalls] = useState<Wall[]>([]);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [stairs, setStairs] = useState<Stair[]>([]);
  const [exteriorWallIds, setExteriorWallIds] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [draftStart, setDraftStart] = useState<Point | null>(null);
  const [calibration, setCalibration] = useState<Point[]>([]);
  const [calibrationEvidence, setCalibrationEvidence] = useState<CalibrationEvidence[]>([]);
  const [knownMeters, setKnownMeters] = useState(4);
  const [metersPerPixel, setMetersPerPixel] = useState<number | null>(null);
  const [wallHeight, setWallHeight] = useState(3.2);
  const [wallThicknessM, setWallThicknessM] = useState(0.2);
  const [style, setStyle] = useState("سعودي حديث");
  const [roofVisible, setRoofVisible] = useState(true);
  const [furnitureVisible, setFurnitureVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const planRef = useRef<SVGSVGElement | null>(null);
  const planInputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);

  const scaleReady = !!metersPerPixel && metersPerPixel > 0;
  const areaM2 = useMemo(() => rooms.reduce((sum, room) => sum + room.areaM2, 0), [rooms]);
  const issues = useMemo(
    () => validateReconstruction(walls, openings, rooms, metersPerPixel),
    [walls, openings, rooms, metersPerPixel]
  );
  const criticalCount = issues.filter((issue) => issue.severity === "error").length;

  useEffect(() => {
    if (!scaleReady || walls.length < 4) {
      setRooms([]);
      setExteriorWallIds([]);
      return;
    }
    const result = detectRooms(walls, metersPerPixel);
    setRooms(result.rooms);
    setExteriorWallIds(result.exteriorWallIds);
  }, [walls, metersPerPixel, scaleReady]);

  useEffect(() => {
    if (!imageUrl) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem("manzel-h-autosave", JSON.stringify(createSnapshot(false)));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [imageUrl, walls, openings, columns, stairs, metersPerPixel, wallHeight, wallThicknessM, style, roofVisible, furnitureVisible]);

  const flash = (text: string) => {
    setStatus(text);
    window.setTimeout(() => setStatus(""), 2200);
  };

  const createSnapshot = (includeImage = true): ProjectSnapshot => ({
    version: 6,
    units: scaleReady ? "meter" : "pixel",
    image: {
      width: imageSize.w,
      height: imageSize.h,
      ...(includeImage && imageDataUrl ? { dataUrl: imageDataUrl } : {}),
    },
    calibration: {
      knownMeters,
      metersPerPixel,
      evidence: calibrationEvidence,
    },
    building: {
      wallHeight,
      wallThicknessM,
      style,
      ceilingVisible: false,
      roofVisible,
      siteWallVisible: false,
      furnitureVisible,
    },
    walls,
    openings,
    rooms,
    columns,
    stairs,
  });

  const loadSnapshot = (snapshot: ProjectSnapshot) => {
    const image = snapshot.image?.dataUrl || "";
    setImageSize({ w: snapshot.image.width, h: snapshot.image.height });
    setImageDataUrl(image);
    setImageUrl(image);
    setKnownMeters(snapshot.calibration.knownMeters || 4);
    setMetersPerPixel(snapshot.calibration.metersPerPixel || null);
    setCalibrationEvidence(snapshot.calibration.evidence || []);
    setWallHeight(snapshot.building.wallHeight || 3.2);
    setWallThicknessM(snapshot.building.wallThicknessM || 0.2);
    setStyle(snapshot.building.style || "سعودي حديث");
    setRoofVisible(snapshot.building.roofVisible ?? true);
    setFurnitureVisible(snapshot.building.furnitureVisible ?? true);
    setWalls(snapshot.walls || []);
    setOpenings(snapshot.openings || []);
    setColumns(snapshot.columns || []);
    setStairs(snapshot.stairs || []);
    setScreen("plan");
    flash("تم فتح المشروع");
  };

  const importPlan = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const raster = await rasterizePlanFile(file);
      setImageUrl(raster.dataUrl);
      setImageDataUrl(raster.dataUrl);
      setImageSize({ w: raster.width, h: raster.height });
      setWalls([]);
      setOpenings([]);
      setRooms([]);
      setColumns([]);
      setStairs([]);
      setMetersPerPixel(null);
      setCalibration([]);
      setCalibrationEvidence([]);
      setTool("select");
      setScreen("plan");
    } catch {
      flash("تعذر فتح الملف");
    } finally {
      setBusy(false);
    }
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as ProjectSnapshot;
      if (!parsed || !Array.isArray(parsed.walls)) throw new Error("invalid");
      loadSnapshot(parsed);
    } catch {
      flash("ملف المشروع غير صالح");
    }
  };

  const restoreAutosave = () => {
    const raw = localStorage.getItem("manzel-h-autosave");
    if (!raw) return flash("لا توجد مسودة");
    try {
      loadSnapshot(JSON.parse(raw) as ProjectSnapshot);
    } catch {
      flash("تعذر استعادة المسودة");
    }
  };

  const eventPoint = (event: React.MouseEvent<SVGSVGElement>): Point => {
    const svg = planRef.current!;
    const box = svg.getBoundingClientRect();
    return snapPoint({
      x: ((event.clientX - box.left) / box.width) * imageSize.w,
      y: ((event.clientY - box.top) / box.height) * imageSize.h,
    });
  };

  const addOpening = (p: Point, kind: "door" | "window") => {
    if (!scaleReady || !walls.length) return flash("عاير المخطط أولاً");
    const best = walls
      .map((wall) => ({ wall, ...projectToSegment(p, wall.a, wall.b) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!best || best.distance > Math.max(20, 0.4 / metersPerPixel!)) return;

    setOpenings((items) => [
      ...items,
      {
        id: uid(),
        wallId: best.wall.id,
        kind,
        centerT: best.t,
        widthM: kind === "door" ? 0.95 : 1.4,
        heightM: kind === "door" ? 2.2 : 1.35,
        sillM: kind === "door" ? 0 : 0.9,
      },
    ]);
  };

  const onPlanTap = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!imageUrl) return;
    const p = eventPoint(event);

    if (tool === "calibrate") {
      const next = calibration.length >= 2 ? [p] : [...calibration, p];
      setCalibration(next);
      if (next.length === 2 && knownMeters > 0) {
        const evidence = createEvidence(next[0], next[1], knownMeters);
        const all = [...calibrationEvidence, evidence].slice(-5);
        const scale = robustScale(all);
        setCalibrationEvidence(all);
        setMetersPerPixel(scale.metersPerPixel);
        setTool("select");
        flash("تمت المعايرة");
      }
      return;
    }

    if (tool === "door" || tool === "window") {
      addOpening(p, tool);
      return;
    }

    if (tool === "column") {
      if (!scaleReady) return flash("عاير المخطط أولاً");
      setColumns((items) => [...items, { id: uid(), point: p, widthM: 0.3, depthM: 0.3, heightM: wallHeight }]);
      return;
    }

    if (tool === "stair") {
      if (!scaleReady) return flash("عاير المخطط أولاً");
      setStairs((items) => [...items, { id: uid(), origin: p, widthM: 1.2, runM: 3.6, riseM: wallHeight, steps: 18, rotationDeg: 0 }]);
      return;
    }

    if (tool === "wall") {
      if (!draftStart) {
        setDraftStart(p);
        return;
      }
      const dx = Math.abs(p.x - draftStart.x);
      const dy = Math.abs(p.y - draftStart.y);
      const end = dx >= dy ? { x: p.x, y: draftStart.y } : { x: draftStart.x, y: p.y };
      if (dist(draftStart, end) > 6) {
        setWalls((items) => [
          ...items,
          {
            id: uid(),
            a: draftStart,
            b: end,
            thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12,
          },
        ]);
      }
      setDraftStart(null);
    }
  };

  const analyzePlan = async () => {
    if (!imageUrl) return;
    setBusy(true);
    try {
      let result: { walls: Wall[]; openings: Opening[] } | null = null;
      try {
        const remote = await analyzeWithRemote(imageUrl);
        if (remote?.walls?.length) {
          const canonical = canonicalizeAndInferOpenings(remote.walls, metersPerPixel);
          result = {
            walls: snapOrthogonalIntersections(canonical.walls, metersPerPixel),
            openings: canonical.openings,
          };
        }
      } catch {
        // local fallback below
      }
      if (!result) result = await analyzePlanLocally(imageUrl, metersPerPixel, wallThicknessM);
      setWalls(result.walls);
      setOpenings(result.openings);
      flash("تم التحليل");
    } catch {
      flash("تعذر التحليل");
    } finally {
      setBusy(false);
    }
  };

  const exportProject = () => {
    downloadTextFile(JSON.stringify(createSnapshot(true), null, 2), "manzel-h-project.json", "application/json");
  };

  const exportDxf = () => {
    if (!metersPerPixel) return flash("عاير المخطط أولاً");
    downloadTextFile(
      exportPlanDxf({ walls, openings, columns, stairs, metersPerPixel }),
      "manzel-h-plan.dxf",
      "application/dxf"
    );
  };

  const exportCsv = () => {
    if (!metersPerPixel) return flash("عاير المخطط أولاً");
    downloadTextFile(
      exportQuantityCsv({
        walls,
        openings,
        columns,
        stairs,
        metersPerPixel,
        wallHeightM: wallHeight,
        roomAreaM2: areaM2,
      }),
      "manzel-h-quantities.csv",
      "text/csv;charset=utf-8"
    );
  };

  const newProject = () => {
    setImageUrl("");
    setImageDataUrl("");
    setWalls([]);
    setOpenings([]);
    setRooms([]);
    setColumns([]);
    setStairs([]);
    setMetersPerPixel(null);
    setCalibration([]);
    setCalibrationEvidence([]);
    setScreen("home");
  };

  return (
    <div className="mobile-app">
      <input ref={planInputRef} className="hidden-input" type="file" accept="image/*,application/pdf,.pdf" onChange={(e) => importPlan(e.target.files?.[0])} />
      <input ref={projectInputRef} className="hidden-input" type="file" accept=".json,application/json" onChange={(e) => importProject(e.target.files?.[0])} />

      {screen === "home" && (
        <main className="home-screen">
          <div className="home-brand">منزل H</div>
          <div className="home-card" onClick={() => planInputRef.current?.click()}>
            <div className="home-plus">＋</div>
            <strong>مخطط جديد</strong>
            <span>صورة أو PDF</span>
          </div>
          <div className="home-actions">
            <button onClick={() => projectInputRef.current?.click()}>فتح مشروع</button>
            <button onClick={restoreAutosave}>آخر مشروع</button>
          </div>
        </main>
      )}

      {screen !== "home" && (
        <>
          <header className="app-header">
            <button className="icon-button" onClick={() => setScreen("home")}>‹</button>
            <strong>{screen === "plan" ? "المخطط" : screen === "three" ? "3D" : "الإعدادات"}</strong>
            <div className="header-state">
              {criticalCount ? <span className="bad-dot" /> : walls.length ? <span className="good-dot" /> : null}
            </div>
          </header>

          {screen === "plan" && (
            <main className="plan-screen">
              <div className="plan-top-actions">
                <button className="primary-mini" onClick={analyzePlan} disabled={busy}>{busy ? "..." : "تحليل"}</button>
                <button onClick={() => setTool("calibrate")} className={tool === "calibrate" ? "active" : ""}>معايرة</button>
              </div>

              <div className="plan-stage">
                <svg ref={planRef} viewBox={`0 0 ${imageSize.w} ${imageSize.h}`} onClick={onPlanTap}>
                  <image href={imageUrl} width={imageSize.w} height={imageSize.h} opacity="0.5" />
                  {rooms.flatMap((room) => room.cells.map((cell, i) => (
                    <rect key={`${room.id}-${i}`} x={cell.x1} y={cell.y1} width={cell.x2 - cell.x1} height={cell.y2 - cell.y1} className="room-shape" />
                  )))}
                  {walls.map((wall) => (
                    <line
                      key={wall.id}
                      x1={wall.a.x}
                      y1={wall.a.y}
                      x2={wall.b.x}
                      y2={wall.b.y}
                      strokeWidth={Math.max(4, wall.thickness)}
                      className={exteriorWallIds.includes(wall.id) ? "plan-wall exterior" : "plan-wall"}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setWalls((items) => items.filter((w) => w.id !== wall.id));
                        setOpenings((items) => items.filter((o) => o.wallId !== wall.id));
                      }}
                    />
                  ))}
                  {openings.map((opening) => {
                    const wall = walls.find((w) => w.id === opening.wallId);
                    if (!wall || !metersPerPixel) return null;
                    const wallPx = dist(wall.a, wall.b);
                    const delta = (opening.widthM / metersPerPixel) / Math.max(wallPx, 1);
                    const a = pointOnWall(wall, Math.max(0, opening.centerT - delta / 2));
                    const b = pointOnWall(wall, Math.min(1, opening.centerT + delta / 2));
                    return (
                      <line
                        key={opening.id}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        className={opening.kind === "door" ? "plan-door" : "plan-window"}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setOpenings((items) => items.filter((o) => o.id !== opening.id));
                        }}
                      />
                    );
                  })}
                  {columns.map((column) => {
                    const size = metersPerPixel ? column.widthM / metersPerPixel : 14;
                    return <rect key={column.id} x={column.point.x - size / 2} y={column.point.y - size / 2} width={size} height={size} className="plan-column" />;
                  })}
                  {stairs.map((stair) => {
                    const w = metersPerPixel ? stair.widthM / metersPerPixel : 50;
                    const h = metersPerPixel ? stair.runM / metersPerPixel : 120;
                    return <rect key={stair.id} x={stair.origin.x - w / 2} y={stair.origin.y - h / 2} width={w} height={h} className="plan-stair" />;
                  })}
                  {calibration.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="10" className="calibration-dot" />)}
                  {calibration.length === 2 && <line x1={calibration[0].x} y1={calibration[0].y} x2={calibration[1].x} y2={calibration[1].y} className="calibration-line" />}
                  {draftStart && <circle cx={draftStart.x} cy={draftStart.y} r="9" className="draft-dot" />}
                </svg>
              </div>

              <div className="tool-dock">
                {[
                  ["select", "تحديد"],
                  ["wall", "جدار"],
                  ["door", "باب"],
                  ["window", "نافذة"],
                  ["column", "عمود"],
                  ["stair", "درج"],
                ].map(([id, label]) => (
                  <button key={id} onClick={() => setTool(id as Tool)} className={tool === id ? "active" : ""}>{label}</button>
                ))}
              </div>

              {tool === "calibrate" && (
                <div className="calibrate-bar">
                  <input type="number" step="0.01" value={knownMeters} onChange={(e) => setKnownMeters(Number(e.target.value))} />
                  <span>متر</span>
                </div>
              )}
            </main>
          )}

          {screen === "three" && (
            <main className="three-screen">
              <ThreeScene
                walls={walls}
                openings={openings}
                rooms={rooms}
                columns={columns}
                stairs={stairs}
                imageSize={imageSize}
                metersPerPixel={metersPerPixel}
                wallHeight={wallHeight}
                wallThicknessM={wallThicknessM}
                style={style}
                roofVisible={roofVisible}
                furnitureVisible={furnitureVisible}
              />
            </main>
          )}

          {screen === "settings" && (
            <main className="settings-screen">
              <section className="settings-card">
                <div className="setting-row">
                  <span>الطراز</span>
                  <select value={style} onChange={(e) => setStyle(e.target.value)}>
                    <option>سعودي حديث</option>
                    <option>نجدي حديث</option>
                    <option>حجازي حديث</option>
                    <option>Minimal</option>
                  </select>
                </div>
                <div className="setting-row">
                  <span>ارتفاع الجدار</span>
                  <input type="number" step="0.1" value={wallHeight} onChange={(e) => setWallHeight(Number(e.target.value))} />
                </div>
                <div className="setting-row">
                  <span>سماكة الجدار</span>
                  <input type="number" step="0.01" value={wallThicknessM} onChange={(e) => setWallThicknessM(Number(e.target.value))} />
                </div>
                <label className="switch-row"><span>السقف</span><input type="checkbox" checked={roofVisible} onChange={(e) => setRoofVisible(e.target.checked)} /></label>
                <label className="switch-row"><span>الأثاث</span><input type="checkbox" checked={furnitureVisible} onChange={(e) => setFurnitureVisible(e.target.checked)} /></label>
              </section>

              <section className="stats-strip">
                <span><b>{walls.length}</b> جدار</span>
                <span><b>{rooms.length}</b> غرفة</span>
                <span><b>{areaM2.toFixed(0)}</b> م²</span>
              </section>

              <section className="settings-card action-list">
                <button onClick={exportProject}>حفظ المشروع</button>
                <button onClick={exportDxf}>DXF</button>
                <button onClick={exportCsv}>CSV</button>
                <button onClick={() => planInputRef.current?.click()}>استبدال المخطط</button>
                <button className="danger" onClick={newProject}>مشروع جديد</button>
              </section>
            </main>
          )}

          <nav className="bottom-nav">
            <button onClick={() => setScreen("plan")} className={screen === "plan" ? "active" : ""}><span>⌁</span>مخطط</button>
            <button onClick={() => setScreen("three")} className={screen === "three" ? "active" : ""}><span>◇</span>3D</button>
            <button onClick={() => setScreen("settings")} className={screen === "settings" ? "active" : ""}><span>⚙</span>إعدادات</button>
          </nav>
        </>
      )}

      {busy && <div className="busy-overlay"><div className="spinner" /></div>}
      {status && <div className="toast">{status}</div>}
    </div>
  );
}
