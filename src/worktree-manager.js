import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(import.meta.dirname, "..");
const WORKTREES_DIR = path.join(PROJECT_ROOT, ".worktrees");
const REGISTRY_FILE = path.join(WORKTREES_DIR, "registry.json");

/**
 * Create a branch name following Linear's convention.
 * Format: feature/{identifier}-{slug}
 */
export function createBranchName(identifier, title) {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^a-z0-9]+/g, "-")     // Only alphanumerics
    .replace(/^-|-$/g, "")           // No leading/trailing dashes
    .slice(0, 50);                   // Limit length
  return `feature/${identifier.toLowerCase()}-${slug}`;
}

/**
 * Create a git worktree for a specific repo and task.
 * @param {string} repo - Repository name (e.g., "z2-backend")
 * @param {string} taskIdentifier - Task identifier (e.g., "Z2DND-3462")
 * @param {string} branchName - Branch name to create
 * @returns {Promise<string>} Path to the created worktree
 */
export async function createWorktree(repo, taskIdentifier, branchName) {
  const repoPath = path.join(PROJECT_ROOT, repo);
  const worktreePath = path.join(WORKTREES_DIR, repo, taskIdentifier);

  // Ensure worktrees directory exists
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  // Fetch latest from origin
  console.log(`[WORKTREE] Fetching latest from origin for ${repo}...`);
  await exec("git", ["-C", repoPath, "fetch", "origin"]);

  // Create worktree with new branch based on origin/main
  console.log(`[WORKTREE] Creating worktree at ${worktreePath}...`);
  const result = await exec("git", [
    "-C", repoPath,
    "worktree", "add",
    worktreePath,
    "-b", branchName,
    "origin/main"
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  console.log(`[WORKTREE] Created worktree for ${repo}/${taskIdentifier}`);
  return worktreePath;
}

/**
 * Remove a git worktree.
 * @param {string} repo - Repository name
 * @param {string} taskIdentifier - Task identifier
 */
export async function removeWorktree(repo, taskIdentifier) {
  const repoPath = path.join(PROJECT_ROOT, repo);
  const worktreePath = path.join(WORKTREES_DIR, repo, taskIdentifier);

  console.log(`[WORKTREE] Removing worktree at ${worktreePath}...`);

  // Remove worktree via git
  const result = await exec("git", [
    "-C", repoPath,
    "worktree", "remove",
    worktreePath,
    "--force"
  ]);

  if (result.exitCode !== 0) {
    console.warn(`[WORKTREE] git worktree remove failed: ${result.stderr}`);
    // Fallback: delete directory manually
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
    } catch {}
  }

  // Prune worktrees
  await exec("git", ["-C", repoPath, "worktree", "prune"]);

  // Update registry
  await unregisterWorktree(repo, taskIdentifier);

  console.log(`[WORKTREE] Removed worktree for ${repo}/${taskIdentifier}`);
}

/**
 * Load the worktree registry.
 * @returns {Promise<Object>} Registry object
 */
async function loadRegistry() {
  try {
    const data = await fs.readFile(REGISTRY_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { worktrees: [] };
  }
}

/**
 * Save the worktree registry.
 * @param {Object} registry - Registry object to save
 */
async function saveRegistry(registry) {
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Register a worktree with its associated PR.
 * @param {string} repo - Repository name
 * @param {string} taskIdentifier - Task identifier
 * @param {string} branchName - Branch name
 * @param {string} prUrl - GitHub PR URL
 * @param {string} issueId - Linear issue ID
 */
export async function registerWorktree(repo, taskIdentifier, branchName, prUrl, issueId) {
  const registry = await loadRegistry();

  // Remove existing entry if any
  registry.worktrees = registry.worktrees.filter(
    (w) => !(w.repo === repo && w.taskIdentifier === taskIdentifier)
  );

  registry.worktrees.push({
    repo,
    taskIdentifier,
    branchName,
    prUrl,
    issueId,
    createdAt: new Date().toISOString(),
    worktreePath: path.join(WORKTREES_DIR, repo, taskIdentifier),
  });

  await saveRegistry(registry);
  console.log(`[WORKTREE] Registered worktree for ${repo}/${taskIdentifier}`);
}

/**
 * Unregister a worktree from the registry.
 * @param {string} repo - Repository name
 * @param {string} taskIdentifier - Task identifier
 */
async function unregisterWorktree(repo, taskIdentifier) {
  const registry = await loadRegistry();
  registry.worktrees = registry.worktrees.filter(
    (w) => !(w.repo === repo && w.taskIdentifier === taskIdentifier)
  );
  await saveRegistry(registry);
}

/**
 * List all active worktrees.
 * @returns {Promise<Array>} Array of worktree entries
 */
export async function listActiveWorktrees() {
  const registry = await loadRegistry();
  return registry.worktrees;
}

/**
 * Find worktrees by branch name.
 * @param {string} branchName - Branch name to search for
 * @returns {Promise<Array>} Array of matching worktree entries
 */
export async function findWorktreesByBranch(branchName) {
  const registry = await loadRegistry();
  return registry.worktrees.filter((w) => w.branchName === branchName);
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
