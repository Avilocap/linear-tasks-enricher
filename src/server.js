import express from "express";
import crypto from "node:crypto";
import { handleEnriqueSession } from "./enricher.js";
import { handleDevoraSession, cleanupForBranch } from "./implementer.js";
import { setTokens, setAppUserId } from "./token-store.js";

const app = express();
const PORT = process.env.PORT || 3000;

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;

const AGENTS = {
  enrique: {
    clientId: process.env.ENRIQUE_CLIENT_ID,
    clientSecret: process.env.ENRIQUE_CLIENT_SECRET,
    webhookSecret: process.env.ENRIQUE_WEBHOOK_SECRET,
    handler: handleEnriqueSession,
  },
  devora: {
    clientId: process.env.DEVORA_CLIENT_ID,
    clientSecret: process.env.DEVORA_CLIENT_SECRET,
    webhookSecret: process.env.DEVORA_WEBHOOK_SECRET,
    handler: handleDevoraSession,
  },
};

// Parse raw body for signature verification, then JSON
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Signature verification ────────────────────────────────────────────

function verifyLinearSignature(req, secret) {
  if (!secret) {
    console.warn("[WARN] Webhook secret not set — skipping verification");
    return true;
  }
  const signature = req.headers["linear-signature"];
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(req.rawBody);
  const expected = hmac.digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
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

// ─── OAuth install & callback ──────────────────────────────────────────

app.get("/oauth/install/:agent", (req, res) => {
  const agentName = req.params.agent.toLowerCase();
  const agent = AGENTS[agentName];

  if (!agent || !agent.clientId) {
    return res.status(404).json({ error: `Unknown agent: ${agentName}` });
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: agent.clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: "read,write,app:assignable,app:mentionable",
    state: agentName,
    actor: "app",
  });

  const url = `https://linear.app/oauth/authorize?${params}`;
  console.log(`[OAUTH] Redirecting to Linear OAuth for ${agentName}`);
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  const agentName = (state || "").toLowerCase();
  const agent = AGENTS[agentName];

  if (!agent || !code) {
    return res.status(400).json({ error: "Missing code or invalid state" });
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: agent.clientId,
        client_secret: agent.clientSecret,
        redirect_uri: OAUTH_REDIRECT_URI,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error(`[OAUTH] Token exchange failed for ${agentName}: ${tokenRes.status} ${errBody}`);
      return res.status(500).json({ error: "Token exchange failed" });
    }

    const tokenData = await tokenRes.json();
    await setTokens(agentName, tokenData);

    // Fetch the appUser ID for this agent
    const meRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenData.access_token}`,
      },
      body: JSON.stringify({
        query: `{ appUser { id name } }`,
      }),
    });

    if (meRes.ok) {
      const meData = await meRes.json();
      const appUser = meData.data?.appUser;
      if (appUser?.id) {
        await setAppUserId(agentName, appUser.id);
      }
    }

    console.log(`[OAUTH] ${agentName} installed successfully`);
    res.json({ ok: true, agent: agentName, message: "Agent installed successfully" });
  } catch (err) {
    console.error(`[OAUTH] Error during callback for ${agentName}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Agent session webhooks ────────────────────────────────────────────

function createAgentWebhookHandler(agentName) {
  return async (req, res) => {
    const agent = AGENTS[agentName];

    if (!verifyLinearSignature(req, agent.webhookSecret)) {
      console.error(`[REJECT] Invalid signature on /webhook/agent/${agentName}`);
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { action, type, agentSession } = req.body;

    console.log(`[WEBHOOK/${agentName.toUpperCase()}] action=${action} type=${type} session=${agentSession?.id}`);

    if (type !== "AgentSession" && type !== "AgentSessionEvent") {
      return res.status(200).json({ ok: true, skipped: true });
    }

    // Respond immediately (must be <5 sec)
    res.status(200).json({ ok: true, processing: true });

    const sessionId = agentSession?.id;
    const issueId = agentSession?.issueId || agentSession?.issue?.id;
    const data = req.body;

    if (!sessionId) {
      console.error(`[WEBHOOK/${agentName.toUpperCase()}] No sessionId in payload`);
      return;
    }

    if (action === "created" || action === "prompted") {
      agent.handler(sessionId, issueId, data).catch((err) => {
        console.error(`[${agentName.toUpperCase()}] Pipeline failed:`, err.message);
      });
    } else {
      console.log(`[WEBHOOK/${agentName.toUpperCase()}] Ignoring action: ${action}`);
    }
  };
}

app.post("/webhook/agent/enrique", createAgentWebhookHandler("enrique"));
app.post("/webhook/agent/devora", createAgentWebhookHandler("devora"));

// ─── GitHub PR webhook (cleanup) ──────────────────────────────────────

app.post("/webhook/github", async (req, res) => {
  if (!verifyGitHubSignature(req)) {
    console.error("[REJECT] Invalid webhook signature on /webhook/github");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.headers["x-github-event"];
  const { action, pull_request } = req.body;

  console.log(`[WEBHOOK/GITHUB] event=${event} action=${action}`);

  if (event !== "pull_request") {
    return res.status(200).json({ ok: true, skipped: true });
  }

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

  res.status(200).json({ ok: true, cleaning: true });

  cleanupForBranch(branchName, merged).catch((err) => {
    console.error(`[CLEANUP] Failed for branch ${branchName}:`, err.message);
  });
});

// ─── Health ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Start ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] Endpoints:`);
  console.log(`[SERVER]   GET  /oauth/install/:agent  - Start OAuth install`);
  console.log(`[SERVER]   GET  /oauth/callback        - OAuth callback`);
  console.log(`[SERVER]   POST /webhook/agent/enrique - Enrique agent sessions`);
  console.log(`[SERVER]   POST /webhook/agent/devora  - Devora agent sessions`);
  console.log(`[SERVER]   POST /webhook/github        - GitHub PR cleanup`);
  console.log(`[SERVER]   GET  /health                - Health check`);

  for (const [name, agent] of Object.entries(AGENTS)) {
    if (!agent.clientId) {
      console.warn(`[SERVER] WARNING: ${name.toUpperCase()} OAuth not configured (missing CLIENT_ID)`);
    }
    if (!agent.webhookSecret) {
      console.warn(`[SERVER] WARNING: ${name.toUpperCase()} webhook secret not set`);
    }
  }

  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn("[SERVER] WARNING: GITHUB_WEBHOOK_SECRET not set");
  }
});
