import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(import.meta.dirname, "..");
const IMAGES_DIR = path.join(PROJECT_ROOT, ".tmp-images");

const REPOS = ["z2-backend", "z2-frontend"];

/**
 * Run git pull on all configured repos.
 */
async function pullRepos() {
  for (const repo of REPOS) {
    const repoPath = path.join(PROJECT_ROOT, repo);
    console.log(`[GIT] Pulling ${repo}...`);
    await exec("git", ["-C", repoPath, "pull", "--ff-only"]);
    console.log(`[GIT] ${repo} up to date`);
  }
}

/**
 * Extract image URLs from markdown text.
 */
function extractImageUrls(text) {
  if (!text) return [];
  const urls = [];
  // Markdown images: ![alt](url)
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    urls.push(match[1]);
  }
  // Raw URLs ending in image extensions
  for (const match of text.matchAll(/https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi)) {
    if (!urls.includes(match[0])) urls.push(match[0]);
  }
  // Linear upload URLs (may not have extension)
  for (const match of text.matchAll(/(https?:\/\/uploads\.linear\.app\/[^\s)]+)/g)) {
    if (!urls.includes(match[0])) urls.push(match[0]);
  }
  return urls;
}

/**
 * Download images from URLs to local temp directory.
 * Returns array of local file paths.
 */
async function downloadImages(urls, taskIdentifier) {
  if (urls.length === 0) return [];

  const taskDir = path.join(IMAGES_DIR, taskIdentifier);
  await fs.mkdir(taskDir, { recursive: true });

  const paths = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      console.log(`[IMAGES] Downloading image ${i + 1}/${urls.length}: ${url.slice(0, 80)}...`);
      const res = await fetch(url);
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

/**
 * Clean up downloaded images for a task.
 */
async function cleanupImages(taskIdentifier) {
  const taskDir = path.join(IMAGES_DIR, taskIdentifier);
  try {
    await fs.rm(taskDir, { recursive: true, force: true });
  } catch {}
}

/**
 * Build the prompt that Claude will use to analyze the task and update it.
 */
function buildPrompt(task, imagePaths = []) {
  return `Eres un asistente de ingeniería que enriquece tareas de Linear con contexto técnico. Responde siempre en español.

Se ha creado una nueva tarea:

- **Identificador**: ${task.identifier}
- **Título**: ${task.title}
- **Descripción**: ${task.description || "(sin descripción)"}
- **Prioridad**: ${task.priority}
- **Etiquetas**: ${task.labels.join(", ") || "(ninguna)"}
- **Equipo**: ${task.teamName}

Tu trabajo:

1. Analiza los codebases en este directorio (z2-backend y z2-frontend) para entender qué partes del código son relevantes para esta tarea.
2. Produce un enriquecimiento técnico que incluya:
   - **Enfoque de implementación**: Un enfoque paso a paso sugerido para implementar la tarea.
   - **Contexto técnico**: Patrones de arquitectura, dependencias o utilidades existentes que el desarrollador debería conocer.
   - **Estimación de complejidad**: Baja / Media / Alta con justificación.
   - **Criterios de aceptación**: Genera criterios de aceptación detallados divididos en tres categorías:
     - **Funcionalidad**: Comportamiento esperado paso a paso, incluyendo casos edge, validaciones, endpoints involucrados, y qué debe ocurrir en caso de éxito y error.
     - **UX**: Aspectos de experiencia de usuario como flujos de confirmación, información contextual, internacionalización, estados de carga, y feedback visual.
     - **Técnico**: Requisitos técnicos como ausencia de errores de tipado, patrones del proyecto a seguir, hooks o utilidades a reutilizar, y convenciones del codebase.
3. Usa la herramienta MCP de Linear (update_issue) para **actualizar la descripción de la tarea**. El ID de la tarea es: \`${task.id}\`

Al actualizar la descripción, conserva la descripción original y añade tu análisis debajo usando este formato:

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
- Usa la herramienta mcp__linear-server__update_issue para actualizar la descripción de la tarea.
- Escribe TODO el análisis en español.
- Los criterios de aceptación deben ser específicos al codebase real (nombres de hooks, componentes, endpoints, archivos de traducción, etc.), no genéricos.${imagePaths.length > 0 ? `

La tarea incluye ${imagePaths.length} imagen(es) adjunta(s). Léelas con la herramienta Read para entender el contexto visual (capturas de pantalla, mockups, errores, etc.):
${imagePaths.map((p) => `- ${p}`).join("\n")}

Incorpora lo que observes en las imágenes a tu análisis.` : ""}`;
}

/**
 * Invoke Claude Code CLI to analyze the task and update Linear.
 */
async function runClaude(task, imagePaths = []) {
  const prompt = buildPrompt(task, imagePaths);

  const allowedTools = [
    "Read",
    "Glob",
    "Grep",
    "Task",
    "mcp__linear-server__update_issue",
    "mcp__linear-server__get_issue",
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
    timeout: 5 * 60 * 1000, // 5 min max
  });

  console.log(`[CLAUDE] Output for ${task.identifier}:\n${result.stdout.slice(0, 500)}`);

  if (result.exitCode !== 0) {
    throw new Error(`Claude exited with code ${result.exitCode}: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Fetch a task from Linear via Claude MCP and enrich it.
 */
export async function enrichTaskByIdentifier(identifier) {
  console.log(`[MANUAL] Fetching ${identifier} from Linear...`);

  const fetchPrompt = `Usa la herramienta mcp__linear-server__get_issue para obtener la tarea con identificador "${identifier}". Devuelve SOLO un JSON con este formato exacto, sin markdown ni texto adicional:
{"id":"...","identifier":"...","title":"...","description":"...","priority":0,"labels":[],"teamName":"..."}`;

  const result = await exec("claude", [
    "-p",
    fetchPrompt,
    "--model",
    "haiku",
    "--allowedTools",
    "mcp__linear-server__get_issue",
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    "0.10",
  ], { cwd: PROJECT_ROOT, timeout: 60_000 });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to fetch ${identifier}: ${result.stderr}`);
  }

  const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Could not parse task data for ${identifier}: ${result.stdout.slice(0, 200)}`);
  }

  const task = JSON.parse(jsonMatch[0]);
  task.labels = task.labels || [];
  task.teamName = task.teamName || "";

  console.log(`[MANUAL] Fetched ${task.identifier}: ${task.title}`);
  return enrichTask(task);
}

/**
 * Main enrichment pipeline.
 */
export async function enrichTask(task) {
  // Step 1: Pull latest code
  try {
    await pullRepos();
  } catch (err) {
    console.warn(`[GIT] Pull failed (continuing anyway): ${err.message}`);
  }

  // Step 2: Download images from description
  const imageUrls = extractImageUrls(task.description);
  let imagePaths = [];
  if (imageUrls.length > 0) {
    console.log(`[IMAGES] Found ${imageUrls.length} image(s) in ${task.identifier}`);
    imagePaths = await downloadImages(imageUrls, task.identifier);
  }

  // Step 3: Run Claude to analyze and update the task
  try {
    await runClaude(task, imagePaths);
  } finally {
    await cleanupImages(task.identifier);
  }
}

/**
 * Helper to run a command and capture output.
 */
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
