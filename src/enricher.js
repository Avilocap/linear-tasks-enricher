import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createEmitter } from "./activity-emitter.js";
import {
  updateIssueDescription,
  getIssue,
  fetchWithAuth,
} from "./linear-client.js";

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(import.meta.dirname, "..");
const MEDIA_DIR = path.join(PROJECT_ROOT, ".tmp-media");
const IMAGES_DIR = path.join(MEDIA_DIR, "images");
const VIDEO_DIR = path.join(MEDIA_DIR, "video");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const REPOS = ["z2-backend", "z2-frontend"];

const ENRICHING_BANNER = `> ⏳ **Enriqueciendo tarea…** El análisis técnico se está generando automáticamente.\n\n---\n\n`;

const PLAN_STEPS = [
  { content: "Obtener datos de la tarea", status: "pending" },
  { content: "Actualizar repositorios locales", status: "pending" },
  { content: "Procesar vídeos y transcribir audio", status: "pending" },
  { content: "Descargar imágenes adjuntas", status: "pending" },
  { content: "Analizar tarea con Claude", status: "pending" },
  { content: "Actualizar descripción en Linear", status: "pending" },
];

/**
 * Entry point for Enrique agent sessions (called from server.js).
 */
export async function handleEnriqueSession(sessionId, issueId, webhookData) {
  const emit = createEmitter("enrique", sessionId);

  // First activity must be emitted within 10 sec
  await emit.thought("Sesión recibida. Preparando pipeline de enriquecimiento…");
  await emit.updatePlan(PLAN_STEPS);

  try {
    // Step 0: Fetch issue data
    updatePlanStep(emit, 0, "inProgress");
    await emit.action("getIssue", issueId);

    const issue = await getIssue("enrique", issueId);
    if (!issue) {
      await emit.error(`No se encontró la tarea con ID ${issueId}`);
      return;
    }

    // Skip if issue is already completed or canceled
    const stateType = issue.state?.type;
    if (stateType === "completed" || stateType === "canceled") {
      console.log(`[ENRIQUE] Skipping ${issue.identifier} — state is ${stateType}`);
      await emit.response(`Tarea ${issue.identifier} ya está ${stateType === "completed" ? "completada" : "cancelada"}. No hay nada que hacer.`);
      return;
    }

    const task = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || "",
      priority: issue.priority,
      labels: issue.labels?.nodes?.map((l) => l.name) || [],
      teamName: issue.team?.name || "",
      teamKey: issue.team?.key || "",
      url: issue.url || "",
    };

    updatePlanStep(emit, 0, "completed");
    await emit.thought(`Tarea: ${task.identifier} — ${task.title}`);

    // Run the enrichment pipeline
    await enrichTask(task, emit);

    await emit.response(`Enriquecimiento completado para ${task.identifier}.`);
  } catch (err) {
    console.error(`[ENRIQUE] Pipeline error:`, err.message);
    await emit.error(`Error en el pipeline: ${err.message}`);
  }
}

/**
 * Main enrichment pipeline.
 * @param {object} task - Task data
 * @param {object} [emit] - Optional activity emitter (null for manual runs)
 */
