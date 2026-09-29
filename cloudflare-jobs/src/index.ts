interface Env {
  JOBS: R2Bucket;
  RENDER_QUEUE: Queue<RenderMessage>;
  MODAL_PIPELINE_URL?: string;
}

type RenderKind = "interior" | "exterior";

type RenderOptions = {
  floors: number;
  furnishing: "full" | "light" | "none";
  style: string;
  garden: boolean;
  parking: boolean;
  fence: boolean;
  entrance: "formal" | "simple";
};

type JobStatus = "queued" | "processing" | "done" | "failed";

type JobRecord = {
  id: string;
  kind: RenderKind;
  status: JobStatus;
  filename: string;
  contentType: string;
  inputKey: string;
  outputKey?: string;
  options: RenderOptions;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type RenderMessage = { jobId: string };

const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;
const SUPPORTED_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function now(): string {
  return new Date().toISOString();
}

function modalBase(env: Env): string {
  const base = env.MODAL_PIPELINE_URL?.trim().replace(/\/$/, "");
  if (!base) throw new Error("modal_pipeline_not_configured");
  return base;
}

function jobKey(id: string): string {
  return `jobs/${id}.json`;
}

async function readJob(env: Env, id: string): Promise<JobRecord | null> {
  const obj = await env.JOBS.get(jobKey(id));
  if (!obj) return null;
  return await obj.json<JobRecord>();
}

async function writeJob(env: Env, job: JobRecord): Promise<void> {
  job.updatedAt = now();
  await env.JOBS.put(jobKey(job.id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });
}

function isSupportedUpload(file: File): boolean {
  const contentType = file.type.trim().toLowerCase();
  if (SUPPORTED_UPLOAD_MIME_TYPES.has(contentType)) return true;
  return /\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i.test(file.name.trim());
}

function normalizeFloors(value: FormDataEntryValue | null): number {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(4, Math.round(parsed)));
}

