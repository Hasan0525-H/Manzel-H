import { Capacitor, CapacitorHttp } from "@capacitor/core";
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

const DEFAULT_JOB_URL = "https://manzel-h-cloud-jobs.kd-alsalhi.workers.dev";

function apiBase(): string {
  const configured = import.meta.env.VITE_JOB_API_URL?.trim();
  return (configured || DEFAULT_JOB_URL).replace(/\/$/, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function analyzeWithRemote(
  file: File,
  metersPerPixel?: number | null,
): Promise<AnalyzeResponse> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const payload = {
    imageBase64: bytesToBase64(raw),
    filename: file.name || "floorplan",
    contentType: file.type || "application/octet-stream",
    metersPerPixel: metersPerPixel && metersPerPixel > 0 ? metersPerPixel : undefined,
  };

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: `${apiBase()}/analyze-json`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: payload,
      responseType: "json",
      connectTimeout: 30_000,
      readTimeout: 180_000,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Analyzer HTTP ${response.status}`);
    }
    return response.data as AnalyzeResponse;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${apiBase()}/analyze-json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Analyzer HTTP ${response.status}`);
    return await response.json() as AnalyzeResponse;
  } finally {
    window.clearTimeout(timer);
  }
}