export async function enrichTask(task, emit) {
  // Step 0: Mark the task as "enriching" in Linear
  try {
    const bannerDescription = ENRICHING_BANNER + (task.description || "");
    await updateIssueDescription("enrique", task.id, bannerDescription);
    console.log(`[ENRICH] Marked ${task.identifier} as enriching`);
  } catch (err) {
    console.warn(`[ENRICH] Failed to set enriching banner: ${err.message}`);
  }

  // Step 1: Pull latest code
  if (emit) updatePlanStep(emit, 1, "inProgress");
  if (emit) await emit.action("pullRepos", REPOS.join(", "));

  try {
    await pullRepos();
  } catch (err) {
    console.warn(`[GIT] Pull failed (continuing anyway): ${err.message}`);
  }

  if (emit) updatePlanStep(emit, 1, "completed");

  // Step 2: Detect videos first (so we can exclude them from image extraction)
  if (emit) updatePlanStep(emit, 2, "inProgress");

  const videoUrls = extractVideoUrls(task.description);
  let transcriptionPaths = [];

  if (videoUrls.length > 0) {
    if (emit) await emit.thought(`Encontrados ${videoUrls.length} vídeo(s). Transcribiendo…`);
    transcriptionPaths = await processVideos(task.description, task.identifier);
    if (emit) await emit.action("processVideos", `${videoUrls.length} vídeo(s)`, `${transcriptionPaths.length} transcripción(es)`);
  }

  if (emit) updatePlanStep(emit, 2, "completed");

  // Step 3: Download images (excluding video URLs)
  if (emit) updatePlanStep(emit, 3, "inProgress");

  const imageUrls = extractImageUrls(task.description, videoUrls);
  let imagePaths = [];

  if (imageUrls.length > 0) {
    console.log(`[IMAGES] Found ${imageUrls.length} image(s) in ${task.identifier}`);
    if (emit) await emit.thought(`Descargando ${imageUrls.length} imagen(es)…`);
    imagePaths = await downloadImages(imageUrls, task.identifier);
    if (emit) await emit.action("downloadImages", `${imageUrls.length} imagen(es)`, `${imagePaths.length} descargada(s)`);
  }

  if (emit) updatePlanStep(emit, 3, "completed");

  // Step 4: Run Claude to analyze the task
  if (emit) updatePlanStep(emit, 4, "inProgress");
  if (emit) await emit.thought("Ejecutando Claude para análisis técnico…");

  try {
    const analysis = await runClaude(task, imagePaths, transcriptionPaths);
    if (emit) await emit.action("runClaude", task.identifier, `Análisis generado (${analysis.length} caracteres)`);

    if (emit) updatePlanStep(emit, 4, "completed");

    // Step 5: Update the issue description with the analysis
    if (emit) updatePlanStep(emit, 5, "inProgress");

    const updatedDescription = (task.description || "") + "\n\n" + analysis;
    await updateIssueDescription("enrique", task.id, updatedDescription);
    console.log(`[ENRICH] Updated description for ${task.identifier}`);

    if (emit) await emit.action("updateIssueDescription", task.id, "Descripción actualizada");
    if (emit) updatePlanStep(emit, 5, "completed");
  } finally {
    await cleanupMedia(task.identifier);
  }
}

/**
 * Fetch a task from Linear by identifier and enrich it.
 */
export async function enrichTaskByIdentifier(identifier) {
  console.log(`[MANUAL] Fetching ${identifier} from Linear...`);

  const fetchPrompt = `Busca en el codebase información relevante para la tarea "${identifier}". Devuelve SOLO un JSON con este formato exacto, sin markdown ni texto adicional:
{"id":"...","identifier":"...","title":"...","description":"...","priority":0,"labels":[],"teamName":"..."}`;

  // For manual use, we still try to fetch via the linear-client
  // This requires the enricher to have a valid token
  try {
    // Use linear-client graphql to search by identifier
    const { graphql } = await import("./linear-client.js");
    const data = await graphql("enrique", `
      query($filter: IssueFilter) {
        issues(filter: $filter, first: 1) {
          nodes {
            id identifier title description priority url
            team { name key }
            labels { nodes { name } }
          }
        }
      }
    `, {
      filter: { identifier: { eq: identifier } },
    });

    const issue = data.issues?.nodes?.[0];
    if (!issue) {
      throw new Error(`Issue ${identifier} not found`);
    }

    const task = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || "",
      priority: issue.priority,
      labels: issue.labels?.nodes?.map((l) => l.name) || [],
      teamName: issue.team?.name || "",
      teamKey: issue.team?.key || "",
      url: issue.url || "",
    };

    console.log(`[MANUAL] Fetched ${task.identifier}: ${task.title}`);
    return enrichTask(task);
  } catch (err) {
    throw new Error(`Failed to fetch ${identifier}: ${err.message}`);
  }
}

