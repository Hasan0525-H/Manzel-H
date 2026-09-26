import type { Wall } from "./types";

type AnalyzerWall = Wall & {
  confidence: number;
  orientation: "horizontal" | "vertical" | "diagonal";
};

type AnalyzeResponse = {
  width: number;
  height: number;
  walls: AnalyzerWall[];
};

export async function analyzeWithRemote(imageUrl: string): Promise<AnalyzeResponse | null> {
  const base = import.meta.env.VITE_ANALYZER_URL?.trim();
  if (!base) return null;

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error("تعذر قراءة صورة المخطط");
  const blob = await imageResponse.blob();

  const body = new FormData();
  body.append("file", blob, "floorplan.png");

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/analyze`, {
      method: "POST",
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Analyzer HTTP ${response.status}`);
    return await response.json() as AnalyzeResponse;
  } finally {
    window.clearTimeout(timer);
  }
}
