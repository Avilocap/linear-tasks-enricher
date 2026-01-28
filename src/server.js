import express from "express";
import crypto from "node:crypto";
import { enrichTask, enrichTaskByIdentifier } from "./enricher.js";
import { implementTask, cleanupForBranch } from "./implementer.js";

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const COMMENT_WEBHOOK_SECRET = process.env.LINEAR_COMMENT_WEBHOOK_SECRET;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const TEAM_KEY = process.env.LINEAR_TEAM_KEY || "";

// Regex to detect "Devora" trigger with action verbs
const DEVORA_TRIGGER = /\bdevora\b.*\b(implementa|trabaja|desarrolla|hazlo|ejecuta|a trabajar)\b/i;

// Parse raw body for signature verification, then JSON
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function verifyLinearSignature(req, secret = WEBHOOK_SECRET) {
  if (!secret) {
    console.warn("[WARN] Linear webhook secret not set — skipping verification");
    return true;
  }
  const signature = req.headers["linear-signature"];
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(req.rawBody);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function verifyGitHubSignature(req) {
  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn("[WARN] GITHUB_WEBHOOK_SECRET not set — skipping verification");
    return true;
  }
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", GITHUB_WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  const expected = `sha256=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.post("/webhook", async (req, res) => {
  // Verify webhook signature
  if (!verifyLinearSignature(req)) {
    console.error("[REJECT] Invalid webhook signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { action, type, data } = req.body;

  console.log(`[WEBHOOK] action=${action} type=${type} id=${data?.id}`);

  // Only process issue creation events
  if (type !== "Issue" || action !== "create") {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Filter by team if configured
  if (TEAM_KEY && data?.team?.key !== TEAM_KEY) {
    console.log(`[SKIP] Team ${data?.team?.key} does not match ${TEAM_KEY}`);
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Respond immediately — enrichment runs async
  res.status(200).json({ ok: true, processing: true });

  const taskInfo = {
    id: data.id,
    identifier: data.identifier,
    title: data.title,
    description: data.description || "",
    priority: data.priority,
    labels: data.labels?.map((l) => l.name) || [],
    teamName: data.team?.name || "",
    teamKey: data.team?.key || "",
    url: data.url || "",
  };

  console.log(`[ENRICH] Starting enrichment for ${taskInfo.identifier}: ${taskInfo.title}`);

  try {
    await enrichTask(taskInfo);
    console.log(`[ENRICH] Completed for ${taskInfo.identifier}`);
  } catch (err) {
    console.error(`[ENRICH] Failed for ${taskInfo.identifier}:`, err.message);
  }
});

// Manual enrichment: POST /enrich { "issues": ["Z2DND-123", "Z2DND-456"] }
app.post("/enrich", async (req, res) => {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (!WEBHOOK_SECRET || token !== WEBHOOK_SECRET) {
    console.error("[REJECT] Invalid or missing bearer token on /enrich");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { issues } = req.body;

  if (!Array.isArray(issues) || issues.length === 0) {
    return res.status(400).json({ error: "Provide an 'issues' array with identifiers" });
  }

  res.status(200).json({ ok: true, processing: issues });

  for (const identifier of issues) {
    console.log(`[MANUAL] Queued enrichment for ${identifier}`);
    enrichTaskByIdentifier(identifier).catch((err) => {
      console.error(`[MANUAL] Failed for ${identifier}:`, err.message);
    });
  }
});

// Webhook for Linear comments (Devora trigger)
app.post("/webhook/comment", async (req, res) => {
  // Verify webhook signature (uses separate secret for comment webhook)
  if (!verifyLinearSignature(req, COMMENT_WEBHOOK_SECRET)) {
    console.error("[REJECT] Invalid webhook signature on /webhook/comment");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { action, type, data } = req.body;

  console.log(`[WEBHOOK/COMMENT] action=${action} type=${type}`);

  // Only process comment creation events
  if (type !== "Comment" || action !== "create") {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const commentBody = data?.body || "";
  const issueId = data?.issue?.id;
  const commentId = data?.id;

  // Check for Devora trigger
  if (!DEVORA_TRIGGER.test(commentBody)) {
    console.log(`[WEBHOOK/COMMENT] No Devora trigger in comment`);
    return res.status(200).json({ ok: true, skipped: true });
  }

  if (!issueId) {
    console.error("[WEBHOOK/COMMENT] No issue ID in comment data");
    return res.status(400).json({ error: "No issue ID" });
  }

  console.log(`[WEBHOOK/COMMENT] Devora trigger detected for issue ${issueId}`);

  // Respond immediately — implementation runs async
  res.status(200).json({ ok: true, implementing: true });

  // Run implementation asynchronously
  implementTask(issueId, commentId).catch((err) => {
    console.error(`[IMPLEMENT] Failed for issue ${issueId}:`, err.message);
  });
});

// Webhook for GitHub PR events (cleanup worktrees)
app.post("/webhook/github", async (req, res) => {
  // Verify webhook signature
  if (!verifyGitHubSignature(req)) {
    console.error("[REJECT] Invalid webhook signature on /webhook/github");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.headers["x-github-event"];
  const { action, pull_request } = req.body;

  console.log(`[WEBHOOK/GITHUB] event=${event} action=${action}`);

  // Only process pull_request events
  if (event !== "pull_request") {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Only process closed PRs (merged or just closed)
  if (action !== "closed") {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const branchName = pull_request?.head?.ref;
  const merged = pull_request?.merged || false;

  if (!branchName) {
    console.error("[WEBHOOK/GITHUB] No branch name in PR data");
    return res.status(400).json({ error: "No branch name" });
  }

  console.log(`[WEBHOOK/GITHUB] PR ${merged ? "merged" : "closed"}: ${branchName}`);

  // Respond immediately — cleanup runs async
  res.status(200).json({ ok: true, cleaning: true });

  // Run cleanup asynchronously
  cleanupForBranch(branchName, merged).catch((err) => {
    console.error(`[CLEANUP] Failed for branch ${branchName}:`, err.message);
  });
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] Endpoints:`);
  console.log(`[SERVER]   POST /webhook         - Linear issue webhooks (enrichment)`);
  console.log(`[SERVER]   POST /webhook/comment - Linear comment webhooks (Devora trigger)`);
  console.log(`[SERVER]   POST /webhook/github  - GitHub PR webhooks (cleanup)`);
  console.log(`[SERVER]   POST /enrich          - Manual enrichment`);
  console.log(`[SERVER]   GET  /health          - Health check`);
  if (!WEBHOOK_SECRET) {
    console.warn("[SERVER] WARNING: LINEAR_WEBHOOK_SECRET not set — signatures not verified");
  }
  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn("[SERVER] WARNING: GITHUB_WEBHOOK_SECRET not set — GitHub signatures not verified");
  }
  if (TEAM_KEY) {
    console.log(`[SERVER] Filtering for team: ${TEAM_KEY}`);
  }
});
