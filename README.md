# Linear Tasks Enricher

> **Note**: 100% of the code in this project was generated using artificial intelligence (Anthropic's Claude Code).

A service that automatically enriches Linear tasks with technical context extracted from the codebase, using Claude Code.

## What it does

When a new task is created in Linear, the service:

1. Receives the webhook from Linear
2. Runs `git pull` on the project repositories
3. Invokes Claude Code to analyze the codebases
4. Updates the task description in Linear with:
   - **Implementation approach** — concrete steps referencing actual files and functions
   - **Technical context** — architecture patterns, dependencies, and relevant utilities
   - **Complexity** — estimate (Low / Medium / High) with justification
   - **Acceptance criteria** — split into Functionality, UX, and Technical, specific to the codebase

It also supports on-demand enrichment of existing tasks.

## Architecture

```
Linear webhook → Cloudflare Tunnel → Express server → Claude Code CLI → Linear MCP update
```

- **Express** receives webhooks and manual requests
- **Cloudflare Tunnel** exposes the local server to the internet with a fixed URL
- **Claude Code** (`claude -p`) analyzes the codebase in non-interactive mode
- **Linear MCP** allows Claude to read and update tasks directly

## Setup

### Requirements

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)
- Linear MCP configured in Claude Code (`claude mcp add`)

### Installation

```bash
git clone https://github.com/Avilocap/linear-tasks-enricher.git
cd linear-tasks-enricher
npm install
cp .env.example .env
```

Edit `.env`:

```
PORT=3000
LINEAR_WEBHOOK_SECRET=your_signing_secret
LINEAR_TEAM_KEY=YOUR_TEAM_KEY
```

### Cloudflare Tunnel

```bash
cloudflared login
cloudflared tunnel create tasks-enricher
cloudflared tunnel route dns tasks-enricher your-subdomain.yourdomain.com
```

### Linear Webhook

Settings → API → Webhooks → Create webhook:
- **URL**: `https://your-subdomain.yourdomain.com/webhook`
- **Resource types**: Issues
- **Actions**: Create

Copy the signing secret to `LINEAR_WEBHOOK_SECRET` in `.env`.

### Start

```bash
./start.sh
```

For unattended execution on macOS, use launchd (see section below).

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/webhook` | Linear signature | Receives Linear webhooks |
| `POST` | `/enrich` | Bearer token | Enriches existing tasks on demand |
| `GET` | `/health` | — | Health check |

### Enrich existing tasks

```bash
curl -X POST https://your-subdomain.yourdomain.com/enrich \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{"issues": ["TEAM-123", "TEAM-456"]}'
```

## Unattended execution (macOS launchd)

Create two plists in `~/Library/LaunchAgents/`:

- `com.example.tasks-enricher.plist` — Node server
- `com.example.tasks-enricher-tunnel.plist` — Cloudflare tunnel

Both with `RunAtLoad` and `KeepAlive` enabled. Management:

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.example.tasks-enricher.plist
launchctl load ~/Library/LaunchAgents/com.example.tasks-enricher-tunnel.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.example.tasks-enricher.plist
launchctl unload ~/Library/LaunchAgents/com.example.tasks-enricher-tunnel.plist

# Logs
tail -f logs/server.log
```