function normalizeOptions(form: FormData): RenderOptions {
  const furnishing = String(form.get("furnishing") || "full");
  const entrance = String(form.get("entrance") || "formal");
  return {
    floors: normalizeFloors(form.get("floors")),
    furnishing: furnishing === "none" ? "none" : furnishing === "light" ? "light" : "full",
    style: String(form.get("style") || "سعودي حديث"),
    garden: String(form.get("garden") ?? "true") === "true",
    parking: String(form.get("parking") ?? "true") === "true",
    fence: String(form.get("fence") ?? "true") === "true",
    entrance: entrance === "simple" ? "simple" : "formal",
  };
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function callModal(
  env: Env,
  path: "/health" | "/render" | "/analyze",
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path === "/render" ? 780_000 : 120_000);
  try {
    return await fetch(`${modalBase(env)}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardJson(request: Request, env: Env, path: "/render" | "/analyze"): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  let response: Response;
  try {
    response = await callModal(env, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return json({
      error: "pipeline_unavailable",
      detail: error instanceof Error ? error.message : "unknown_error",
    }, 503);
  }

  const body = await response.text();
  const headers = new Headers(jsonHeaders);
  headers.set("x-manzel-pipeline", "modal");
  return new Response(body, { status: response.status, headers });
}

async function createJob(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  const kind = String(form.get("kind") || "");

  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (kind !== "interior" && kind !== "exterior") return json({ error: "invalid_kind" }, 400);
  if (!isSupportedUpload(file)) return json({ error: "unsupported_file_type" }, 415);
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return json({ error: "invalid_file_size" }, 413);

  const id = crypto.randomUUID();
  const inputKey = `inputs/${id}/plan`;
  const createdAt = now();

  await env.JOBS.put(inputKey, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { filename: file.name || "floorplan" },
  });

  const job: JobRecord = {
    id,
    kind,
    status: "queued",
    filename: file.name || "floorplan",
    contentType: file.type || "application/octet-stream",
    inputKey,
    options: normalizeOptions(form),
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };

  await writeJob(env, job);
  await env.RENDER_QUEUE.send({ jobId: id });

  return json({
    id,
    status: job.status,
    statusUrl: `/jobs/${id}`,
    resultUrl: `/jobs/${id}/result`,
  }, 202);
}

async function getJob(id: string, env: Env): Promise<Response> {
  const job = await readJob(env, id);
  if (!job) return json({ error: "not_found" }, 404);
  return json({
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    resultUrl: job.status === "done" ? `/jobs/${job.id}/result` : null,
  });
}

async function getResult(id: string, env: Env): Promise<Response> {
  const job = await readJob(env, id);
  if (!job) return json({ error: "not_found" }, 404);
  if (job.status !== "done" || !job.outputKey) {
    return json({ error: "result_not_ready", status: job.status }, 409);
  }

  const obj = await env.JOBS.get(job.outputKey);
  if (!obj) return json({ error: "result_missing" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-type", "image/png");
  headers.set("cache-control", "private, max-age=86400");
  headers.set("access-control-allow-origin", "*");
  return new Response(obj.body, { headers });
}

async function processJob(message: Message<RenderMessage>, env: Env): Promise<void> {
  const id = message.body.jobId;
  const job = await readJob(env, id);
  if (!job || job.status === "done" || job.status === "failed") {
    message.ack();
    return;
  }

  job.status = "processing";
  job.attempts += 1;
  job.error = undefined;
  await writeJob(env, job);

  try {
    const input = await env.JOBS.get(job.inputKey);
    if (!input) throw new Error("input_missing");

    const raw = new Uint8Array(await input.arrayBuffer());
    const payload = {
      imageBase64: bytesToBase64(raw),
      filename: job.filename,
      contentType: job.contentType,
      kind: job.kind,
      ...job.options,
    };

    const response = await callModal(env, "/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`modal_render_${response.status}_${detail}`);
    }

    const result = await response.json() as { imageBase64?: string; mime?: string };
    if (!result.imageBase64) throw new Error("modal_render_missing_image");
    const image = base64ToBytes(result.imageBase64);
    if (image.byteLength < 10_000) throw new Error("modal_render_result_too_small");

    const outputKey = `outputs/${job.id}/${job.kind}.png`;
    await env.JOBS.put(outputKey, image, {
      httpMetadata: { contentType: result.mime || "image/png" },
    });

    job.status = "done";
    job.outputKey = outputKey;
    await writeJob(env, job);
    message.ack();
  } catch (error) {
    job.error = error instanceof Error ? error.message.slice(0, 500) : "unknown_error";
    if (job.attempts >= 3) {
      job.status = "failed";
      await writeJob(env, job);
      message.ack();
    } else {
      job.status = "queued";
      await writeJob(env, job);
      message.retry({ delaySeconds: Math.min(60, 10 * job.attempts) });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const response = await callModal(env, "/health");
        const pipeline = await response.json().catch(() => null);
        return json({
          ok: response.ok,
          gateway: "cloudflare",
          pipeline: "modal",
          configured: true,
          upstream: pipeline,
        }, response.ok ? 200 : 503);
      } catch (error) {
        return json({
          ok: false,
          gateway: "cloudflare",
          pipeline: "modal",
          configured: Boolean(env.MODAL_PIPELINE_URL?.trim()),
          error: error instanceof Error ? error.message : "unknown_error",
        }, 503);
      }
    }

    if (request.method === "POST" && url.pathname === "/render-json") {
      return forwardJson(request, env, "/render");
    }

    if (request.method === "POST" && url.pathname === "/analyze-json") {
      return forwardJson(request, env, "/analyze");
    }

    if (request.method === "POST" && url.pathname === "/jobs/render") {
      return createJob(request, env);
    }

    if (request.method === "GET" && parts[0] === "jobs" && parts[1] && parts.length === 2) {
      return getJob(parts[1], env);
    }

    if (
      request.method === "GET" &&
      parts[0] === "jobs" &&
      parts[1] &&
      parts[2] === "result"
    ) {
      return getResult(parts[1], env);
    }

    return json({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<RenderMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processJob(message, env);
    }
  },
} satisfies ExportedHandler<Env, RenderMessage>;