// ─── Helper: update a single plan step ──────────────────────────────────

function updatePlanStep(emit, index, status) {
  const steps = PLAN_STEPS.map((step, i) => ({
    ...step,
    status: i < index ? "completed" : i === index ? status : step.status,
  }));
  emit.updatePlan(steps);
}

// ─── Media processing (unchanged) ──────────────────────────────────────

function extractImageUrls(text, videoUrls = []) {
  if (!text) return [];
  const urls = [];
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    urls.push(match[1]);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi)) {
    if (!urls.includes(match[0])) urls.push(match[0]);
  }
  for (const match of text.matchAll(/(https?:\/\/uploads\.linear\.app\/[^\s)]+)/g)) {
    if (!urls.includes(match[0])) urls.push(match[0]);
  }
  return urls.filter((u) => !videoUrls.includes(u));
}

async function downloadImages(urls, taskIdentifier) {
  if (urls.length === 0) return [];

  const taskDir = path.join(IMAGES_DIR, taskIdentifier);
  await fs.mkdir(taskDir, { recursive: true });

  const paths = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      console.log(`[IMAGES] Downloading image ${i + 1}/${urls.length}: ${url.slice(0, 80)}...`);
      const res = await fetchWithAuth("enrique", url);
      if (!res.ok) {
        console.warn(`[IMAGES] Failed to download ${url}: ${res.status}`);
        continue;
      }

      const contentType = res.headers.get("content-type") || "";
      const ext = contentType.includes("png") ? ".png"
        : contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg"
        : contentType.includes("gif") ? ".gif"
        : contentType.includes("webp") ? ".webp"
        : contentType.includes("svg") ? ".svg"
        : ".png";

      const filePath = path.join(taskDir, `image-${i + 1}${ext}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(filePath, buffer);
      paths.push(filePath);
      console.log(`[IMAGES] Saved: ${filePath}`);
    } catch (err) {
      console.warn(`[IMAGES] Error downloading ${url}: ${err.message}`);
    }
  }

  return paths;
}

async function cleanupImages(taskIdentifier) {
  const taskDir = path.join(IMAGES_DIR, taskIdentifier);
  try {
    await fs.rm(taskDir, { recursive: true, force: true });
  } catch {}
}

const VIDEO_EXTENSIONS = /\.(?:mp4|mov|webm|avi|mkv)/i;
const VIDEO_CONTENT_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/avi"];

function extractVideoUrls(text) {
  if (!text) return [];
  const urls = [];
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const linkText = match[1];
    const linkUrl = match[2];
    if (VIDEO_EXTENSIONS.test(linkText) || VIDEO_EXTENSIONS.test(linkUrl)) {
      if (!urls.includes(linkUrl)) urls.push(linkUrl);
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)]+\.(?:mp4|mov|webm|avi|mkv)/gi)) {
    if (!urls.includes(match[0])) urls.push(match[0]);
  }
  for (const match of text.matchAll(/(https?:\/\/uploads\.linear\.app\/[^\s)]*video[^\s)]*)/gi)) {
    if (!urls.includes(match[0])) urls.push(match[0]);
  }
  return urls;
}

async function transcribeVideo(url, taskIdentifier, index) {
  const taskDir = path.join(VIDEO_DIR, taskIdentifier);
  await fs.mkdir(taskDir, { recursive: true });

  const videoPath = path.join(taskDir, `video-${index}.mp4`);
  const audioPath = path.join(taskDir, `audio-${index}.mp3`);

  console.log(`[VIDEO] Downloading video ${index}: ${url.slice(0, 80)}...`);
  const res = await fetchWithAuth("enrique", url);
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.log(`[VIDEO] Failed to download: ${res.status} ${res.statusText}`);
    console.log(`[VIDEO] Response body: ${errBody.slice(0, 500)}`);
    return null;
  }

  const contentType = res.headers.get("content-type") || "";
  const isVideo = VIDEO_CONTENT_TYPES.some((t) => contentType.includes(t))
    || VIDEO_EXTENSIONS.test(url);

  if (!isVideo && !contentType.includes("octet-stream")) {
    console.log(`[VIDEO] URL is not a video (content-type: ${contentType}), skipping`);
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(videoPath, buffer);
  console.log(`[VIDEO] Saved: ${videoPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);

  console.log(`[VIDEO] Extracting audio...`);
  const ffmpegResult = await exec("ffmpeg", [
    "-i", videoPath,
    "-vn",
    "-acodec", "libmp3lame",
    "-q:a", "4",
    "-y",
    audioPath,
  ], { timeout: 120_000 });

  if (ffmpegResult.exitCode !== 0) {
    console.warn(`[VIDEO] ffmpeg failed: ${ffmpegResult.stderr.slice(0, 200)}`);
    return null;
  }

  try {
    const audioStat = await fs.stat(audioPath);
    if (audioStat.size < 1000) {
      console.log(`[VIDEO] Audio too small (${audioStat.size}B), video may have no audio track`);
      return null;
    }
    console.log(`[VIDEO] Audio extracted: ${(audioStat.size / 1024).toFixed(0)}KB`);
  } catch {
    console.warn(`[VIDEO] No audio file produced`);
    return null;
  }

  if (!OPENAI_API_KEY) {
    console.warn(`[VIDEO] OPENAI_API_KEY not set, skipping transcription`);
    return null;
  }

  console.log(`[VIDEO] Transcribing with Whisper...`);
  const audioBuffer = await fs.readFile(audioPath);
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), "audio.mp3");
  formData.append("model", "whisper-1");
  formData.append("language", "es");

  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  if (!whisperRes.ok) {
    const err = await whisperRes.text();
    console.warn(`[VIDEO] Whisper API error: ${whisperRes.status} ${err.slice(0, 200)}`);
    return null;
  }

  const { text } = await whisperRes.json();
  console.log(`[VIDEO] Transcription: ${text.slice(0, 100)}...`);

  const transcriptPath = path.join(taskDir, `transcription-${index}.txt`);
  await fs.writeFile(transcriptPath, text, "utf-8");
  console.log(`[VIDEO] Transcription saved: ${transcriptPath}`);
  return transcriptPath;
}

