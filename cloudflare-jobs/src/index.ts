interface Env {
  JOBS: R2Bucket;
  RENDER_QUEUE: Queue<RenderMessage>;
  MODELSCOPE_TOKEN?: string;
  GATEWAY_ORIGIN?: string;
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
type RenderMessage = { jobId: string };

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

type RenderPayload = Partial<RenderOptions> & {
  imageBase64?: string;
  filename?: string;
  contentType?: string;
  kind?: RenderKind | string;
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MODEL_RENDER = "Qwen/Qwen-Image-Edit-2511";
const MODEL_VISION = "Qwen/Qwen2.5-VL-72B-Instruct";
const MODELSCOPE_BASE = "https://api-inference.modelscope.cn";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelScopeToken(env: Env): string {
  const token = env.MODELSCOPE_TOKEN?.trim();
  if (!token) throw new Error("modelscope_token_not_configured");
  return token;
}

function modelScopeHeaders(env: Env, asyncMode = false): Headers {
  const headers = new Headers({
    authorization: `Bearer ${modelScopeToken(env)}`,
    "content-type": "application/json",
  });
  if (asyncMode) headers.set("X-ModelScope-Async-Mode", "true");
  return headers;
}

function gatewayOrigin(env: Env): string {
  return (env.GATEWAY_ORIGIN || "https://manzel-h-cloud-jobs.kd-alsalhi.workers.dev").replace(/\/$/, "");
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeContentType(contentType: string | undefined, filename: string): string {
  const type = String(contentType || "").trim().toLowerCase();
  if (SUPPORTED_IMAGE_MIME_TYPES.has(type)) return type;
  const lower = filename.toLowerCase();
  if (/\.png$/.test(lower)) return "image/png";
  if (/\.webp$/.test(lower)) return "image/webp";
  if (/\.bmp$/.test(lower)) return "image/bmp";
  if (/\.tiff?$/.test(lower)) return "image/tiff";
  return "image/jpeg";
}

function normalizeOptionsFromPayload(payload: RenderPayload): RenderOptions {
  const floorsRaw = Number(payload.floors ?? 1);
  const floors = Number.isFinite(floorsRaw) ? Math.max(1, Math.min(4, Math.round(floorsRaw))) : 1;
  const furnishing = payload.furnishing === "none" ? "none" : payload.furnishing === "light" ? "light" : "full";
  const entrance = payload.entrance === "simple" ? "simple" : "formal";
  return {
    floors,
    furnishing,
    style: String(payload.style || "سعودي حديث"),
    garden: payload.garden !== false,
    parking: payload.parking !== false,
    fence: payload.fence !== false,
    entrance,
  };
}

function normalizeOptions(form: FormData): RenderOptions {
  return normalizeOptionsFromPayload({
    floors: Number(form.get("floors") || 1),
    furnishing: String(form.get("furnishing") || "full") as RenderOptions["furnishing"],
    style: String(form.get("style") || "سعودي حديث"),
    garden: String(form.get("garden") ?? "true") === "true",
    parking: String(form.get("parking") ?? "true") === "true",
    fence: String(form.get("fence") ?? "true") === "true",
    entrance: String(form.get("entrance") || "formal") as RenderOptions["entrance"],
  });
}

function architecturalPrompt(kind: RenderKind, options: RenderOptions): string {
  const floorRule = options.floors === 1
    ? "EXACTLY one storey. Keep a low horizontal single-storey villa silhouette with no upper floor."
    : `EXACTLY ${options.floors} storeys, no more and no fewer.`;

  const styleRules: Record<string, string> = {
    "سعودي حديث": "Contemporary Saudi villa, privacy-first facade, warm Riyadh/Najdi limestone, warm off-white plaster, dark bronze or wood accents, deep shade, climate-appropriate details.",
    "نجدي حديث": "Modern Najdi Saudi architecture, simple earth-toned masses, Najdi limestone, sand plaster, deep-set openings and restrained geometric privacy screens.",
    "حجازي حديث": "Modern Hijazi Saudi architecture with refined contemporary rawasheen-inspired screens, warm light stone, plaster, deep reveals and privacy.",
    "مودرن فاخر": "Restrained luxury contemporary villa, premium stone, warm plaster, bronze and wood accents, strong horizontal proportions and architectural lighting.",
  };

  const common = [
    "Use the supplied architectural floor plan as the authoritative geometry.",
    "Preserve footprint, proportions, room adjacency, circulation logic, wall positions, openings and orientation.",
    "Do not mirror, rotate, stretch, merge rooms, delete rooms or invent structural walls.",
    floorRule,
    styleRules[options.style] || `Architectural style: ${options.style}.`,
    "Saudi residential scale. Photorealistic professional architectural visualization. No text. No watermark.",
  ];

  if (kind === "interior") {
    const furnishing = options.furnishing === "none"
      ? "Completely unfurnished; architecture and finishes only."
      : options.furnishing === "light"
        ? "Light furnishing only; essential furniture with generous empty space."
        : "Fully furnished with coherent premium contemporary furniture.";
    return [...common,
      furnishing,
      "Transform the plan into a realistic isometric cutaway / dollhouse interior visualization.",
      "The original plan must remain traceable one-to-one in the result."
    ].join(" ");
  }

  const site = [
    options.garden ? "Include a landscaped Saudi-climate garden." : "No garden.",
    options.parking ? "Include clearly usable residential parking." : "No parking, garage or carport.",
    options.fence ? "Include a privacy boundary wall." : "No boundary wall.",
    options.entrance === "formal" ? "Use a prominent formal entrance." : "Use a simple understated entrance.",
  ].join(" ");

  return [...common,
    site,
    "Transform the plan into one straight-on eye-level photorealistic villa exterior.",
    "Keep straight verticals, realistic daylight and physically plausible materials.",
    "The requested storey count must be visually unmistakable."
  ].join(" ");
}

function decodeRenderPayload(payload: RenderPayload): {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  kind: RenderKind;
  options: RenderOptions;
} {
  if (!payload.imageBase64 || typeof payload.imageBase64 !== "string") {
    throw new Error("image_required");
  }
  const kind = String(payload.kind || "");
  if (kind !== "interior" && kind !== "exterior") throw new Error("invalid_kind");

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(payload.imageBase64);
  } catch {
    throw new Error("invalid_base64");
  }
  if (bytes.byteLength < 1000 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("invalid_image_size");
  }

  const filename = String(payload.filename || "floorplan.jpg");
  const contentType = normalizeContentType(payload.contentType, filename);
  return {
    bytes,
    filename,
    contentType,
    kind,
    options: normalizeOptionsFromPayload(payload),
  };
}

async function putTemporaryReference(
  bytes: Uint8Array,
  contentType: string,
  env: Env,
): Promise<{ id: string; key: string; url: string }> {
  const id = crypto.randomUUID();
  const key = `references/${id}`;
  await env.JOBS.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { expires: String(Date.now() + 15 * 60 * 1000) },
  });
  return { id, key, url: `${gatewayOrigin(env)}/references/${id}` };
}

