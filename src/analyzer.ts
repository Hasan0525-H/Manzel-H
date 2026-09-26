import type { Opening, Room, Wall } from "./types";

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
  rooms?: Room[];
  exteriorWallIds?: string[];
};

const DEFAULT_ANALYZER_URL = "https://manzel-h-studio-v142.onrender.com";

export async function analyzeWithRemote(
  file: File,
  metersPerPixel?: number | null,
): Promise<AnalyzeResponse> {
  const body = new FormData();
  body.append("file", file, file.name || "floorplan");
  if (metersPerPixel && metersPerPixel > 0) {
    body.append("meters_per_pixel", String(metersPerPixel));
  }

  const configured = import.meta.env.VITE_ANALYZER_URL?.trim();
  const base = configured || DEFAULT_ANALYZER_URL;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 150000);

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
