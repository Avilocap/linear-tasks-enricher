import { spawn } from "node:child_process";
import path from "node:path";
import { createEmitter } from "./activity-emitter.js";
import { getIssue } from "./linear-client.js";
import {
  createWorktree,
  removeWorktree,
  registerWorktree,
  createBranchName,
} from "./worktree-manager.js";

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(import.meta.dirname, "..");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const REPOS = {
  backend: "z2-backend",
  frontend: "z2-frontend",
};

/**
 * Entry point for Devora agent sessions (called from server.js).
 */
export async function handleDevoraSession(sessionId, issueId, webhookData) {
  const emit = createEmitter("devora", sessionId);

  // First activity must be emitted within 10 sec
  await emit.thought("Sesión recibida. Preparando pipeline de implementación…");

  try {
    // Fetch issue
    await emit.action("getIssue", issueId);
    const issue = await getIssue("devora", issueId);
    if (!issue) {
      await emit.error(`No se encontró la tarea con ID ${issueId}`);
      return;
    }

    // Skip if issue is already completed or canceled
    const stateType = issue.state?.type;
    if (stateType === "completed" || stateType === "canceled") {
      console.log(`[DEVORA] Skipping ${issue.identifier} — state is ${stateType}`);
      await emit.response(`Tarea ${issue.identifier} ya está ${stateType === "completed" ? "completada" : "cancelada"}. No hay nada que hacer.`);
      return;
    }

    const task = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || "",
      priority: issue.priority,
      url: issue.url || "",
      labels: issue.labels?.nodes?.map((l) => l.name) || [],
      teamName: issue.team?.name || "",
      teamKey: issue.team?.key || "",
    };

    await emit.thought(`Tarea: ${task.identifier} — ${task.title}`);

    // Detect affected repos
    const affectedRepos = detectAffectedRepos(task.description);
    console.log(`[IMPLEMENT] Affected repos: ${affectedRepos.join(", ")}`);

    // Build plan steps based on repos
    const planSteps = [
      { content: "Analizar tarea y detectar repos afectados", status: "completed" },
    ];
    for (const repo of affectedRepos) {
      planSteps.push({ content: `Implementar en ${REPOS[repo]}`, status: "pending" });
    }
    planSteps.push({ content: "Resumen final", status: "pending" });
    await emit.updatePlan(planSteps);

    // Create branch name
    const branchName = createBranchName(task.identifier, task.title);
    console.log(`[IMPLEMENT] Branch name: ${branchName}`);

    const results = [];

    // For each affected repo, create worktree and implement
    for (let i = 0; i < affectedRepos.length; i++) {
      const repo = affectedRepos[i];
      const repoName = REPOS[repo];
      const stepIndex = i + 1; // offset by 1 because step 0 is "analizar"

      // Mark step in progress
      planSteps[stepIndex].status = "inProgress";
      await emit.updatePlan(planSteps);
      await emit.thought(`Procesando ${repoName}…`);

      try {
        // Create worktree
        await emit.action("createWorktree", `${repoName}/${task.identifier}`);
        const worktreePath = await createWorktree(repoName, task.identifier, branchName);

        // Run Claude to implement
        await emit.action("runClaude", `Implementando en ${repoName}`);
        await runClaudeImplementation(task, repo, worktreePath);

        // Check if Claude made any commits
        if (!(await hasNewCommits(worktreePath))) {
          console.log(`[IMPLEMENT] No commits made in ${repoName}`);
          await emit.thought(`Sin cambios en ${repoName}.`);
          await removeWorktree(repoName, task.identifier);
          planSteps[stepIndex].status = "completed";
          await emit.updatePlan(planSteps);
          continue;
        }

        // Push and create PR
        await emit.action("pushAndCreatePR", `${repoName}/${branchName}`);
        const prUrl = await pushAndCreatePR(worktreePath, branchName, task, repo);

        // Register worktree
        await registerWorktree(repoName, task.identifier, branchName, prUrl, issueId);

        // Add external URL to session
        await emit.addExternalUrl(`PR: ${repoName}`, prUrl);

        results.push({ repo: repoName, prUrl, success: true });
        planSteps[stepIndex].status = "completed";
        await emit.updatePlan(planSteps);
      } catch (err) {
        console.error(`[IMPLEMENT] Error in ${repoName}:`, err.message);
        results.push({ repo: repoName, error: err.message, success: false });
        planSteps[stepIndex].status = "canceled";
        await emit.updatePlan(planSteps);
        await emit.thought(`Error en ${repoName}: ${err.message}`);

        try {
          await removeWorktree(repoName, task.identifier);
        } catch {}
      }
    }

    // Final summary
    const lastStepIndex = planSteps.length - 1;
    planSteps[lastStepIndex].status = "completed";
    await emit.updatePlan(planSteps);

    const successResults = results.filter((r) => r.success);
    const failedResults = results.filter((r) => !r.success);

    let summary = `Implementación completada para ${task.identifier}.\n\n`;

    if (successResults.length > 0) {
      summary += `**Pull Requests creadas:**\n`;
      for (const r of successResults) {
        summary += `- ${r.repo}: ${r.prUrl}\n`;
      }
    }

    if (failedResults.length > 0) {
      summary += `\n**Errores:**\n`;
      for (const r of failedResults) {
        summary += `- ${r.repo}: ${r.error}\n`;
      }
    }

    if (successResults.length === 0 && failedResults.length === 0) {
      summary = `No se detectaron cambios necesarios para ${task.identifier}.`;
    }

    await emit.response(summary);
    console.log(`[IMPLEMENT] Completed implementation for ${task.identifier}`);
  } catch (err) {
    console.error(`[DEVORA] Pipeline error:`, err.message);
    await emit.error(`Error en el pipeline: ${err.message}`);
  }
}

