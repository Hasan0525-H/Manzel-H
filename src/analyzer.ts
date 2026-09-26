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

const ML_ANALYZER_URL = "https://manzel-h-cloud-v12.onrender.com";
const CV_ANALYZER_URL = "https://manzel-h-analyzer-v2.onrender.com";

async function callAnalyzer(
  base: string,
  blob: Blob,
  metersPerPixel?: number | null,
  timeoutMs = 90000,
): Promise<AnalyzeResponse> {
  const body = new FormData();
  body.append("file", blob, "floorplan.png");
  if (metersPerPixel && metersPerPixel > 0) {
    body.append("meters_per_pixel", String(metersPerPixel));
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
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

export async function analyzeWithRemote(
  imageUrl: string,
  metersPerPixel?: number | null,
): Promise<AnalyzeResponse | null> {
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error("تعذر قراءة صورة المخطط");
  const blob = await imageResponse.blob();

  const configured = import.meta.env.VITE_ANALYZER_URL?.trim();
  const endpoints = configured
    ? [configured]
    : [ML_ANALYZER_URL, CV_ANALYZER_URL];

  let lastError: unknown = null;
  for (const endpoint of endpoints) {
    try {
      const result = await callAnalyzer(
        endpoint,
        blob,
        metersPerPixel,
        endpoint === ML_ANALYZER_URL ? 90000 : 45000,
      );
      if (result?.walls?.length) return result;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}
