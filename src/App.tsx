import { useEffect, useRef, useState } from "react";
import { analyzeWithRemote } from "./analyzer";
import { canonicalizeAndInferOpenings, detectRooms, snapOrthogonalIntersections } from "./geometry";
import { rasterizePlanFile } from "./importers";
import { analyzePlanLocally } from "./planAnalysis";
import { buildHouseInCloud } from "./cloudBuilder";
import ThreeScene from "./ThreeScene";
import type { Column, Opening, Room, Stair, Wall } from "./types";

type Phase = "upload" | "analyzing" | "white" | "building" | "real";

const DEFAULT_SCALE = 0.02;

export default function App() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [progress, setProgress] = useState(0);
  const [imageUrl, setImageUrl] = useState("");
  const [imageSize, setImageSize] = useState({ w: 1200, h: 800 });
  const [metersPerPixel, setMetersPerPixel] = useState<number | null>(DEFAULT_SCALE);
  const [walls, setWalls] = useState<Wall[]>([]);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [columns] = useState<Column[]>([]);
  const [stairs] = useState<Stair[]>([]);
  const [exteriorWallIds, setExteriorWallIds] = useState<string[]>([]);
  const [style, setStyle] = useState("سعودي حديث");
  const [wallHeight, setWallHeight] = useState(3.2);
  const [wallThicknessM, setWallThicknessM] = useState(0.2);
  const [cloudModelUrl, setCloudModelUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const progressTimer = useRef<number | null>(null);

  useEffect(() => {
    if (walls.length < 4 || !metersPerPixel) {
      setRooms([]);
      setExteriorWallIds([]);
      return;
    }
    const result = detectRooms(walls, metersPerPixel);
    setRooms(result.rooms);
    setExteriorWallIds(result.exteriorWallIds);
  }, [walls, metersPerPixel]);

  useEffect(() => () => {
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    if (cloudModelUrl) URL.revokeObjectURL(cloudModelUrl);
  }, [cloudModelUrl]);

  const startProgress = () => {
    setProgress(0);
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    progressTimer.current = window.setInterval(() => {
      setProgress((value) => {
        if (value >= 92) return value;
        const step = value < 35 ? 6 : value < 70 ? 3 : 1;
        return Math.min(92, value + step);
      });
    }, 120);
  };

  const finishProgress = async () => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
    for (const value of [94, 97, 100]) {
      setProgress(value);
      await new Promise((resolve) => window.setTimeout(resolve, 110));
    }
  };

  const estimateScale = (width: number) => {
    if (width <= 0) return DEFAULT_SCALE;
    const assumedPlanWidthM = 22;
    return Math.max(0.008, Math.min(0.035, assumedPlanWidthM / width));
  };

  const analyze = async (dataUrl: string, size: { w: number; h: number }, scale: number) => {
    startProgress();
    setPhase("analyzing");

    let result: { walls: Wall[]; openings: Opening[] } | null = null;
    try {
      try {
        const remote = await analyzeWithRemote(dataUrl, scale);
        if (remote?.walls?.length) {
          if (remote.engine === "cubicasa-resnet34-unet" && remote.openings?.length) {
            result = {
              walls: snapOrthogonalIntersections(remote.walls, scale),
              openings: remote.openings,
            };
          } else {
            const canonical = canonicalizeAndInferOpenings(remote.walls, scale);
            result = {
              walls: snapOrthogonalIntersections(canonical.walls, scale),
              openings: canonical.openings,
            };
          }
        }
      } catch {
        // local fallback
      }

      if (!result || result.walls.length < 4) {
        result = await analyzePlanLocally(dataUrl, scale, wallThicknessM);
      }

      if (!result.walls.length) throw new Error("no-walls");

      setImageSize(size);
      setMetersPerPixel(scale);
      setWalls(result.walls);
      setOpenings(result.openings);
      await finishProgress();
      setPhase("white");
    } catch {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      setProgress(0);
      setPhase("upload");
    }
  };

  const buildRealHouse = async (nextStyle = style) => {
    if (!metersPerPixel || !walls.length) return;
    setStyle(nextStyle);
    setPhase("building");
    startProgress();
    try {
      const url = await buildHouseInCloud({
        walls,
        openings,
        imageSize,
        metersPerPixel,
        wallHeight,
        wallThicknessM,
        style: nextStyle,
      });
      if (cloudModelUrl) URL.revokeObjectURL(cloudModelUrl);
      setCloudModelUrl(url);
      await finishProgress();
      setPhase("real");
    } catch {
      if (progressTimer.current) {
        window.clearInterval(progressTimer.current);
        progressTimer.current = null;
      }
      setProgress(100);
      setCloudModelUrl(null);
      setPhase("real");
    }
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    try {
      const raster = await rasterizePlanFile(file);
      setImageUrl(raster.dataUrl);
      setWalls([]);
      setOpenings([]);
      setRooms([]);
      setExteriorWallIds([]);
      if (cloudModelUrl) URL.revokeObjectURL(cloudModelUrl);
      setCloudModelUrl(null);
      const scale = estimateScale(raster.width);
      await analyze(raster.dataUrl, { w: raster.width, h: raster.height }, scale);
    } catch {
      setPhase("upload");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const reset = () => {
    setPhase("upload");
    setProgress(0);
    setImageUrl("");
    setWalls([]);
    setOpenings([]);
    setRooms([]);
    setExteriorWallIds([]);
    if (cloudModelUrl) URL.revokeObjectURL(cloudModelUrl);
    setCloudModelUrl(null);
  };

  return (
    <div className="flow-app">
      <input
        ref={fileRef}
        type="file"
        className="hidden-input"
        accept="image/*,application/pdf,.pdf"
        onChange={(event) => onFile(event.target.files?.[0])}
      />

      {phase === "upload" && (
        <main className="upload-screen">
          <div className="wordmark">منزل H</div>
          <button className="upload-hero" onClick={() => fileRef.current?.click()}>
            <span className="upload-icon">＋</span>
            <strong>رفع المخطط</strong>
          </button>
        </main>
      )}

      {(phase === "analyzing" || phase === "building") && (
        <main className="analysis-screen">
          <div className="analysis-card">
            <div className="analysis-percent">{progress}%</div>
            <div className="analysis-track">
              <div className="analysis-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="analysis-label">{phase === "building" ? "بناء المنزل سحابيًا" : "تحليل المخطط"}</div>
          </div>
        </main>
      )}

      {(phase === "white" || phase === "real") && (
        <main className="result-screen">
          <header className="result-header">
            <button onClick={reset}>‹</button>
            <strong>{phase === "white" ? "المخطط 3D" : "المنزل"}</strong>
            <button className="ghost-button" onClick={() => fileRef.current?.click()}>＋</button>
          </header>

          <div className="result-scene">
            <ThreeScene
              walls={walls}
              openings={openings}
              rooms={rooms}
              columns={columns}
              stairs={stairs}
              exteriorWallIds={exteriorWallIds}
              imageSize={imageSize}
              metersPerPixel={metersPerPixel}
              wallHeight={wallHeight}
              wallThicknessM={wallThicknessM}
              style={style}
              mode={phase === "real" ? "real" : "white"}
              showExports={phase === "real"}
              modelUrl={phase === "real" ? cloudModelUrl || undefined : undefined}
            />
          </div>

          {phase === "white" ? (
            <div className="execute-bar">
              <button className="execute-button" onClick={() => buildRealHouse()}>نفّذ</button>
            </div>
          ) : (
            <div className="real-controls">
              <button className={style === "سعودي حديث" ? "active" : ""} onClick={() => buildRealHouse("سعودي حديث")}>سعودي</button>
              <button className={style === "نجدي حديث" ? "active" : ""} onClick={() => buildRealHouse("نجدي حديث")}>نجدي</button>
              <button className={style === "حجازي حديث" ? "active" : ""} onClick={() => buildRealHouse("حجازي حديث")}>حجازي</button>
              <button onClick={() => setWallHeight((value) => value >= 3.8 ? 3.0 : Number((value + 0.2).toFixed(1)))}>ارتفاع</button>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