/**
 * Cleanup worktrees when a PR is merged or closed.
 */
export async function cleanupForBranch(branchName, merged) {
  const { findWorktreesByBranch } = await import("./worktree-manager.js");

  const worktrees = await findWorktreesByBranch(branchName);

  for (const wt of worktrees) {
    console.log(`[CLEANUP] Removing worktree for ${wt.repo}/${wt.taskIdentifier}`);

    try {
      await removeWorktree(wt.repo, wt.taskIdentifier);
    } catch (err) {
      console.error(`[CLEANUP] Error removing worktree:`, err.message);
    }
  }
}

// ─── Repo detection ─────────────────────────────────────────────────────

function detectAffectedRepos(description) {
  const repos = [];
  const text = (description || "").toLowerCase();

  if (
    text.includes("backend") ||
    text.includes("z2-backend") ||
    text.includes("spring") ||
    text.includes("java") ||
    text.includes("api") ||
    text.includes("endpoint") ||
    text.includes("controller") ||
    text.includes("service") ||
    text.includes("repository") ||
    text.includes("gradlew")
  ) {
    repos.push("backend");
  }

  if (
    text.includes("frontend") ||
    text.includes("z2-frontend") ||
    text.includes("react") ||
    text.includes("component") ||
    text.includes("hook") ||
    text.includes("tsx") ||
    text.includes("css") ||
    text.includes("ui") ||
    text.includes("vista") ||
    text.includes("pantalla")
  ) {
    repos.push("frontend");
  }

  if (repos.length === 0) {
    repos.push("backend", "frontend");
  }

  return repos;
}

// ─── Claude implementation ──────────────────────────────────────────────

