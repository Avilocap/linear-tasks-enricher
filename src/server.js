import express from "express";
import crypto from "node:crypto";
import { enrichTask, enrichTaskByIdentifier } from "./enricher.js";

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const TEAM_KEY = process.env.LINEAR_TEAM_KEY || "";

// Parse raw body for signature verification, then JSON
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function verifySignature(req) {
  if (!WEBHOOK_SECRET) {
    console.warn("[WARN] LINEAR_WEBHOOK_SECRET not set — skipping verification");
    return true;
  }
  const signature = req.headers["linear-signature"];
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

app.post("/webhook", async (req, res) => {
  // Verify webhook signature
  if (!verifySignature(req)) {
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

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] Webhook endpoint: POST /webhook`);
  console.log(`[SERVER] Health check:     GET  /health`);
  if (!WEBHOOK_SECRET) {
    console.warn("[SERVER] WARNING: LINEAR_WEBHOOK_SECRET not set — signatures not verified");
  }
  if (TEAM_KEY) {
    console.log(`[SERVER] Filtering for team: ${TEAM_KEY}`);
  }
});
