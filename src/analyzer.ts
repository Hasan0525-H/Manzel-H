import type { Opening, Wall } from "./types";

type AnalyzerWall = Wall & {
  confidence?: number;
  orientation?: "horizontal" | "vertical" | "diagonal";
};

export type AnalyzeResponse = {
  width: number;
  height: number;
  engine?: string;
  walls: AnalyzerWall[];
  openings?: Opening[];
};

const DEFAULT_ANALYZER_URL = "https://manzel-h-ml-analyzer-v11.onrender.com";

export async function analyzeWithRemote(
  imageUrl: string,
  metersPerPixel?: number | null,
): Promise<AnalyzeResponse | null> {
  const configured = import.meta.env.VITE_ANALYZER_URL?.trim();
  const base = configured || DEFAULT_ANALYZER_URL;

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error("تعذر قراءة صورة المخطط");
  const blob = await imageResponse.blob();

  const body = new FormData();
  body.append("file", blob, "floorplan.png");
  if (metersPerPixel && metersPerPixel > 0) {
    body.append("meters_per_pixel", String(metersPerPixel));
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 90000);
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