async function processVideos(description, taskIdentifier) {
  const videoUrls = extractVideoUrls(description);
  if (videoUrls.length === 0) return [];

  console.log(`[VIDEO] Found ${videoUrls.length} video(s) in ${taskIdentifier}`);
  const transcriptionPaths = [];

  for (let i = 0; i < videoUrls.length; i++) {
    try {
      const filePath = await transcribeVideo(videoUrls[i], taskIdentifier, i + 1);
      if (filePath) transcriptionPaths.push(filePath);
    } catch (err) {
      console.warn(`[VIDEO] Error processing video ${i + 1}: ${err.message}`);
    }
  }

  return transcriptionPaths;
}

async function cleanupMedia(taskIdentifier) {
  for (const dir of [IMAGES_DIR, VIDEO_DIR]) {
    const taskDir = path.join(dir, taskIdentifier);
    try {
      await fs.rm(taskDir, { recursive: true, force: true });
    } catch {}
  }
}

// ─── Claude invocation (updated: no MCP tools, returns analysis as stdout) ──

function buildPrompt(task, imagePaths = [], transcriptionPaths = []) {
  return `Eres un asistente de ingeniería que enriquece tareas de Linear con contexto técnico. Responde siempre en español.

Se ha creado una nueva tarea:

- **Identificador**: ${task.identifier}
- **Título**: ${task.title}
- **Descripción**: ${task.description || "(sin descripción)"}
- **Prioridad**: ${task.priority}
- **Etiquetas**: ${task.labels.join(", ") || "(ninguna)"}
- **Equipo**: ${task.teamName}

Tu trabajo:

1. Analiza el codebase y produce un enriquecimiento técnico que incluya:
   - **Enfoque de implementación**: Un enfoque paso a paso sugerido para implementar la tarea.
   - **Contexto técnico**: Patrones de arquitectura, dependencias o utilidades existentes que el desarrollador debería conocer.
   - **Estimación de complejidad**: Baja / Media / Alta con justificación.
   - **Criterios de aceptación**: Genera criterios de aceptación detallados divididos en tres categorías:
     - **Funcionalidad**: Comportamiento esperado paso a paso, incluyendo casos edge, validaciones, endpoints involucrados, y qué debe ocurrir en caso de éxito y error.
     - **UX**: Aspectos de experiencia de usuario como flujos de confirmación, información contextual, internacionalización, estados de carga, y feedback visual.
     - **Técnico**: Requisitos técnicos como ausencia de errores de tipado, patrones del proyecto a seguir, hooks o utilidades a reutilizar, y convenciones del codebase.

2. Devuelve tu análisis como salida estándar (stdout) usando este formato exacto en Markdown:

---

## Análisis Técnico (auto-generado)

### Archivos Relevantes
(lista de archivos)

### Enfoque de Implementación
(paso a paso)

### Contexto Técnico
(notas)

### Complejidad
(estimación)

### Criterios de Aceptación

#### Funcionalidad
- [ ] (criterio 1)
- [ ] (criterio 2)
...

#### UX
- [ ] (criterio 1)
- [ ] (criterio 2)
...

#### Técnico
- [ ] (criterio 1)
- [ ] (criterio 2)
...

---

Importante:
- Sé específico — referencia rutas de archivos y nombres de funciones reales del codebase.
- Mantén el análisis conciso y accionable.
- NO modifiques ningún archivo del codebase. Solo lee y analiza.
- NO uses herramientas de Linear. Simplemente devuelve el análisis como texto.
- Escribe TODO el análisis en español.
- Los criterios de aceptación deben ser específicos al codebase real (nombres de hooks, componentes, endpoints, archivos de traducción, etc.), no genéricos.${imagePaths.length > 0 ? `

La tarea incluye ${imagePaths.length} imagen(es) adjunta(s). Léelas con la herramienta Read para entender el contexto visual (capturas de pantalla, mockups, errores, etc.):
${imagePaths.map((p) => `- ${p}`).join("\n")}

Incorpora lo que observes en las imágenes a tu análisis.` : ""}${transcriptionPaths.length > 0 ? `

La tarea incluye ${transcriptionPaths.length} vídeo(s) con audio. Las transcripciones están guardadas en archivos. Léelas con la herramienta Read para entender el contexto:
${transcriptionPaths.map((p) => `- ${p}`).join("\n")}

Incorpora el contenido de las transcripciones a tu análisis.` : ""}`;
}

