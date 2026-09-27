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
  outputKey?: string;
  options: RenderOptions;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type RenderMessage = { jobId: string };

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

function normalizeOptions(form: FormData): RenderOptions {
  const furnishing = String(form.get("furnishing") || "full");
  const entrance = String(form.get("entrance") || "formal");
  return {
    floors: Math.max(1, Math.min(4, Number(form.get("floors") || 1))),
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
  const kind = String(form.get("kind") || "");

  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (kind !== "interior" && kind !== "exterior") {
    return json({ error: "invalid_kind" }, 400);
  }
  if (file.size <= 0 || file.size > 18 * 1024 * 1024) {
    return json({ error: "invalid_file_size" }, 413);
  }

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


function architecturalPrompt(kind: RenderKind, options: RenderOptions): string {
  const common = [
    "The supplied reference images all represent the exact same architectural floor plan.",
    "Treat the floor plan as authoritative geometry.",
    "Preserve the outer footprint, wall positions, room adjacency, circulation, openings, proportions and orientation.",
    "Do not mirror, rotate, stretch, merge rooms, remove rooms, or invent structural walls.",
    "Create premium photorealistic Saudi residential architecture with realistic materials, physically plausible lighting, accurate scale, clean construction details, and no text or watermark.",
    `Architectural style: ${options.style}. Floor count: ${options.floors}.`,
  ];

  if (kind === "interior") {
    const furnishing =
      options.furnishing === "none"
        ? "unfurnished, architecture and finishes only"
        : options.furnishing === "light"
          ? "lightly furnished with essential high-end furniture"
          : "fully furnished with elegant premium contemporary furniture";

    return [
      ...common,
      "Generate a highly realistic isometric cutaway / dollhouse interior architectural visualization.",
      "The reference plan must remain visibly traceable one-to-one in the rendered result.",
      `Furnishing: ${furnishing}.`,
      "Use realistic stone, plaster, timber, glass, tile, fabric, daylight and indirect architectural lighting.",
      "Professional archviz quality, crisp details, natural shadows, coherent furniture scale.",
    ].join(" ");
  }

  return [
    ...common,
    "Generate a premium photorealistic exterior villa facade consistent with the exact footprint.",
    `Garden: ${options.garden}. Parking: ${options.parking}. Boundary fence: ${options.fence}. Entrance: ${options.entrance}.`,
    "Use a realistic eye-level architectural camera with straight verticals.",
    "Saudi-climate landscaping, premium natural stone, warm white plaster, wood, glass and metal.",
    "High-end real-estate architectural photography, natural sky, realistic daylight and subtle warm facade lighting.",
  ].join(" ");
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
  input: R2ObjectBody,
  job: JobRecord,
  env: Env,
): Promise<Uint8Array[]> {
  const form = new FormData();
  const bytes = await input.arrayBuffer();
  form.append("file", new File([bytes], job.filename, { type: job.contentType }));

  const base = env.RENDER_BACKEND_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/prepare-references`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 220);
    throw new Error(`prepare_references_${response.status}_${detail}`);
  }

  const data = await response.json() as { images?: string[] };
  const images = (data.images || []).slice(0, 4).map(base64ToBytes);
  if (!images.length) throw new Error("prepare_references_empty");
  return images;
}

async function renderWithWorkersAi(
  kind: RenderKind,
  references: Uint8Array[],
  options: RenderOptions,
  env: Env,
): Promise<Uint8Array> {
  const form = new FormData();
  references.forEach((bytes, index) => {
    form.append(
      `input_image_${index}`,
      new Blob([bytes], { type: "image/png" }),
      `plan-reference-${index}.png`,
    );
  });
  form.append("prompt", architecturalPrompt(kind, options));
  form.append("width", kind === "interior" ? "1536" : "1440");
  form.append("height", kind === "interior" ? "1536" : "1920");
  form.append("guidance", "4.5");

  const serialized = new Response(form);
  const contentType = serialized.headers.get("content-type");
  if (!serialized.body || !contentType) throw new Error("multipart_serialization_failed");

  const result = await env.AI.run("@cf/black-forest-labs/flux-2-klein-9b", {
    multipart: {
      body: serialized.body,
      contentType,
    },
  });

  return bytesFromAiResult(result);
}

async function processJob(message: Message<RenderMessage>, env: Env): Promise<void> {
  const id = message.body.jobId;
  const job = await readJob(env, id);
  if (!job || job.status === "done") {
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

    const references = await prepareReferences(input, job, env);
    const image = await renderWithWorkersAi(job.kind, references, job.options, env);
    if (image.byteLength < 10_000) throw new Error("result_too_small");

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
      return json({ ok: true, mode: "queue-r2", backend: env.RENDER_BACKEND_URL });
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
