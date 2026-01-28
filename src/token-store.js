import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(import.meta.dirname, "..");
const TOKENS_FILE = path.join(PROJECT_ROOT, ".tokens.json");

/**
 * Load all tokens from disk.
 */
async function loadTokens() {
  try {
    const data = await fs.readFile(TOKENS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Save all tokens to disk.
 */
async function saveTokens(tokens) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Store OAuth tokens for an agent (enrique | devora).
 * @param {string} agent - "enrique" or "devora"
 * @param {{ access_token: string, refresh_token: string, expires_in: number, token_type: string, scope: string }} data
 */
export async function setTokens(agent, data) {
  const tokens = await loadTokens();
  tokens[agent] = {
    ...tokens[agent],
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
  await saveTokens(tokens);
  console.log(`[TOKEN] Stored tokens for ${agent}`);
}

/**
 * Store the appUser ID returned after first OAuth install.
 */
export async function setAppUserId(agent, appUserId) {
  const tokens = await loadTokens();
  if (!tokens[agent]) tokens[agent] = {};
  tokens[agent].appUserId = appUserId;
  await saveTokens(tokens);
  console.log(`[TOKEN] Stored appUserId for ${agent}: ${appUserId}`);
}

/**
 * Look up which agent name corresponds to a given appUser ID.
 * @returns {string | null} "enrique" | "devora" | null
 */
export async function getAgentByAppUserId(appUserId) {
  const tokens = await loadTokens();
  for (const [agent, data] of Object.entries(tokens)) {
    if (data.appUserId === appUserId) return agent;
  }
  return null;
}

/**
 * Refresh an expired OAuth token.
 */
async function refreshAccessToken(agent) {
  const tokens = await loadTokens();
  const entry = tokens[agent];
  if (!entry?.refreshToken) {
    throw new Error(`No refresh token for agent ${agent}`);
  }

  const clientId = agent === "enrique"
    ? process.env.ENRIQUE_CLIENT_ID
    : process.env.DEVORA_CLIENT_ID;
  const clientSecret = agent === "enrique"
    ? process.env.ENRIQUE_CLIENT_SECRET
    : process.env.DEVORA_CLIENT_SECRET;

  console.log(`[TOKEN] Refreshing access token for ${agent}...`);

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: entry.refreshToken,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Token refresh failed for ${agent}: ${res.status} ${errBody}`);
  }

  const data = await res.json();
  await setTokens(agent, data);
  console.log(`[TOKEN] Refreshed token for ${agent}`);
  return data.access_token;
}

/**
 * Get a valid access token for an agent, refreshing if expired.
 * @param {string} agent - "enrique" or "devora"
 * @returns {Promise<string>} Bearer-ready access token
 */
export async function getToken(agent) {
  const tokens = await loadTokens();
  const entry = tokens[agent];

  if (!entry?.accessToken) {
    throw new Error(`No token stored for agent ${agent}. Run OAuth install first.`);
  }

  // Refresh if expiring within 5 minutes
  const MARGIN_MS = 5 * 60 * 1000;
  if (entry.expiresAt && Date.now() > entry.expiresAt - MARGIN_MS) {
    return refreshAccessToken(agent);
  }

  return entry.accessToken;
}
