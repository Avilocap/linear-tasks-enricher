# Linear Tasks Enricher

> **Note**: 100% of the code in this project was generated using artificial intelligence (Anthropic's Claude Code).

A service that automatically enriches Linear tasks with technical context extracted from the codebase, and can implement changes autonomously when triggered.

## What it does

### Task Enrichment

When a new task is created in Linear, the service:

1. Receives the webhook from Linear
2. Runs `git pull` on the project repositories
3. Extracts media from the task description:
   - **Images** — downloaded locally for Claude to read
   - **Videos** — audio extracted with ffmpeg and transcribed via OpenAI Whisper
4. Invokes Claude Code to analyze the codebases (including media context)
5. Updates the task description in Linear with:
   - **Implementation approach** — concrete steps referencing actual files and functions
   - **Technical context** — architecture patterns, dependencies, and relevant utilities
   - **Complexity** — estimate (Low / Medium / High) with justification
   - **Acceptance criteria** — split into Functionality, UX, and Technical, specific to the codebase

It also supports on-demand enrichment of existing tasks.

### Automatic Implementation (Devora)

When a comment containing a trigger phrase is added to a task (e.g., "Devora implementa", "Devora a trabajar"), the service:

1. Creates an isolated git worktree for each affected repository
2. Invokes Claude Code to implement the changes based on the technical analysis
3. Commits the changes and pushes to a feature branch
4. Creates a Pull Request on GitHub with a link to the Linear task
5. Comments on Linear with links to the created PRs
6. Automatically cleans up worktrees when PRs are merged or closed

**Trigger phrases**: `devora implementa`, `devora trabaja`, `devora desarrolla`, `devora hazlo`, `devora ejecuta`, `devora a trabajar`

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ENRICHMENT FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ Linear (new issue) → Webhook → Media processing → Claude Code → Linear API │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            IMPLEMENTATION FLOW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ Linear (comment) → Webhook → Git worktree → Claude Code → GitHub PR        │
│                                                                             │
│ GitHub (PR closed) → Webhook → Cleanup worktree                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Express** receives webhooks from Linear and GitHub
- **Cloudflare Tunnel** exposes the local server to the internet with a fixed URL
- **ffmpeg + OpenAI Whisper** extract and transcribe audio from attached videos
- **Claude Code** (`claude -p`) analyzes and implements changes in non-interactive mode
- **Git worktrees** provide isolated environments for each implementation
- **GitHub CLI** (`gh`) creates Pull Requests automatically

## Setup

### Requirements

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)
- [ffmpeg](https://ffmpeg.org/) (for video audio extraction)
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
LINEAR_COMMENT_WEBHOOK_SECRET=your_comment_webhook_secret
LINEAR_TEAM_KEY=YOUR_TEAM_KEY
LINEAR_API_KEY=lin_api_your_key
OPENAI_API_KEY=sk-your_key
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret
GITHUB_TOKEN=ghp_your_token
```

### Cloudflare Tunnel

```bash
cloudflared login
cloudflared tunnel create tasks-enricher
cloudflared tunnel route dns tasks-enricher your-subdomain.yourdomain.com
```

### Linear Webhooks

Settings → API → Webhooks → Create two webhooks:

**1. Issue webhook (enrichment)**
- **URL**: `https://your-subdomain.yourdomain.com/webhook`
- **Resource types**: Issues
- **Actions**: Create
- Copy signing secret to `LINEAR_WEBHOOK_SECRET`

**2. Comment webhook (Devora trigger)**
- **URL**: `https://your-subdomain.yourdomain.com/webhook/comment`
- **Resource types**: Comments
- Copy signing secret to `LINEAR_COMMENT_WEBHOOK_SECRET`

### GitHub Webhooks

For each repository (e.g., `z2-backend`, `z2-frontend`):

Settings → Webhooks → Add webhook:
- **URL**: `https://your-subdomain.yourdomain.com/webhook/github`
- **Content type**: `application/json`
- **Secret**: Same value for all repos, save to `GITHUB_WEBHOOK_SECRET`
- **Events**: Select "Pull requests" only

### Start

```bash
./start.sh
```

For unattended execution on macOS, use launchd (see section below).

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/webhook` | Linear signature | Receives Linear issue webhooks (enrichment) |
| `POST` | `/webhook/comment` | Linear signature | Receives Linear comment webhooks (Devora trigger) |
| `POST` | `/webhook/github` | GitHub signature | Receives GitHub PR webhooks (cleanup) |
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

# Restart
./restart.sh

# Logs
tail -f logs/server.log
```

