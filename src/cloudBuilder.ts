import type { Opening, Room, Wall } from "./types";

const CLOUD_HOUSE_URL = "https://manzel-h-studio-v14.onrender.com";

export type DesignOptions = {
  floors: number;
  furnishing: "full" | "light" | "none";
  style: string;
  outputs: Array<"interior" | "exterior">;
  garden: boolean;
  parking: boolean;
  fence: boolean;
  entrance: "formal" | "simple";
};

export type CloudHouseArgs = {
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  imageSize: { w: number; h: number };
  metersPerPixel: number;
  wallHeight: number;
  wallThicknessM: number;
  exteriorWallIds: string[];
} & DesignOptions;

async function postBlob(path: string, args: CloudHouseArgs, timeoutMs: number): Promise<Blob> {
  const configured = import.meta.env.VITE_HOUSE_BUILDER_URL?.trim();
  const base = configured || CLOUD_HOUSE_URL;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Cloud renderer HTTP ${response.status}`);
    return await response.blob();
  } finally {
    window.clearTimeout(timer);
  }
}

export async function buildHouseInCloud(args: CloudHouseArgs): Promise<string> {
  const blob = await postBlob("/build-house", args, 120000);
  if (blob.size < 1000) throw new Error("Empty GLB");
  return URL.createObjectURL(blob);
}

export async function renderImageInCloud(
  kind: "interior" | "exterior",
  args: CloudHouseArgs,
): Promise<string> {
  const blob = await postBlob(`/render-image/${kind}`, args, 120000);
  if (blob.size < 1000) throw new Error("Empty image");
  return URL.createObjectURL(blob);
}