async function fetchReference(id: string, env: Env): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
  const obj = await env.JOBS.get(`references/${id}`);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(obj.body, { headers });
}

type ModelScopeTask = {
  task_id?: string;
  task_status?: string;
  output_images?: Array<string | { url?: string }>;
  message?: string;
  error?: string;
};

async function modelScopeRender(
  bytes: Uint8Array,
  contentType: string,
  kind: RenderKind,
  options: RenderOptions,
  env: Env,
): Promise<{ image: Uint8Array; mime: string }> {
  const reference = await putTemporaryReference(bytes, contentType, env);
  try {
    const create = await fetch(`${MODELSCOPE_BASE}/v1/images/generations`, {
      method: "POST",
      headers: modelScopeHeaders(env, true),
      body: JSON.stringify({
        model: MODEL_RENDER,
        prompt: architecturalPrompt(kind, options),
        image_url: [reference.url],
      }),
    });

    if (!create.ok) {
      const detail = (await create.text()).slice(0, 500);
      throw new Error(`modelscope_create_${create.status}_${detail}`);
    }

    const created = await create.json() as ModelScopeTask;
    if (!created.task_id) throw new Error("modelscope_missing_task_id");

    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(7000);
      const status = await fetch(
        `${MODELSCOPE_BASE}/v1/tasks/${encodeURIComponent(created.task_id)}`,
        {
          headers: (() => {
            const h = modelScopeHeaders(env);
            h.set("X-ModelScope-Task-Type", "image_generation");
            return h;
          })(),
        },
      );

      if (!status.ok) {
        const detail = (await status.text()).slice(0, 500);
        throw new Error(`modelscope_status_${status.status}_${detail}`);
      }

      const task = await status.json() as ModelScopeTask;
      if (task.task_status === "FAILED") {
        throw new Error(`modelscope_failed_${task.message || task.error || "unknown"}`);
      }
      if (task.task_status !== "SUCCEED") continue;

      const first = task.output_images?.[0];
      const outputUrl = typeof first === "string" ? first : first?.url;
      if (!outputUrl) throw new Error("modelscope_missing_output_url");

      const output = await fetch(outputUrl);
      if (!output.ok) throw new Error(`modelscope_output_${output.status}`);
      const image = new Uint8Array(await output.arrayBuffer());
      if (image.byteLength < 10_000) throw new Error("modelscope_result_too_small");
      return {
        image,
        mime: output.headers.get("content-type") || "image/png",
      };
    }

    throw new Error("modelscope_render_timeout");
  } finally {
    await env.JOBS.delete(reference.key);
  }
}

