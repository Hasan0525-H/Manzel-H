import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeWithRemote } from "./analyzer";
import { canonicalizeAndInferOpenings, detectRooms, snapOrthogonalIntersections } from "./geometry";
import { rasterizePlanFile } from "./importers";
import { analyzePlanLocally } from "./planAnalysis";
import { buildHouseInCloud, renderImageInCloud, type CloudHouseArgs, type DesignOptions } from "./cloudBuilder";
import ThreeScene from "./ThreeScene";
import type { Column, Opening, Room, Stair, Wall } from "./types";

type Phase = "upload" | "setup" | "analyzing" | "white" | "building" | "result";
type ResultTab = "interior" | "exterior" | "3d";

const DEFAULT_SCALE = 0.02;

const defaultOptions: DesignOptions = {
  floors: 1,
  furnishing: "full",
  style: "سعودي حديث",
  outputs: ["interior", "exterior"],
  garden: true,
  parking: true,
  fence: true,
  entrance: "formal",
};

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
  const [wallHeight, setWallHeight] = useState(3.2);
  const [wallThicknessM] = useState(0.2);
  const [options, setOptions] = useState<DesignOptions>(defaultOptions);
  const [cloudModelUrl, setCloudModelUrl] = useState<string | null>(null);
  const [interiorUrl, setInteriorUrl] = useState<string | null>(null);
  const [exteriorUrl, setExteriorUrl] = useState<string | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("interior");
  const [error, setError] = useState("");

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
    [cloudModelUrl, interiorUrl, exteriorUrl].forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
  }, [cloudModelUrl, interiorUrl, exteriorUrl]);

  const outputsLabel = useMemo(() => {
    if (options.outputs.length === 2) return "داخلي + خارجي";
    return options.outputs[0] === "interior" ? "داخلي" : "خارجي";
  }, [options.outputs]);

  const startProgress = () => {
    setProgress(0);
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    progressTimer.current = window.setInterval(() => {
      setProgress((value) => {
        if (value >= 93) return value;
        const step = value < 30 ? 5 : value < 65 ? 3 : 1;
        return Math.min(93, value + step);
      });
    }, 150);
  };

  const finishProgress = async () => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
    for (const value of [96, 99, 100]) {
      setProgress(value);
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
  };

  const estimateScale = (width: number) => {
    if (width <= 0) return DEFAULT_SCALE;
    const assumedPlanWidthM = 22;
    return Math.max(0.008, Math.min(0.035, assumedPlanWidthM / width));
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    setError("");
    try {
      const raster = await rasterizePlanFile(file);
      setImageUrl(raster.dataUrl);
      setImageSize({ w: raster.width, h: raster.height });
      setMetersPerPixel(estimateScale(raster.width));
      setWalls([]);
      setOpenings([]);
      setRooms([]);
      setExteriorWallIds([]);
      clearResults();
      setPhase("setup");
    } catch {
      setError("تعذر فتح المخطط");
      setPhase("upload");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const analyze = async () => {
    if (!imageUrl || !metersPerPixel) return;
    setError("");
    startProgress();
    setPhase("analyzing");

    let result: { walls: Wall[]; openings: Opening[] } | null = null;
    try {
      try {
        const remote = await analyzeWithRemote(imageUrl, metersPerPixel);
        if (remote?.walls?.length) {
          if (remote.engine === "cubicasa-resnet34-unet" && remote.openings?.length) {
            result = {
              walls: snapOrthogonalIntersections(remote.walls, metersPerPixel),
              openings: remote.openings,
            };
          } else {
            const canonical = canonicalizeAndInferOpenings(remote.walls, metersPerPixel);
            result = {
              walls: snapOrthogonalIntersections(canonical.walls, metersPerPixel),
              openings: canonical.openings,
            };
          }
        }
      } catch {
        // local fallback
      }

      if (!result || result.walls.length < 4) {
        result = await analyzePlanLocally(imageUrl, metersPerPixel, wallThicknessM);
      }

      if (!result.walls.length) throw new Error("no-walls");

      setWalls(result.walls);
      setOpenings(result.openings);
      await finishProgress();
      setPhase("white");
    } catch {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      setProgress(0);
      setError("تعذر تحليل المخطط");
      setPhase("setup");
    }
  };

  const cloudArgs = (): CloudHouseArgs | null => {
    if (!metersPerPixel || !walls.length) return null;
    return {
      walls,
      openings,
      rooms,
      imageSize,
      metersPerPixel,
      wallHeight,
      wallThicknessM,
      exteriorWallIds,
      ...options,
    };
  };

  const execute = async () => {
    const args = cloudArgs();
    if (!args) return;

    setError("");
    startProgress();
    setPhase("building");

    try {
      const tasks: Array<Promise<{ kind: "model" | "interior" | "exterior"; url: string }>> = [
        buildHouseInCloud(args).then((url) => ({ kind: "model" as const, url })),
      ];
      if (options.outputs.includes("interior")) {
        tasks.push(renderImageInCloud("interior", args).then((url) => ({ kind: "interior" as const, url })));
      }
      if (options.outputs.includes("exterior")) {
        tasks.push(renderImageInCloud("exterior", args).then((url) => ({ kind: "exterior" as const, url })));
      }

      const settled = await Promise.allSettled(tasks);
      let model: string | null = null;
      let interior: string | null = null;
      let exterior: string | null = null;

      for (const item of settled) {
        if (item.status !== "fulfilled") continue;
        if (item.value.kind === "model") model = item.value.url;
        if (item.value.kind === "interior") interior = item.value.url;
        if (item.value.kind === "exterior") exterior = item.value.url;
      }

      if (!model && !interior && !exterior) throw new Error("cloud-failed");

      if (cloudModelUrl) URL.revokeObjectURL(cloudModelUrl);
      if (interiorUrl) URL.revokeObjectURL(interiorUrl);
      if (exteriorUrl) URL.revokeObjectURL(exteriorUrl);
      setCloudModelUrl(model);
      setInteriorUrl(interior);
      setExteriorUrl(exterior);

      if (interior) setResultTab("interior");
      else if (exterior) setResultTab("exterior");
      else setResultTab("3d");

      await finishProgress();
      setPhase("result");
    } catch {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      setError("تعذر إنشاء النتيجة");
      setPhase("white");
    }
  };

  const clearResults = () => {
    [cloudModelUrl, interiorUrl, exteriorUrl].forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    setCloudModelUrl(null);
    setInteriorUrl(null);
    setExteriorUrl(null);
  };

  const reset = () => {
    clearResults();
    setPhase("upload");
    setProgress(0);
    setImageUrl("");
    setWalls([]);
    setOpenings([]);
    setRooms([]);
    setExteriorWallIds([]);
    setError("");
  };

  const toggleOutput = (kind: "interior" | "exterior") => {
    setOptions((current) => {
      const exists = current.outputs.includes(kind);
      const next = exists ? current.outputs.filter((x) => x !== kind) : [...current.outputs, kind];
      return { ...current, outputs: next.length ? next : [kind] };
    });
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
          <div className="wordmark">منزل</div>
          <button className="upload-hero" onClick={() => fileRef.current?.click()}>
            <span className="upload-icon">＋</span>
            <strong>رفع المخطط</strong>
          </button>
          {error && <div className="compact-error">{error}</div>}
        </main>
      )}

      {phase === "setup" && (
        <main className="setup-screen">
          <header className="simple-header">
            <button onClick={reset}>‹</button>
            <strong>التصميم</strong>
            <button onClick={() => fileRef.current?.click()}>＋</button>
          </header>

          <div className="setup-content">
            <section className="setup-block">
              <h2>عدد الطوابق</h2>
              <div className="choice-grid three">
                {[1,2,3].map((value) => (
                  <button key={value} className={options.floors === value ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, floors: value }))}>
                    {value}
                  </button>
                ))}
              </div>
            </section>

            <section className="setup-block">
              <h2>التأثيث</h2>
              <div className="choice-grid three">
                <button className={options.furnishing === "full" ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, furnishing: "full" }))}>كامل</button>
                <button className={options.furnishing === "light" ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, furnishing: "light" }))}>خفيف</button>
                <button className={options.furnishing === "none" ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, furnishing: "none" }))}>بدون</button>
              </div>
            </section>

            <section className="setup-block">
              <h2>الطراز</h2>
              <div className="choice-grid two">
                {["سعودي حديث","مودرن فاخر","نجدي حديث","حجازي حديث"].map((value) => (
                  <button key={value} className={options.style === value ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, style: value }))}>
                    {value}
                  </button>
                ))}
              </div>
            </section>

            <section className="setup-block">
              <h2>النتيجة</h2>
              <div className="choice-grid two">
                <button className={options.outputs.includes("interior") ? "active" : ""} onClick={() => toggleOutput("interior")}>داخلي</button>
                <button className={options.outputs.includes("exterior") ? "active" : ""} onClick={() => toggleOutput("exterior")}>واجهة</button>
              </div>
            </section>

            <section className="setup-block">
              <h2>الموقع</h2>
              <div className="toggle-list">
                <button className={options.garden ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, garden: !o.garden }))}>حديقة</button>
                <button className={options.parking ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, parking: !o.parking }))}>موقف</button>
                <button className={options.fence ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, fence: !o.fence }))}>سور</button>
                <button className={options.entrance === "formal" ? "active" : ""} onClick={() => setOptions((o) => ({ ...o, entrance: o.entrance === "formal" ? "simple" : "formal" }))}>مدخل فاخر</button>
              </div>
            </section>
          </div>

          <div className="setup-footer">
            <span>{options.floors} طابق · {outputsLabel}</span>
            <button onClick={analyze}>ابدأ</button>
          </div>
        </main>
      )}

      {(phase === "analyzing" || phase === "building") && (
        <main className="analysis-screen">
          <div className="analysis-card">
            <div className="analysis-percent">{progress}%</div>
            <div className="analysis-track">
              <div className="analysis-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="analysis-label">{phase === "building" ? "إنشاء النتيجة" : "تحليل المخطط"}</div>
          </div>
        </main>
      )}

      {phase === "white" && (
        <main className="result-screen">
          <header className="result-header">
            <button onClick={() => setPhase("setup")}>‹</button>
            <strong>المخطط 3D</strong>
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
              style={options.style}
              mode="white"
            />
          </div>
          <div className="execute-bar">
            <button className="execute-button" onClick={execute}>نفّذ</button>
          </div>
          {error && <div className="toast-error">{error}</div>}
        </main>
      )}

      {phase === "result" && (
        <main className="final-screen">
          <header className="result-header">
            <button onClick={() => setPhase("white")}>‹</button>
            <strong>النتيجة</strong>
            <button className="ghost-button" onClick={reset}>＋</button>
          </header>

          <div className="final-stage">
            {resultTab === "interior" && interiorUrl && <img className="final-image" src={interiorUrl} alt="" />}
            {resultTab === "exterior" && exteriorUrl && <img className="final-image" src={exteriorUrl} alt="" />}
            {resultTab === "3d" && (
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
                style={options.style}
                mode="real"
                modelUrl={cloudModelUrl || undefined}
              />
            )}
          </div>

          <nav className="result-tabs">
            {interiorUrl && <button className={resultTab === "interior" ? "active" : ""} onClick={() => setResultTab("interior")}>داخلي</button>}
            {exteriorUrl && <button className={resultTab === "exterior" ? "active" : ""} onClick={() => setResultTab("exterior")}>واجهة</button>}
            <button className={resultTab === "3d" ? "active" : ""} onClick={() => setResultTab("3d")}>3D</button>
          </nav>
        </main>
      )}
    </div>
  );
}
