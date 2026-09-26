import type { Opening, Wall } from "./types";

const CLOUD_HOUSE_URL = "https://manzel-h-cloud-v12.onrender.com";

export async function buildHouseInCloud(args: {
  walls: Wall[];
  openings: Opening[];
  imageSize: { w: number; h: number };
  metersPerPixel: number;
  wallHeight: number;
  wallThicknessM: number;
  style: string;
}): Promise<string> {
  const configured = import.meta.env.VITE_HOUSE_BUILDER_URL?.trim();
  const base = configured || CLOUD_HOUSE_URL;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/build-house`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`House builder HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.size < 1000) throw new Error("Empty GLB");
    return URL.createObjectURL(blob);
  } finally {
    window.clearTimeout(timer);
  }
}
