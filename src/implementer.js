import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createWorktree,
  removeWorktree,
  registerWorktree,
  createBranchName,
} from "./worktree-manager.js";

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(import.meta.dirname, "..");
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const REPOS = {
  backend: "z2-backend",
  frontend: "z2-frontend",
};

/**
 * Create a comment on a Linear issue.
 */
async function createLinearComment(issueId, body) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({
      query: `mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }`,
      variables: { issueId, body },
    }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  return data.data.commentCreate;
}

/**
 * Fetch a Linear issue by ID.
 */
async function getLinearIssue(issueId) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({
      query: `query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          priority
          url
          team { name key }
          labels { nodes { name } }
        }
      }`,
      variables: { id: issueId },
    }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  return data.data.issue;
}

/**
 * Determine which repos are affected based on the task description/analysis.
 */
function detectAffectedRepos(description) {
  const repos = [];
  const text = (description || "").toLowerCase();

  // Check for backend indicators
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

  // Check for frontend indicators
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

  // Default to both if no clear indicators
  if (repos.length === 0) {
    repos.push("backend", "frontend");
  }

  return repos;
}

/**
 * Build the implementation prompt for Claude.
 */
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

/**
 * Run Claude to implement changes in a worktree.
 */
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

  console.log(`[CLAUDE] Starting implementation for ${task.identifier} in ${repo}...`);

  const result = await exec("claude", args, {
    cwd: worktreePath,
    timeout: 10 * 60 * 1000, // 10 min max
  });

  console.log(`[CLAUDE] Implementation output:\n${result.stdout.slice(-1000)}`);

  if (result.exitCode !== 0) {
    throw new Error(`Claude exited with code ${result.exitCode}: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Check if there are new commits compared to origin/main.
 */
async function hasNewCommits(worktreePath) {
  // Check if HEAD is ahead of origin/main
  const result = await exec("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: worktreePath });
  const count = parseInt(result.stdout.trim(), 10);
  return count > 0;
}

/**
 * Commit all changes in the worktree.
 */
async function commitChanges(worktreePath, task) {
  // Stage all changes
  await exec("git", ["add", "-A"], { cwd: worktreePath });

  // Create commit
  const commitMessage = `feat(${task.identifier.toLowerCase()}): ${task.title}

Implemented by Devora agent.

Linear: ${task.url}`;

  const result = await exec("git", ["commit", "-m", commitMessage], { cwd: worktreePath });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to commit: ${result.stderr}`);
  }

  console.log(`[GIT] Committed changes for ${task.identifier}`);
}

/**
 * Push branch to remote and create PR.
 */
async function pushAndCreatePR(worktreePath, branchName, task, repo) {
  const repoName = REPOS[repo];

  // Push to origin
  console.log(`[GIT] Pushing ${branchName} to origin...`);
  const pushResult = await exec("git", ["push", "-u", "origin", branchName], {
    cwd: worktreePath,
  });

  if (pushResult.exitCode !== 0) {
    throw new Error(`Failed to push: ${pushResult.stderr}`);
  }

  // Create PR using gh CLI
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

  // Extract PR URL from output
  const prUrl = prResult.stdout.trim().split("\n").pop();
  console.log(`[GIT] Created PR: ${prUrl}`);

  return prUrl;
}

/**
 * Main implementation pipeline.
 */
export async function implementTask(issueId, commentId) {
  console.log(`[IMPLEMENT] Starting implementation for issue ${issueId}`);

  // 1. Fetch the full issue from Linear
  const issue = await getLinearIssue(issueId);
  if (!issue) {
    throw new Error(`Issue ${issueId} not found`);
  }

  console.log(`[IMPLEMENT] Implementing ${issue.identifier}: ${issue.title}`);

  // 2. Comment that we're starting
  await createLinearComment(issueId, `> Devora comenzando implementación...

Analizando la tarea y preparando el entorno de desarrollo.`);

  // 3. Determine affected repos
  const affectedRepos = detectAffectedRepos(issue.description);
  console.log(`[IMPLEMENT] Affected repos: ${affectedRepos.join(", ")}`);

  // 4. Create branch name
  const branchName = createBranchName(issue.identifier, issue.title);
  console.log(`[IMPLEMENT] Branch name: ${branchName}`);

  const results = [];

  // 5. For each affected repo, create worktree and implement
  for (const repo of affectedRepos) {
    const repoName = REPOS[repo];
    console.log(`[IMPLEMENT] Processing ${repoName}...`);

    try {
      // Create worktree
      const worktreePath = await createWorktree(repoName, issue.identifier, branchName);

      // Run Claude to implement
      await runClaudeImplementation(issue, repo, worktreePath);

      // Check if Claude made any commits
      if (!(await hasNewCommits(worktreePath))) {
        console.log(`[IMPLEMENT] No commits made in ${repoName}`);
        await removeWorktree(repoName, issue.identifier);
        continue;
      }

      // Push and create PR (Claude already made commits)
      const prUrl = await pushAndCreatePR(worktreePath, branchName, issue, repo);

      // Register worktree
      await registerWorktree(repoName, issue.identifier, branchName, prUrl, issueId);

      results.push({ repo: repoName, prUrl, success: true });
    } catch (err) {
      console.error(`[IMPLEMENT] Error in ${repoName}:`, err.message);
      results.push({ repo: repoName, error: err.message, success: false });

      // Try to cleanup worktree on error
      try {
        await removeWorktree(repoName, issue.identifier);
      } catch {}
    }
  }

  // 6. Comment on Linear with results
  const successResults = results.filter((r) => r.success);
  const failedResults = results.filter((r) => !r.success);

  let commentBody = `## Implementación completada\n\n`;

  if (successResults.length > 0) {
    commentBody += `### Pull Requests creadas:\n`;
    for (const r of successResults) {
      commentBody += `- **${r.repo}**: [Ver PR](${r.prUrl})\n`;
    }
  }

  if (failedResults.length > 0) {
    commentBody += `\n### Errores:\n`;
    for (const r of failedResults) {
      commentBody += `- **${r.repo}**: ${r.error}\n`;
    }
  }

  if (successResults.length === 0 && failedResults.length === 0) {
    commentBody = `No se detectaron cambios necesarios para esta tarea.`;
  }

  await createLinearComment(issueId, commentBody);

  console.log(`[IMPLEMENT] Completed implementation for ${issue.identifier}`);
  return results;
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

/**
 * Helper to run a command and capture output.
 */
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