async function modelScopeAnalyze(payload: RenderPayload, env: Env): Promise<unknown> {
  if (!payload.imageBase64) throw new Error("image_required");
  const bytes = base64ToBytes(payload.imageBase64);
  if (bytes.byteLength < 1000 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("invalid_image_size");
  }
  const filename = String(payload.filename || "floorplan.jpg");
  const contentType = normalizeContentType(payload.contentType, filename);
  const reference = await putTemporaryReference(bytes, contentType, env);

  try {
    const prompt = [
      "Analyze this architectural floor plan carefully.",
      "Return JSON only, no markdown.",
      "Extract: visible room names, dimension labels, likely doors, likely windows, stairs, columns, exterior boundary,",
      "and a concise description of room adjacency and circulation.",
      "Do not invent measurements that are not visible.",
      'Schema: {"rooms":[{"name":"","dimensions":[],"adjacent":[]}],"doors":[],"windows":[],"stairs":[],"columns":[],"notes":[]}',
    ].join(" ");

    const response = await fetch(`${MODELSCOPE_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: modelScopeHeaders(env),
      body: JSON.stringify({
        model: MODEL_VISION,
        temperature: 0.1,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: reference.url } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`modelscope_analyze_${response.status}_${detail}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || "";
    let parsed: unknown = null;
    try {
      const cleaned = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = null;
    }
    return {
      engine: "modelscope-qwen-vl-72b",
      model: MODEL_VISION,
      parsed,
      raw: content,
    };
  } finally {
    await env.JOBS.delete(reference.key);
  }
}

async function renderJson(request: Request, env: Env): Promise<Response> {
  let payload: RenderPayload;
  try {
    payload = await request.json() as RenderPayload;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  try {
    const decoded = decodeRenderPayload(payload);
    const result = await modelScopeRender(
      decoded.bytes,
      decoded.contentType,
      decoded.kind,
      decoded.options,
      env,
    );
    return json({
      imageBase64: bytesToBase64(result.image),
      mime: result.mime,
      engine: "modelscope-qwen-image-edit-2511",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status =
      message === "image_required" || message === "invalid_base64" || message === "invalid_kind" || message === "invalid_image_size"
        ? 400
        : message === "modelscope_token_not_configured"
          ? 503
          : 502;
    return json({ error: "render_failed", detail: message.slice(0, 600) }, status);
  }
}

async function analyzeJson(request: Request, env: Env): Promise<Response> {
  let payload: RenderPayload;
  try {
    payload = await request.json() as RenderPayload;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  try {
    return json(await modelScopeAnalyze(payload, env));
  } catch (error) {
    return json({
      error: "analyze_failed",
      detail: error instanceof Error ? error.message.slice(0, 600) : "unknown_error",
    }, 502);
  }
}

function isSupportedUpload(file: File): boolean {
  const type = normalizeContentType(file.type, file.name);
  return SUPPORTED_IMAGE_MIME_TYPES.has(type);
}

async function createJob(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  const kind = String(form.get("kind") || "");

  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (kind !== "interior" && kind !== "exterior") return json({ error: "invalid_kind" }, 400);
  if (!isSupportedUpload(file)) return json({ error: "image_required" }, 415);
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return json({ error: "invalid_file_size" }, 413);

  const id = crypto.randomUUID();
  const inputKey = `inputs/${id}/plan`;
  const createdAt = now();

  await env.JOBS.put(inputKey, file.stream(), {
    httpMetadata: { contentType: normalizeContentType(file.type, file.name) },
    customMetadata: { filename: file.name || "floorplan" },
  });

  const job: JobRecord = {
    id,
    kind,
    status: "queued",
    filename: file.name || "floorplan",
    contentType: normalizeContentType(file.type, file.name),
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
    const bytes = new Uint8Array(await input.arrayBuffer());

    const result = await modelScopeRender(bytes, job.contentType, job.kind, job.options, env);
    const outputKey = `outputs/${job.id}/${job.kind}.png`;
    await env.JOBS.put(outputKey, result.image, {
      httpMetadata: { contentType: result.mime },
    });

    job.status = "done";
    job.outputKey = outputKey;
    await writeJob(env, job);
    message.ack();
  } catch (error) {
    job.error = error instanceof Error ? error.message.slice(0, 500) : "unknown_error";
    if (job.attempts >= 2) {
      job.status = "failed";
      await writeJob(env, job);
      message.ack();
    } else {
      job.status = "queued";
      await writeJob(env, job);
      message.retry({ delaySeconds: 20 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        gateway: "cloudflare",
        provider: "modelscope-api-inference",
        renderModel: MODEL_RENDER,
        analysisModel: MODEL_VISION,
        configured: Boolean(env.MODELSCOPE_TOKEN?.trim()),
      });
    }

    if (request.method === "GET" && parts[0] === "references" && parts[1] && parts.length === 2) {
      return fetchReference(parts[1], env);
    }

    if (request.method === "POST" && url.pathname === "/render-json") {
      return renderJson(request, env);
    }

    if (request.method === "POST" && url.pathname === "/analyze-json") {
      return analyzeJson(request, env);
    }

    if (request.method === "POST" && url.pathname === "/jobs/render") {
      return createJob(request, env);
    }

    if (request.method === "GET" && parts[0] === "jobs" && parts[1] && parts.length === 2) {
      return getJob(parts[1], env);
    }

    if (request.method === "GET" && parts[0] === "jobs" && parts[1] && parts[2] === "result") {
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