async function runClaude(task, imagePaths = [], transcriptionPaths = []) {
  const prompt = buildPrompt(task, imagePaths, transcriptionPaths);

  const allowedTools = [
    "Read",
    "Glob",
    "Grep",
    "Task",
  ].join(",");

  const args = [
    "-p",
    prompt,
    "--model",
    "sonnet",
    "--allowedTools",
    allowedTools,
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    "2.00",
  ];

  console.log(`[CLAUDE] Spawning Claude for ${task.identifier}...`);

  const result = await exec("claude", args, {
    cwd: PROJECT_ROOT,
    timeout: 5 * 60 * 1000,
  });

  console.log(`[CLAUDE] Output for ${task.identifier}:\n${result.stdout.slice(0, 500)}`);

  if (result.exitCode !== 0) {
    throw new Error(`Claude exited with code ${result.exitCode}: ${result.stderr}`);
  }

  return result.stdout;
}

// ─── Git helpers ────────────────────────────────────────────────────────

async function pullRepos() {
  for (const repo of REPOS) {
    const repoPath = path.join(PROJECT_ROOT, repo);
    console.log(`[GIT] Pulling ${repo}...`);
    await exec("git", ["-C", repoPath, "pull", "--ff-only"]);
    console.log(`[GIT] ${repo} up to date`);
  }
}

// ─── Exec helper ────────────────────────────────────────────────────────

function exec(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      timeout: options.timeout || 120_000,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
