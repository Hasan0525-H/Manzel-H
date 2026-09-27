import { useMemo, useRef, useState } from "react";
import { renderPlanViaJob, type DesignOptions } from "./cloudBuilder";

type Phase = "upload" | "setup" | "analyzing" | "building" | "result";
type ResultTab = "interior" | "exterior";

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
  const [planFile, setPlanFile] = useState<File | null>(null);
  const [metersPerPixel] = useState(DEFAULT_SCALE);
  const [options, setOptions] = useState<DesignOptions>(defaultOptions);
  const [interiorUrl, setInteriorUrl] = useState<string | null>(null);
  const [exteriorUrl, setExteriorUrl] = useState<string | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("interior");
  const [error, setError] = useState("");
  const useQueuedCloud = true;

  const fileRef = useRef<HTMLInputElement | null>(null);
  const progressTimer = useRef<number | null>(null);

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
    }, 170);
  };

  const finishProgress = async () => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
    for (const value of [96, 99, 100]) {
      setProgress(value);
      await new Promise((resolve) => window.setTimeout(resolve, 90));
    }
  };

  const clearResults = () => {
    [interiorUrl, exteriorUrl].forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
    setInteriorUrl(null);
    setExteriorUrl(null);
  };

  const onFile = (file?: File) => {
    if (!file) return;
    setError("");
    clearResults();
    setPlanFile(file);
    setPhase("setup");
    if (fileRef.current) fileRef.current.value = "";
  };

  const renderWithFallback = async (kind: ResultTab): Promise<string> => {
    return await renderPlanViaJob(kind, planFile!, options);
  };

  const runPipeline = async () => {
    if (!planFile) return;

    setError("");
    startProgress();
    setPhase("building");

    try {
      let interior: string | null = null;
      let exterior: string | null = null;

      // Send the original plan directly to FLUX.2.
      // No Torch/ML analysis runs on the phone or on the free Render instance.
      if (options.outputs.includes("interior")) {
        try {
          interior = await renderWithFallback("interior");
        } catch {
          interior = null;
        }
      }
      if (options.outputs.includes("exterior")) {
        try {
          exterior = await renderWithFallback("exterior");
        } catch {
          exterior = null;
        }
      }

      if (!interior && !exterior) throw new Error("render-unavailable");

      clearResults();
      setInteriorUrl(interior);
      setExteriorUrl(exterior);
      setResultTab(interior ? "interior" : "exterior");

      await finishProgress();
      setPhase("result");
    } catch {
      if (progressTimer.current) {
        window.clearInterval(progressTimer.current);
        progressTimer.current = null;
      }
      setProgress(0);
      setError("تعذر تنفيذ المعالجة السحابية. حاول مرة أخرى.");
      setPhase("setup");
    }
  };

  const reset = () => {
    clearResults();
    setPlanFile(null);
    setPhase("upload");
    setProgress(0);
    setError("");
  };

  const toggleOutput = (kind: ResultTab) => {
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
                {[1, 2, 3].map((value) => (
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
                {["سعودي حديث", "مودرن فاخر", "نجدي حديث", "حجازي حديث"].map((value) => (
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
            <span>{planFile?.name} · {options.floors} طابق · {outputsLabel}</span>
            <button onClick={runPipeline}>نفّذ</button>
          </div>
          {error && <div className="toast-error">{error}</div>}
        </main>
      )}

      {(phase === "analyzing" || phase === "building") && (
        <main className="analysis-screen">
          <div className="analysis-card">
            <div className="analysis-percent">{progress}%</div>
            <div className="analysis-track">
              <div className="analysis-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="analysis-label">{phase === "building" ? "إنشاء النتيجة على الخادم" : "تحليل المخطط على الخادم"}</div>
          </div>
        </main>
      )}

      {phase === "result" && (
        <main className="final-screen">
          <header className="result-header">
            <button onClick={() => setPhase("setup")}>‹</button>
            <strong>النتيجة</strong>
            <button className="ghost-button" onClick={reset}>＋</button>
          </header>

          <div className="final-stage">
            {resultTab === "interior" && interiorUrl && <img className="final-image" src={interiorUrl} alt="" />}
            {resultTab === "exterior" && exteriorUrl && <img className="final-image" src={exteriorUrl} alt="" />}
          </div>

          <nav className="result-tabs">
            {interiorUrl && <button className={resultTab === "interior" ? "active" : ""} onClick={() => setResultTab("interior")}>داخلي</button>}
            {exteriorUrl && <button className={resultTab === "exterior" ? "active" : ""} onClick={() => setResultTab("exterior")}>واجهة</button>}
          </nav>
        </main>
      )}
    </div>
  );
}
