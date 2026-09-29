interface Env {
  JOBS: R2Bucket;
  RENDER_QUEUE: Queue<RenderMessage>;
  RENDER_BACKEND_URL: string;
  AI: Ai;
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
  referenceKey?: string;
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

  const filename = file.name.trim().toLowerCase();
  return /\.(pdf|png|jpe?g|webp|bmp|tiff?)$/.test(filename);
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

async function createJob(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  const reference = form.get("reference");
  const kind = String(form.get("kind") || "");

  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (kind !== "interior" && kind !== "exterior") {
    return json({ error: "invalid_kind" }, 400);
  }
  if (!isSupportedUpload(file)) {
    return json({ error: "unsupported_file_type" }, 415);
  }
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    return json({ error: "invalid_file_size" }, 413);
  }

  const id = crypto.randomUUID();
  const inputKey = `inputs/${id}/plan`;
  const createdAt = now();

  await env.JOBS.put(inputKey, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { filename: file.name || "floorplan" },
  });

  let referenceKey: string | undefined;
  if (
    reference instanceof File &&
    reference.size > 0 &&
    reference.size <= 2 * 1024 * 1024 &&
    reference.type.trim().toLowerCase() === "image/png"
  ) {
    referenceKey = `inputs/${id}/reference.png`;
    await env.JOBS.put(referenceKey, reference.stream(), {
      httpMetadata: { contentType: "image/png" },
    });
  }

  const job: JobRecord = {
    id,
    kind,
    status: "queued",
    filename: file.name || "floorplan",
    contentType: file.type || "application/octet-stream",
    inputKey,
    referenceKey,
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


function architecturalPrompt(kind: RenderKind, options: RenderOptions): string {
  const floorRule =
    options.floors === 1
      ? "MANDATORY MASSING: EXACTLY ONE STOREY / GROUND FLOOR ONLY. The entire building must have one habitable level only. No first floor, no second floor, no upper balconies, no stacked windows, no double-height facade that looks like another storey. Use a low horizontal single-storey villa silhouette."
      : `MANDATORY MASSING: EXACTLY ${options.floors} STOREYS, no more and no fewer. Clearly show exactly ${options.floors} habitable levels in the architecture.`;

  const styleRules: Record<string, string> = {
    "سعودي حديث": "MANDATORY STYLE: contemporary Saudi villa. Saudi/Gulf residential proportions; privacy-first facade; restrained openings; shaded recessed entrance; warm Riyadh/Najdi limestone or local beige stone; warm off-white stucco; subtle dark bronze or wood accents; deep shade; climate-appropriate details. Avoid European, Mediterranean, American, tropical, Moroccan, neoclassical, ornate palace, generic international-box, and all-glass styles.",
    "نجدي حديث": "MANDATORY STYLE: modern Najdi Saudi architecture. Strong simple earth-toned masses, Riyadh/Najdi limestone and warm sand plaster, deep-set openings, privacy screens inspired by Najdi geometry, shaded entrance, contemporary interpretation without historic ornament overload.",
    "حجازي حديث": "MANDATORY STYLE: modern Hijazi Saudi architecture. Contemporary western-Saudi villa with shaded openings, refined modern rawasheen-inspired screens, warm light stone and plaster, privacy, deep reveals and climate-responsive facade. No Ottoman or Moroccan pastiche.",
    "مودرن فاخر": "MANDATORY STYLE: restrained luxury contemporary villa, premium stone, warm plaster, bronze/wood accents, strong horizontal proportions, architectural lighting, no classical ornament.",
  };
  const styleRule = styleRules[options.style] || `MANDATORY STYLE: ${options.style}. Follow this selected style literally and do not substitute another architectural style.`;

  const common = [
    "HARD CONSTRAINTS OVERRIDE BEAUTIFICATION. Never violate the requested storey count or selected architectural style.",
    floorRule,
    styleRule,
    "The supplied reference images all represent the exact same authoritative floor plan.",
    "Preserve footprint, wall layout, room adjacency, circulation, openings, proportions and orientation.",
    "Do not mirror, rotate, stretch, merge rooms, remove rooms, or invent structural walls.",
    "Photorealistic professional architectural visualization, physically plausible materials and lighting, accurate scale, no text, no watermark.",
  ];

  if (kind === "interior") {
    const furnishing =
      options.furnishing === "none"
        ? "MANDATORY FURNISHING: completely unfurnished; architecture and finishes only."
        : options.furnishing === "light"
          ? "MANDATORY FURNISHING: lightly furnished; only essential furniture, generous empty space."
          : "MANDATORY FURNISHING: fully furnished with coherent premium contemporary furniture.";

    return [
      ...common,
      furnishing,
      "Generate a realistic isometric cutaway / dollhouse interior visualization.",
      "The plan must remain traceable one-to-one in the result.",
      "Do not add another floor above the selected floor count.",
    ].join(" ");
  }

  const site = [
    options.garden ? "Include a landscaped Saudi-climate garden." : "NO GARDEN or decorative planted yard.",
    options.parking ? "Include clearly usable residential parking." : "NO parking bay, garage, carport or driveway emphasis.",
    options.fence ? "Include a privacy boundary wall/fence." : "NO boundary wall or fence.",
    options.entrance === "formal" ? "Use a prominent formal entrance." : "Use a simple understated entrance.",
  ].join(" ");

  return [
    ...common,
    "Generate one straight-on eye-level photorealistic exterior villa facade.",
    site,
    "The visible massing must make the requested storey count unmistakable.",
    options.floors === 1 ? "Keep the roofline low and horizontal. One row of normal-height facade openings only." : "",
    "Saudi climate, realistic daylight, straight verticals, high-end real-estate archviz.",
  ].filter(Boolean).join(" ");
}
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesFromAiResult(result: unknown): Uint8Array {
  if (result && typeof result === "object" && "image" in result) {
    const image = (result as { image?: unknown }).image;
    if (typeof image === "string" && image.length > 100) return base64ToBytes(image);
  }

  throw new Error("workers_ai_invalid_image_response");
}

async function prepareReferences(
  bytes: ArrayBuffer,
  job: JobRecord,
  env: Env,
): Promise<Uint8Array[]> {
  const form = new FormData();
  form.append("file", new File([bytes], job.filename, { type: job.contentType }));

  const base = env.RENDER_BACKEND_URL.replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  let response: Response;
  try {
    response = await fetch(`${base}/prepare-references`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("prepare_references_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 220);
    throw new Error(`prepare_references_${response.status}_${detail}`);
  }

  const data = await response.json() as { images?: string[] };
  const images = (data.images || []).slice(0, 4).map(base64ToBytes);
  if (!images.length) throw new Error("prepare_references_empty");
  return images;
}

async function loadReferences(
  inputBytes: ArrayBuffer,
  job: JobRecord,
  env: Env,
): Promise<Uint8Array[]> {
  if (job.referenceKey) {
    const reference = await env.JOBS.get(job.referenceKey);
    if (reference) {
      const bytes = new Uint8Array(await reference.arrayBuffer());
      if (bytes.byteLength > 1_000) return [bytes];
    }
  }

  return await prepareReferences(inputBytes, job, env);
}

async function renderViaBackend(
  inputBytes: ArrayBuffer,
  job: JobRecord,
  env: Env,
): Promise<Uint8Array> {
  const form = new FormData();
  form.append("file", new File([inputBytes], job.filename, { type: job.contentType }));
  form.append("floors", String(job.options.floors));
  form.append("furnishing", job.options.furnishing);
  form.append("style", job.options.style);
  form.append("garden", String(job.options.garden));
  form.append("parking", String(job.options.parking));
  form.append("fence", String(job.options.fence));
  form.append("entrance", job.options.entrance);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  try {
    const base = env.RENDER_BACKEND_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/render-plan/${job.kind}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 220);
      throw new Error(`backend_render_${response.status}_${detail}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 10_000) throw new Error("backend_result_too_small");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("backend_render_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runFluxKlein(
  kind: RenderKind,
  references: Uint8Array[],
  options: RenderOptions,
  env: Env,
): Promise<Uint8Array> {
  const form = new FormData();
  references.slice(0, 4).forEach((bytes, index) => {
    form.append(
      `input_image_${index}`,
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/png" }),
      `plan-reference-${index}.png`,
    );
  });
  form.append("prompt", architecturalPrompt(kind, options));
  form.append("width", "1024");
  form.append("height", kind === "interior" ? "1024" : "1344");
  form.append("guidance", "4.5");

  const serialized = new Response(form);
  const contentType = serialized.headers.get("content-type");
  if (!serialized.body || !contentType) throw new Error("multipart_serialization_failed");

  const result = await env.AI.run("@cf/black-forest-labs/flux-2-klein-4b", {
    multipart: {
      body: serialized.body,
      contentType,
    },
  });
  return bytesFromAiResult(result);
}

async function runFluxSchnell(
  kind: RenderKind,
  options: RenderOptions,
  env: Env,
): Promise<Uint8Array> {
  const result = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
    prompt: architecturalPrompt(kind, options),
    width: 1024,
    height: kind === "interior" ? 1024 : 1344,
    steps: 4,
  });
  return bytesFromAiResult(result);
}

async function renderWithWorkersAi(
  kind: RenderKind,
  references: Uint8Array[],
  options: RenderOptions,
  env: Env,
): Promise<Uint8Array> {
  try {
    return await runFluxKlein(kind, references, options, env);
  } catch (primaryError) {
    try {
      return await runFluxSchnell(kind, options, env);
    } catch (emergencyError) {
      const primary = primaryError instanceof Error ? primaryError.message : "klein_unknown";
      const emergency = emergencyError instanceof Error ? emergencyError.message : "schnell_unknown";
      throw new Error(`workers_ai_unavailable: ${primary}; ${emergency}`);
    }
  }
}

async function renderDirect(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const reference = form.get("reference");
  const kind = String(form.get("kind") || "");

  if (!(reference instanceof File)) return json({ error: "reference_required" }, 400);
  if (kind !== "interior" && kind !== "exterior") return json({ error: "invalid_kind" }, 400);
  if (reference.size <= 1_000 || reference.size > 2 * 1024 * 1024) {
    return json({ error: "invalid_reference_size" }, 413);
  }
  if (reference.type.trim().toLowerCase() !== "image/png") {
    return json({ error: "reference_must_be_png" }, 415);
  }

  const bytes = new Uint8Array(await reference.arrayBuffer());
  const image = await renderWithWorkersAi(kind, [bytes], normalizeOptions(form), env);
  if (image.byteLength < 10_000) return json({ error: "result_too_small" }, 502);

  return new Response(image, {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
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
    const inputBytes = await input.arrayBuffer();

    let image: Uint8Array;
    try {
      const references = await loadReferences(inputBytes, job, env);
      image = await renderWithWorkersAi(job.kind, references, job.options, env);
      if (image.byteLength < 10_000) throw new Error("result_too_small");
    } catch (primaryError) {
      try {
        image = await renderViaBackend(inputBytes, job, env);
      } catch (fallbackError) {
        const primary = primaryError instanceof Error ? primaryError.message : "primary_unknown";
        const fallback = fallbackError instanceof Error ? fallbackError.message : "fallback_unknown";
        throw new Error(`all_render_paths_failed: ${primary}; ${fallback}`);
      }
    }

    const outputKey = `outputs/${job.id}/${job.kind}.png`;
    await env.JOBS.put(outputKey, image, {
      httpMetadata: { contentType: "image/png" },
    });

    job.status = "done";
    job.outputKey = outputKey;
    job.error = undefined;
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
      message.retry({ delaySeconds: Math.min(60, 5 * job.attempts) });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, mode: "cloudflare-direct", primary: "flux-2-klein-4b", emergency: "flux-1-schnell" });
    }

    if (request.method === "POST" && url.pathname === "/render") {
      try {
        return await renderDirect(request, env);
      } catch (error) {
        return json({
          error: "render_failed",
          detail: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
        }, 503);
      }
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