function buildImplementationPrompt(task, repo, worktreePath) {
  const repoName = REPOS[repo];

  return `Eres un desarrollador senior que implementa tareas en el proyecto ${repoName}.

CONTEXTO DE LA TAREA:
- Identificador: ${task.identifier}
- Título: ${task.title}
- URL: ${task.url}

DESCRIPCIÓN COMPLETA (incluye análisis técnico si existe):
${task.description || "(sin descripción)"}

INSTRUCCIONES:
1. Lee el análisis técnico en la descripción para entender el enfoque de implementación.
2. Implementa los cambios siguiendo los pasos indicados en "Enfoque de Implementación".
3. Sigue estrictamente las convenciones del proyecto.
4. NO crees archivos nuevos innecesarios.
5. Asegúrate de que el código compila sin errores.
6. Haz commits pequeños y descriptivos siguiendo el formato: tipo(scope): mensaje

${repo === "backend" ? `
TESTS (BACKEND):
- Identifica qué módulo(s) se ven afectados por tus cambios.
- Ejecuta SOLO los tests del módulo afectado: ./gradlew :moduleName:test
- Si los tests fallan, arregla el código.
- NO ejecutes ./gradlew test (tarda demasiado).
- Al final, ejecuta ./gradlew spotlessApply para formatear el código.

CONVENCIONES BACKEND:
- Java 25, Spring Boot 4.0.1, WebFlux/Reactor
- Commits: tipo(scope): mensaje (ej: feat(data): add new filter)
` : `
CONVENCIONES FRONTEND:
- React, TypeScript, TanStack Query
- Commits: tipo(scope): mensaje (ej: feat(ui): add new button)
- Ejecuta pnpm lint para verificar el código.
`}

IMPORTANTE:
- Trabaja SOLO en el directorio del worktree: ${worktreePath}
- NO modifiques archivos fuera de ese directorio.
- Cuando termines, lista los archivos modificados y describe brevemente los cambios.
- Si encuentras bloqueantes o dudas importantes, menciónalos claramente.`;
}

async function runClaudeImplementation(task, repo, worktreePath) {
  const prompt = buildImplementationPrompt(task, repo, worktreePath);

  const allowedTools = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
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
    "5.00",
  ];

  console.log(`[CLAUDE] Starting implementation for ${task.identifier} in ${REPOS[repo]}...`);

  const result = await exec("claude", args, {
    cwd: worktreePath,
    timeout: 10 * 60 * 1000,
  });

  console.log(`[CLAUDE] Implementation output:\n${result.stdout.slice(-1000)}`);

  if (result.exitCode !== 0) {
    throw new Error(`Claude exited with code ${result.exitCode}: ${result.stderr}`);
  }

  return result.stdout;
}

// ─── Git helpers ────────────────────────────────────────────────────────

async function hasNewCommits(worktreePath) {
  const result = await exec("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: worktreePath });
  const count = parseInt(result.stdout.trim(), 10);
  return count > 0;
}

async function pushAndCreatePR(worktreePath, branchName, task, repo) {
  const repoName = REPOS[repo];

  console.log(`[GIT] Pushing ${branchName} to origin...`);
  const pushResult = await exec("git", ["push", "-u", "origin", branchName], {
    cwd: worktreePath,
  });

  if (pushResult.exitCode !== 0) {
    throw new Error(`Failed to push: ${pushResult.stderr}`);
  }

  console.log(`[GIT] Creating PR...`);
  const prTitle = `feat(${task.identifier.toLowerCase()}): ${task.title}`;
  const prBody = `## Summary

Implemented by Devora agent based on Linear task analysis.

## Linear Task

[${task.identifier}](${task.url})

## Test Plan

- [ ] Code compiles without errors
- [ ] Tests pass for affected modules
- [ ] Manual verification of functionality

---
Generated by Devora`;

  const prResult = await exec("gh", [
    "pr", "create",
    "--base", "main",
    "--head", branchName,
    "--title", prTitle,
    "--body", prBody,
  ], {
    cwd: worktreePath,
    env: { ...process.env, GH_TOKEN: GITHUB_TOKEN },
  });

  if (prResult.exitCode !== 0) {
    throw new Error(`Failed to create PR: ${prResult.stderr}`);
  }

  const prUrl = prResult.stdout.trim().split("\n").pop();
  console.log(`[GIT] Created PR: ${prUrl}`);

  return prUrl;
}

// ─── Exec helper ────────────────────────────────────────────────────────

function exec(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      timeout: options.timeout || 120_000,
      env: options.env || process.env,
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
