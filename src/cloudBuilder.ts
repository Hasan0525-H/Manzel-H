import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { Opening, Room, Wall } from "./types";

const CLOUD_HOUSE_URL = "https://manzel-h-studio-v142.onrender.com";
const CLOUD_JOB_URL = "https://manzel-h-cloud-jobs.kd-alsalhi.workers.dev";

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

export async function renderImageInCloud(
  kind: "interior" | "exterior",
  args: CloudHouseArgs,
): Promise<string> {
  const blob = await postBlob(`/render-image/${kind}`, args, 180000);
  if (blob.size < 1000) throw new Error("Empty image");
  return URL.createObjectURL(blob);
}


export async function renderPlanInCloud(
  kind: "interior" | "exterior",
  file: File,
  options: DesignOptions,
): Promise<string> {
  const configured = import.meta.env.VITE_HOUSE_BUILDER_URL?.trim();
  const base = configured || CLOUD_HOUSE_URL;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 900000);

  const body = new FormData();
  body.append("file", file, file.name || "floorplan");
  body.append("floors", String(options.floors));
  body.append("furnishing", options.furnishing);
  body.append("style", options.style);
  body.append("garden", String(options.garden));
  body.append("parking", String(options.parking));
  body.append("fence", String(options.fence));
  body.append("entrance", options.entrance);

  try {
    const response = await fetch(
      `${base.replace(/\/$/, "")}/render-plan/${kind}`,
      {
        method: "POST",
        body,
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`Cloud plan renderer HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.size < 1000) throw new Error("Empty image");
    return URL.createObjectURL(blob);
  } finally {
    window.clearTimeout(timer);
  }
}


export type RenderJobStatus = "queued" | "processing" | "done" | "failed";

type RenderJobResponse = {
  id: string;
  status: RenderJobStatus;
  attempts?: number;
  error?: string | null;
  resultUrl?: string | null;
};

function jobApiBase(): string {
  const configured = import.meta.env.VITE_JOB_API_URL?.trim();
  return (configured || CLOUD_JOB_URL).replace(/\/$/, "");
}

export function isBrowserImagePlan(file: Pick<File, "name" | "type">): boolean {
  const type = file.type.trim().toLowerCase();
  if (type === "image/png" || type === "image/jpeg" || type === "image/webp") {
    return true;
  }

  // Android document providers do not always preserve MIME metadata.
  // Route by filename when MIME metadata is missing or generic.
  return /\.(png|jpe?g|webp)$/i.test(file.name.trim());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBlobUrl(value: string, mime = "image/png"): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

async function renderPlanDirect(
  kind: "interior" | "exterior",
  file: File,
  options: DesignOptions,
): Promise<string> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const payload = {
    imageBase64: bytesToBase64(raw),
    filename: file.name || "floorplan.jpg",
    contentType: file.type || "application/octet-stream",
    kind,
    floors: options.floors,
    furnishing: options.furnishing,
    style: options.style,
    garden: options.garden,
    parking: options.parking,
    fence: options.fence,
    entrance: options.entrance,
  };

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: `${jobApiBase()}/render-json`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: payload,
      responseType: "json",
      connectTimeout: 30_000,
      readTimeout: 300_000,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Native render HTTP ${response.status}`);
    }

    const data = response.data as { imageBase64?: string; mime?: string; error?: string };
    if (!data?.imageBase64) throw new Error(data?.error || "Native render returned no image");
    return base64ToBlobUrl(data.imageBase64, data.mime || "image/png");
  }

  const response = await fetchWithTimeout(
    `${jobApiBase()}/render-json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    },
    300_000,
  );
  if (!response.ok) throw new Error(`Direct render HTTP ${response.status}`);
  const data = await response.json() as { imageBase64?: string; mime?: string; error?: string };
  if (!data.imageBase64) throw new Error(data.error || "Direct render returned no image");
  return base64ToBlobUrl(data.imageBase64, data.mime || "image/png");
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function createRenderJob(
  kind: "interior" | "exterior",
  file: File,
  options: DesignOptions,
): Promise<RenderJobResponse> {
  const body = new FormData();
  body.append("file", file, file.name || "floorplan");
  body.append("kind", kind);
  body.append("floors", String(options.floors));
  body.append("furnishing", options.furnishing);
  body.append("style", options.style);
  body.append("garden", String(options.garden));
  body.append("parking", String(options.parking));
  body.append("fence", String(options.fence));
  body.append("entrance", options.entrance);

  const response = await fetchWithTimeout(`${jobApiBase()}/jobs/render`, {
    method: "POST",
    body,
  }, 45_000);
  if (!response.ok) {
    throw new Error(`Create render job HTTP ${response.status}`);
  }
  return await response.json() as RenderJobResponse;
}

async function waitForRenderJob(
  id: string,
  timeoutMs = 15 * 60 * 1000,
): Promise<RenderJobResponse> {
  const started = Date.now();
  let delay = 1500;

  while (Date.now() - started < timeoutMs) {
    const response = await fetchWithTimeout(`${jobApiBase()}/jobs/${encodeURIComponent(id)}`, {
      cache: "no-store",
    }, 20_000);
    if (!response.ok) {
      throw new Error(`Render job status HTTP ${response.status}`);
    }

    const job = await response.json() as RenderJobResponse;
    if (job.status === "done") return job;
    if (job.status === "failed") {
      throw new Error(job.error || "Render job failed");
    }

    await new Promise((resolve) => window.setTimeout(resolve, delay));
    delay = Math.min(5000, Math.round(delay * 1.25));
  }

  throw new Error("Render job timed out");
}

async function fetchRenderJobResult(id: string): Promise<string> {
  const response = await fetchWithTimeout(
    `${jobApiBase()}/jobs/${encodeURIComponent(id)}/result`,
    { cache: "no-store" },
    60_000,
  );
  if (!response.ok) {
    throw new Error(`Render job result HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (blob.size < 1000) throw new Error("Empty job result");
  return URL.createObjectURL(blob);
}

export async function renderPlanViaJob(
  kind: "interior" | "exterior",
  file: File,
  options: DesignOptions,
): Promise<string> {
  const created = await createRenderJob(kind, file, options);
  await waitForRenderJob(created.id);
  return await fetchRenderJobResult(created.id);
}

export async function renderPlanWithRecovery(
  kind: "interior" | "exterior",
  file: File,
  options: DesignOptions,
): Promise<string> {
  // Image plans render synchronously on Cloudflare and no longer depend on Render.
  // PDF plans keep the queued compatibility path until they can be rasterized locally.
  if (isBrowserImagePlan(file)) {
    return await renderPlanDirect(kind, file, options);
  }
  return await renderPlanViaJob(kind, file, options);
}
