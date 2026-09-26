import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { canonicalizeAndInferOpenings, detectRooms, dist, pointOnWall, projectToSegment, snapOrthogonalIntersections, snapPoint } from "./geometry";
import type { CalibrationEvidence, Opening, Point, ProjectSnapshot, Room, Wall } from "./types";
import { validateReconstruction } from "./validation";
import { analyzeWithRemote } from "./analyzer";
import { createEvidence, robustScale } from "./calibration";
import { rasterizePlanFile } from "./importers";

type Tool = "select" | "calibrate" | "wall" | "door" | "window";

const uid = () => Math.random().toString(36).slice(2, 10);

function App() {
  const [imageUrl, setImageUrl] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [imageSize, setImageSize] = useState({ w: 1200, h: 800 });
  const [walls, setWalls] = useState<Wall[]>([]);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [exteriorWallIds, setExteriorWallIds] = useState<string[]>([]);
  const [roomNames, setRoomNames] = useState<Record<string, string>>({});
  const [tool, setTool] = useState<Tool>("select");
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [draftStart, setDraftStart] = useState<Point | null>(null);
  const [calibration, setCalibration] = useState<Point[]>([]);
  const [calibrationEvidence, setCalibrationEvidence] = useState<CalibrationEvidence[]>([]);
  const [calibrationSpreadPct, setCalibrationSpreadPct] = useState<number | null>(null);
  const [knownMeters, setKnownMeters] = useState(4);
  const [metersPerPixel, setMetersPerPixel] = useState<number | null>(null);
  const [wallHeight, setWallHeight] = useState(3.2);
  const [wallThicknessM, setWallThicknessM] = useState(0.2);
  const [style, setStyle] = useState("سعودي حديث");
  const [view, setView] = useState<"2d" | "3d" | "split">("split");
  const [ceilingVisible, setCeilingVisible] = useState(false);
  const [roofVisible, setRoofVisible] = useState(true);
  const [siteWallVisible, setSiteWallVisible] = useState(true);
  const [message, setMessage] = useState("ارفع المخطط، ثم عاير القياس من بُعد معروف.");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  const scaleReady = !!metersPerPixel && metersPerPixel > 0;
  const totalWallLength = useMemo(
    () => scaleReady ? walls.reduce((sum, w) => sum + dist(w.a, w.b) * metersPerPixel!, 0) : null,
    [walls, metersPerPixel, scaleReady]
  );
  const totalRoomArea = useMemo(() => rooms.reduce((s, r) => s + r.areaM2, 0), [rooms]);
  const validationIssues = useMemo(() => validateReconstruction(walls, openings, rooms, metersPerPixel), [walls, openings, rooms, metersPerPixel]);
  const errorCount = validationIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = validationIssues.filter((issue) => issue.severity === "warning").length;

  useEffect(() => {
    if (!scaleReady || walls.length < 4) {
      setRooms([]);
      setExteriorWallIds([]);
      return;
    }
    const reconstruction = detectRooms(walls, metersPerPixel, roomNames);
    setRooms(reconstruction.rooms);
    setExteriorWallIds(reconstruction.exteriorWallIds);
  }, [walls, metersPerPixel, roomNames, scaleReady]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      const snapshot = createSnapshot(false);
      localStorage.setItem("manzel-h-autosave", JSON.stringify(snapshot));
    }, 500);
    return () => clearTimeout(id);
  }, [walls, openings, rooms, metersPerPixel, wallHeight, wallThicknessM, style, ceilingVisible, roofVisible, siteWallVisible]);

  const onUpload = async (file?: File) => {
    if (!file) return;
    try {
      setMessage("جاري تجهيز المخطط...");
      const raster = await rasterizePlanFile(file);
      setImageSize({ w: raster.width, h: raster.height });
      setImageUrl(raster.dataUrl);
      setImageDataUrl(raster.dataUrl);
      setWalls([]);
      setOpenings([]);
      setRooms([]);
      setRoomNames({});
      setCalibration([]);
      setCalibrationEvidence([]);
      setCalibrationSpreadPct(null);
      setMetersPerPixel(null);
      setMessage(raster.sourceType === "pdf"
        ? "تم تحميل الصفحة الأولى من PDF. عاير بعدًا معروفًا ثم شغّل التحليل."
        : "تم رفع المخطط. عاير القياس أولاً للحصول على أبعاد حقيقية.");
    } catch {
      setMessage("تعذر قراءة الملف. استخدم صورة واضحة أو PDF صالح.");
    }
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
          const evidence = createEvidence(next[0], next[1], knownMeters);
          const nextEvidence = [...calibrationEvidence, evidence].slice(-6);
          const robust = robustScale(nextEvidence);
          setCalibrationEvidence(nextEvidence);
          setMetersPerPixel(robust.metersPerPixel);
          setCalibrationSpreadPct(robust.spreadPct);
          setMessage(
            robust.count > 1
              ? `تمت المعايرة من ${robust.count} قياسات: ${((robust.metersPerPixel || 0) * 1000).toFixed(2)} مم/بكسل، اختلاف ${(robust.spreadPct || 0).toFixed(1)}٪.`
              : `تمت المعايرة: ${((robust.metersPerPixel || 0) * 1000).toFixed(2)} مم لكل بكسل. أضف قياسًا ثانيًا لزيادة الثقة.`
          );
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
    setMessage("جاري تحليل الجدران...");

    try {
      const remote = await analyzeWithRemote(imageUrl);
      if (remote && remote.walls.length) {
        const canonical = canonicalizeAndInferOpenings(remote.walls, metersPerPixel);
        const snappedWalls = snapOrthogonalIntersections(canonical.walls, metersPerPixel);
        setWalls(snappedWalls);
        setOpenings(canonical.openings);
        setMessage(`المحلل السحابي اقترح ${canonical.walls.length} جدارًا و${canonical.openings.length} فتحة محتملة. راجع الهندسة قبل الاعتماد.`);
        return;
      }
    } catch {
      setMessage("تعذر المحلل السحابي؛ تم التحويل تلقائيًا إلى التحليل المحلي.");
    }
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

    const collectRuns = (horizontal: boolean, coords: number[]) => {
      for (const fixed of coords) {
        let start = -1, misses = 0;
        const limit = horizontal ? w : h;
        for (let variable = 0; variable <= limit; variable++) {
          const x = horizontal ? variable : fixed;
          const y = horizontal ? fixed : variable;
          const on = variable < limit && isWallPixel(x, y);
          if (on) {
            if (start < 0) start = variable;
            misses = 0;
          } else if (start >= 0) {
            misses++;
            if (misses > 5 || variable === limit) {
              const end = variable - misses;
              if (end - start >= minRun) {
                candidates.push({
                  id: uid(),
                  a: horizontal ? { x: start * k, y: fixed * k } : { x: fixed * k, y: start * k },
                  b: horizontal ? { x: end * k, y: fixed * k } : { x: fixed * k, y: end * k },
                  thickness: scaleReady ? wallThicknessM / metersPerPixel! : 12,
                });
              }
              start = -1;
              misses = 0;
            }
          }
        }
      }
    };

    collectRuns(true, rows);
    collectRuns(false, cols);

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

    const canonical = canonicalizeAndInferOpenings(merged, metersPerPixel);
    const snappedWalls = snapOrthogonalIntersections(canonical.walls, metersPerPixel);
    setWalls(snappedWalls);
    setOpenings(canonical.openings);
    setMessage(`تم توحيد ${canonical.walls.length} جدارًا واكتشاف ${canonical.openings.length} فتحة محتملة. راجع النتيجة قبل اعتماد 3D.`);
  };

  const removeWall = (id: string) => {
    setWalls((v) => v.filter((w) => w.id !== id));
    setOpenings((v) => v.filter((o) => o.wallId !== id));
  };

  const removeOpening = (id: string) => setOpenings((v) => v.filter((o) => o.id !== id));

  const selectedWall = walls.find((wall) => wall.id === selectedWallId) || null;

  const setSelectedWallLengthM = (lengthM: number) => {
    if (!selectedWall || !metersPerPixel || lengthM <= 0) return;
    const currentPx = dist(selectedWall.a, selectedWall.b);
    if (currentPx <= 0) return;
    const targetPx = lengthM / metersPerPixel;
    const ux = (selectedWall.b.x - selectedWall.a.x) / currentPx;
    const uy = (selectedWall.b.y - selectedWall.a.y) / currentPx;
    setWalls((items) => items.map((wall) =>
      wall.id === selectedWall.id
        ? { ...wall, b: { x: wall.a.x + ux * targetPx, y: wall.a.y + uy * targetPx } }
        : wall
    ));
  };

  const setSelectedWallThicknessM = (thicknessM: number) => {
    if (!selectedWall || !metersPerPixel || thicknessM <= 0) return;
    setWalls((items) => items.map((wall) =>
      wall.id === selectedWall.id
        ? { ...wall, thickness: thicknessM / metersPerPixel }
        : wall
    ));
  };

  const roomKey = (room: Room) => `${Math.round(room.centroid.x / 10)}:${Math.round(room.centroid.y / 10)}`;
  const renameRoom = (room: Room, name: string) => {
    const key = roomKey(room);
    setRoomNames((prev) => ({ ...prev, [key]: name }));
  };

  function createSnapshot(includeImage = true): ProjectSnapshot {
    return {
      version: 4,
      units: scaleReady ? "meter" : "pixel",
      image: {
        width: imageSize.w,
        height: imageSize.h,
        ...(includeImage && imageDataUrl ? { dataUrl: imageDataUrl } : {}),
      },
      calibration: { knownMeters, metersPerPixel, evidence: calibrationEvidence, spreadPct: calibrationSpreadPct },
      building: { wallHeight, wallThicknessM, style, ceilingVisible, roofVisible, siteWallVisible },
      walls,
      openings,
      rooms,
    };
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(createSnapshot(true), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "manzel-h-project.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const loadSnapshot = (snapshot: ProjectSnapshot) => {
    setImageSize({ w: snapshot.image.width, h: snapshot.image.height });
    if (snapshot.image.dataUrl) {
      setImageDataUrl(snapshot.image.dataUrl);
      setImageUrl(snapshot.image.dataUrl);
    }
    setKnownMeters(snapshot.calibration.knownMeters);
    setMetersPerPixel(snapshot.calibration.metersPerPixel);
    setCalibrationEvidence(snapshot.calibration.evidence || []);
    setCalibrationSpreadPct(snapshot.calibration.spreadPct ?? null);
    setWallHeight(snapshot.building.wallHeight);
    setWallThicknessM(snapshot.building.wallThicknessM);
    setStyle(snapshot.building.style);
    setCeilingVisible(snapshot.building.ceilingVisible ?? false);
    setRoofVisible(snapshot.building.roofVisible ?? true);
    setSiteWallVisible(snapshot.building.siteWallVisible ?? true);
    setWalls(snapshot.walls || []);
    setOpenings(snapshot.openings || []);
    const names: Record<string, string> = {};
    for (const room of snapshot.rooms || []) names[roomKey(room)] = room.name;
    setRoomNames(names);
    setMessage("تم استيراد المشروع بنجاح.");
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const snapshot = JSON.parse(await file.text()) as ProjectSnapshot;
      if (!snapshot || ![3,4].includes(Number(snapshot.version)) || !Array.isArray(snapshot.walls)) throw new Error("invalid");
      loadSnapshot(snapshot);
    } catch {
      setMessage("ملف المشروع غير صالح أو من إصدار غير مدعوم.");
    }
  };

  const restoreAutosave = () => {
    const raw = localStorage.getItem("manzel-h-autosave");
    if (!raw) {
      setMessage("لا توجد مسودة محفوظة على هذا الجهاز.");
      return;
    }
    try {
      loadSnapshot(JSON.parse(raw) as ProjectSnapshot);
      setMessage("تمت استعادة آخر مسودة محلية.");
    } catch {
      setMessage("تعذر استعادة المسودة.");
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">منزل H <span>ENGINE V3</span></div>
          <div className="subtitle">هندسة قابلة للمراجعة • غرف تلقائية • فتحات حقيقية • هوية سعودية</div>
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
        <label className="upload">رفع المخطط<input type="file" accept="image/*,application/pdf,.pdf" onChange={(e) => onUpload(e.target.files?.[0])} /></label>
        <button className={tool === "calibrate" ? "active" : ""} onClick={() => { setTool("calibrate"); setCalibration([]); }}>معايرة</button>
        <button onClick={() => { setCalibration([]); setCalibrationEvidence([]); setCalibrationSpreadPct(null); setMetersPerPixel(null); }}>إعادة المعايرة</button>
        <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>تحديد</button>
        <button className={tool === "wall" ? "active" : ""} onClick={() => setTool("wall")}>جدار</button>
        <button className={tool === "door" ? "active" : ""} onClick={() => setTool("door")}>باب</button>
        <button className={tool === "window" ? "active" : ""} onClick={() => setTool("window")}>نافذة</button>
        <button onClick={autoTrace} disabled={!imageUrl}>تحليل الجدران</button>
        <button onClick={() => { setWalls([]); setOpenings([]); setRooms([]); }} disabled={!walls.length}>مسح</button>
        <button onClick={exportJson} disabled={!walls.length}>تصدير مشروع</button>
        <button onClick={() => importRef.current?.click()}>استيراد مشروع</button>
        <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={(e) => importProject(e.target.files?.[0])} />
        <button onClick={restoreAutosave}>استعادة المسودة</button>
      </section>

      <section className="status">{message}</section>

      <main className={`workspace ${view}`}>
        {view !== "3d" && (
          <section className="panel plan-panel">
            {!imageUrl ? (
              <div className="empty">
                <div className="upload-mark">＋</div>
                <h2>ارفع صورة المخطط</h2>
                <p>المعايرة بنقطتين تجعل كل جدار وفتحة وغرفة تُحفظ بوحدة حقيقية.</p>
              </div>
            ) : (
              <svg ref={svgRef} className="plan" viewBox={`0 0 ${imageSize.w} ${imageSize.h}`} onClick={onCanvasClick}>
                <image href={imageUrl} x="0" y="0" width={imageSize.w} height={imageSize.h} opacity="0.42" />
                {rooms.flatMap((room) =>
                  room.cells.map((cell, i) => (
                    <rect key={`${room.id}-${i}`} x={cell.x1} y={cell.y1} width={cell.x2 - cell.x1} height={cell.y2 - cell.y1} className="room-fill" />
                  ))
                )}
                {rooms.map((room) => (
                  <g key={room.id} className="room-label">
                    <rect x={room.centroid.x - 52} y={room.centroid.y - 22} width="104" height="44" rx="8" />
                    <text x={room.centroid.x} y={room.centroid.y - 3}>{room.name}</text>
                    <text x={room.centroid.x} y={room.centroid.y + 14}>{room.areaM2.toFixed(1)} م²</text>
                  </g>
                ))}
                {walls.map((w) => (
                  <g key={w.id}>
                    <line
                      x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y}
                      strokeWidth={Math.max(4, w.thickness)}
                      strokeLinecap="square"
                      className={`${exteriorWallIds.includes(w.id) ? "wall-line exterior-wall" : "wall-line"} ${selectedWallId === w.id ? "selected-wall" : ""}`}
                      onClick={(e) => { if (tool === "select") { e.stopPropagation(); setSelectedWallId(w.id); } }}
                      onDoubleClick={(e) => { e.stopPropagation(); removeWall(w.id); setSelectedWallId(null); }}
                    />
                    {scaleReady && dist(w.a, w.b) * metersPerPixel! >= 1 && (
                      <text
                        className="wall-dimension"
                        x={(w.a.x + w.b.x) / 2}
                        y={(w.a.y + w.b.y) / 2 - 10}
                      >
                        {(dist(w.a, w.b) * metersPerPixel!).toFixed(2)} م
                      </text>
                    )}
                  </g>
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
              rooms={rooms}
              exteriorWallIds={exteriorWallIds}
              imageSize={imageSize}
              metersPerPixel={metersPerPixel}
              wallHeight={wallHeight}
              wallThicknessM={wallThicknessM}
              style={style}
              ceilingVisible={ceilingVisible}
              roofVisible={roofVisible}
              siteWallVisible={siteWallVisible}
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

        {selectedWall && scaleReady && (
          <div className="precision-editor">
            <strong>تحرير الجدار بدقة</strong>
            <label>الطول الحقيقي (م)
              <input
                type="number"
                step="0.001"
                min="0.05"
                value={(dist(selectedWall.a, selectedWall.b) * metersPerPixel!).toFixed(3)}
                onChange={(e) => setSelectedWallLengthM(Number(e.target.value))}
              />
            </label>
            <label>السماكة (م)
              <input
                type="number"
                step="0.001"
                min="0.05"
                value={(selectedWall.thickness * metersPerPixel!).toFixed(3)}
                onChange={(e) => setSelectedWallThicknessM(Number(e.target.value))}
              />
            </label>
            <button onClick={() => setSelectedWallId(null)}>إنهاء التحديد</button>
          </div>
        )}

        <div className="toggle-row">
          <label><input type="checkbox" checked={roofVisible} onChange={(e) => setRoofVisible(e.target.checked)} /> سقف</label>
          <label><input type="checkbox" checked={ceilingVisible} onChange={(e) => setCeilingVisible(e.target.checked)} /> سقف داخلي</label>
          <label><input type="checkbox" checked={siteWallVisible} onChange={(e) => setSiteWallVisible(e.target.checked)} /> سور خارجي</label>
        </div>

        <div className="metrics">
          <span><b>{walls.length}</b> جدار</span>
          <span><b>{exteriorWallIds.length}</b> خارجي</span>
          <span><b>{openings.filter((o) => o.kind === "door").length}</b> باب</span>
          <span><b>{openings.filter((o) => o.kind === "window").length}</b> نافذة</span>
          <span><b>{rooms.length}</b> مساحة مغلقة</span>
          <span><b>{totalRoomArea ? `${totalRoomArea.toFixed(1)} م²` : "—"}</b> مساحة داخلية</span>
          <span><b>{scaleReady ? `${(metersPerPixel! * 1000).toFixed(2)} مم/px` : "غير معاير"}</b> مقياس</span>
          <span><b>{calibrationEvidence.length}</b> قياسات معايرة</span>
          <span><b>{calibrationSpreadPct == null ? "—" : `${calibrationSpreadPct.toFixed(1)}٪`}</b> اختلاف المعايرة</span>
          <span><b>{totalWallLength ? `${totalWallLength.toFixed(1)} م` : "—"}</b> أطوال الجدران</span>
        </div>

        {!!rooms.length && (
          <div className="room-editor">
            <strong>أسماء الغرف</strong>
            <div className="room-editor-grid">
              {rooms.map((room) => (
                <label key={room.id}>
                  <input value={room.name} onChange={(e) => renameRoom(room, e.target.value)} />
                  <small>{room.areaM2.toFixed(1)} م²</small>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="quality-panel">
          <div className="quality-head">
            <strong>فحص الهندسة</strong>
            <span className={errorCount ? "quality-bad" : warningCount ? "quality-warn" : "quality-good"}>
              {errorCount ? `${errorCount} خطأ` : warningCount ? `${warningCount} تنبيه` : "جاهز للمراجعة"}
            </span>
          </div>
          {validationIssues.map((issue) => (
            <div key={issue.code + issue.message} className={`quality-item ${issue.severity}`}>{issue.message}</div>
          ))}
        </div>
        <div className="help">الجدران الخارجية تظهر بلون مختلف. كشف الغرف يعتمد على حلقات الجدران المغلقة. حذف جدار أو فتحة: نقرتان متتاليتان عليها.</div>
      </aside>
    </div>
  );
}

function ThreePreview(props: {
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  exteriorWallIds: string[];
  imageSize: { w: number; h: number };
  metersPerPixel: number | null;
  wallHeight: number;
  wallThicknessM: number;
  style: string;
  ceilingVisible: boolean;
  roofVisible: boolean;
  siteWallVisible: boolean;
}) {
  const mount = useRef<HTMLDivElement | null>(null);
  const exportRoot = useRef<THREE.Group | null>(null);

  const exportGlb = async () => {
    if (!exportRoot.current) return;
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const exporter = new GLTFExporter();
    exporter.parse(
      exportRoot.current,
      (result) => {
        if (!(result instanceof ArrayBuffer)) return;
        const blob = new Blob([result], { type: "model/gltf-binary" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "manzel-h-house.glb";
        a.click();
        URL.revokeObjectURL(a.href);
      },
      (error) => console.error(error),
      { binary: true, onlyVisible: true }
    );
  };

  useEffect(() => {
    if (!mount.current) return;
    const el = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe9e4da);
    scene.fog = new THREE.Fog(0xe9e4da, 45, 110);

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(el.clientHeight, 1), 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.replaceChildren(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7761, 2.0));
    const sun = new THREE.DirectionalLight(0xfff4df, 3.0);
    sun.position.set(18, 26, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);

    const scale = props.metersPerPixel ?? 0.02;
    const cx = props.imageSize.w * scale / 2;
    const cy = props.imageSize.h * scale / 2;
    const group = new THREE.Group();
    exportRoot.current = group;

    const palette: Record<string, { wall: number; accent: number; floor: number; roof: number }> = {
      "سعودي حديث": { wall: 0xe7dfd2, accent: 0x6d5841, floor: 0xd6c8b5, roof: 0xc8b89f },
      "نجدي حديث": { wall: 0xc7a477, accent: 0x704c2f, floor: 0xc6a47d, roof: 0xa47f58 },
      "حجازي حديث": { wall: 0xead6b8, accent: 0x365b6d, floor: 0xdcc5a5, roof: 0xbea17d },
      "Minimal دافئ": { wall: 0xf1ece4, accent: 0x75695b, floor: 0xd9d0c5, roof: 0xc8c0b6 },
    };
    const colors = palette[props.style] ?? palette["سعودي حديث"];
    const wallMat = new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.72 });
    const exteriorMat = new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.6 });
    const accentMat = new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.68 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9cc6d7, roughness: 0.1, metalness: 0.08, transparent: true, opacity: 0.48 });
    const floorMat = new THREE.MeshStandardMaterial({ color: colors.floor, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: colors.roof, roughness: 0.8 });

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
      const baseMat = props.exteriorWallIds.includes(wall.id) ? exteriorMat : wallMat;
      const wallOpenings = props.openings.filter((o) => o.wallId === wall.id).sort((a, b) => a.centerT - b.centerT);

      if (!wallOpenings.length) {
        addBox(length, props.wallHeight, thickness, (ax + bx) / 2, props.wallHeight / 2, (az + bz) / 2, angle, baseMat);
      } else {
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
            addBox(seg, props.wallHeight, thickness, ax + ux * sMid, props.wallHeight / 2, az + uz * sMid, angle, baseMat);
          }

          const openingWidth = Math.max(0.05, end - start);
          const sill = Math.max(0, Math.min(o.sillM, props.wallHeight));
          const top = Math.min(props.wallHeight, sill + o.heightM);
          if (sill > 0.01) {
            const m = start + openingWidth / 2;
            addBox(openingWidth, sill, thickness, ax + ux * m, sill / 2, az + uz * m, angle, baseMat);
          }
          if (top < props.wallHeight - 0.01) {
            const m = start + openingWidth / 2;
            const h = props.wallHeight - top;
            addBox(openingWidth, h, thickness, ax + ux * m, top + h / 2, az + uz * m, angle, baseMat);
          }

          const fm = start + openingWidth / 2;
          if (o.kind === "window") {
            addBox(openingWidth * 0.92, Math.max(0.35, o.heightM * 0.88), Math.max(0.035, thickness * 0.16), ax + ux * fm, sill + o.heightM / 2, az + uz * fm, angle, glassMat);
            addBox(openingWidth, 0.07, thickness + 0.04, ax + ux * fm, sill + 0.035, az + uz * fm, angle, accentMat);
            addBox(openingWidth, 0.07, thickness + 0.04, ax + ux * fm, top - 0.035, az + uz * fm, angle, accentMat);
          } else {
            addBox(openingWidth * 0.92, Math.max(0.2, o.heightM * 0.94), Math.max(0.035, thickness * 0.13), ax + ux * fm, o.heightM / 2, az + uz * fm, angle, accentMat);
          }
          cursor = Math.max(cursor, end);
        }

        if (cursor < length) {
          const seg = length - cursor;
          const sMid = cursor + seg / 2;
          addBox(seg, props.wallHeight, thickness, ax + ux * sMid, props.wallHeight / 2, az + uz * sMid, angle, baseMat);
        }
      }

      if (props.exteriorWallIds.includes(wall.id) && props.style !== "Minimal دافئ") {
        addBox(length, 0.14, thickness + 0.06, (ax + bx) / 2, props.wallHeight - 0.16, (az + bz) / 2, angle, accentMat);
      }
    }

    for (const room of props.rooms) {
      for (const cell of room.cells) {
        const w = Math.max(0.02, (cell.x2 - cell.x1) * scale);
        const h = Math.max(0.02, (cell.y2 - cell.y1) * scale);
        const x = ((cell.x1 + cell.x2) / 2) * scale - cx;
        const z = ((cell.y1 + cell.y2) / 2) * scale - cy;
        const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.045, h), floorMat);
        floor.position.set(x, 0.022, z);
        floor.receiveShadow = true;
        group.add(floor);

        if (props.ceilingVisible) {
          const ceiling = new THREE.Mesh(new THREE.BoxGeometry(w, 0.045, h), wallMat);
          ceiling.position.set(x, props.wallHeight - 0.025, z);
          group.add(ceiling);
        }
      }
    }

    if (props.roofVisible && props.rooms.length) {
      for (const room of props.rooms) {
        for (const cell of room.cells) {
          const w = (cell.x2 - cell.x1) * scale + 0.18;
          const h = (cell.y2 - cell.y1) * scale + 0.18;
          const x = ((cell.x1 + cell.x2) / 2) * scale - cx;
          const z = ((cell.y1 + cell.y2) / 2) * scale - cy;
          const roof = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, h), roofMat);
          roof.position.set(x, props.wallHeight + 0.1, z);
          roof.castShadow = true;
          group.add(roof);
        }
      }
    }

    const planW = Math.max(10, props.imageSize.w * scale);
    const planH = Math.max(10, props.imageSize.h * scale);

    if (props.siteWallVisible) {
      const sw = planW + 3.2;
      const sh = planH + 3.2;
      const y = 0.9;
      const t = 0.18;
      addBox(sw, 1.8, t, 0, y, -sh / 2, 0, accentMat);
      addBox(sw, 1.8, t, 0, y, sh / 2, 0, accentMat);
      addBox(sh, 1.8, t, -sw / 2, y, 0, Math.PI / 2, accentMat);
      addBox(sh, 1.8, t, sw / 2, y, 0, Math.PI / 2, accentMat);
      const gate = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.6, 0.09), accentMat);
      gate.position.set(0, 0.8, sh / 2 + 0.02);
      group.add(gate);
    }

    scene.add(group);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(planW + 12, planH + 12),
      new THREE.MeshStandardMaterial({ color: 0xcfc7b9, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const driveway = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, Math.max(4, planH * 0.25)),
      new THREE.MeshStandardMaterial({ color: 0x9a9389, roughness: 1 })
    );
    driveway.rotation.x = -Math.PI / 2;
    driveway.position.set(0, 0.006, planH / 2 + Math.max(2, planH * 0.12));
    scene.add(driveway);

    let dragging = false, lastX = 0, lastY = 0;
    let yaw = 0.72, pitch = 0.67;
    let radius = Math.max(20, Math.max(planW, planH) * 1.2);

    const updateCamera = () => {
      pitch = Math.max(0.12, Math.min(1.42, pitch));
      camera.position.set(
        Math.cos(yaw) * Math.cos(pitch) * radius,
        Math.sin(pitch) * radius,
        Math.sin(yaw) * Math.cos(pitch) * radius
      );
      camera.lookAt(0, 1.3, 0);
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
      exportRoot.current = null;
      renderer.dispose();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("wheel", wheel);
    };
  }, [
    props.walls,
    props.openings,
    props.rooms,
    props.exteriorWallIds,
    props.imageSize,
    props.metersPerPixel,
    props.wallHeight,
    props.wallThicknessM,
    props.style,
    props.ceilingVisible,
    props.roofVisible,
    props.siteWallVisible,
  ]);

  return (
    <div className="three-wrap" ref={mount}>
      {!props.walls.length && <div className="three-hint">اكتشف أو ارسم الجدران لتظهر هنا</div>}
      <div className="three-actions">
        <button onClick={exportGlb} disabled={!props.walls.length}>تصدير GLB</button>
      </div>
      <div className="three-badge">أرضيات + سقف + سور • اسحب للدوران • عجلة للتقريب</div>
    </div>
  );
}

export default App;
