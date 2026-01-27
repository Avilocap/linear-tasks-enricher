# Linear Tasks Enricher

Servicio que enriquece automáticamente las tareas de Linear con contexto técnico extraído del codebase, usando Claude Code.

## Qué hace

Cuando se crea una tarea nueva en Linear, el servicio:

1. Recibe el webhook de Linear
2. Hace `git pull` de los repositorios del proyecto
3. Invoca Claude Code para analizar los codebases
4. Actualiza la descripción de la tarea en Linear con:
   - **Enfoque de implementación** — pasos concretos con referencias a archivos y funciones reales
   - **Contexto técnico** — patrones de arquitectura, dependencias y utilidades relevantes
   - **Complejidad** — estimación (Baja / Media / Alta) con justificación
   - **Criterios de aceptación** — divididos en Funcionalidad, UX y Técnico, específicos al codebase

También permite enriquecer tareas ya existentes bajo demanda.

## Arquitectura

```
Linear webhook → Cloudflare Tunnel → Express server → Claude Code CLI → Linear MCP update
```

- **Express** recibe webhooks y peticiones manuales
- **Cloudflare Tunnel** expone el servidor local a internet con URL fija
- **Claude Code** (`claude -p`) analiza el codebase en modo no interactivo
- **Linear MCP** permite a Claude leer y actualizar tareas directamente

## Setup

### Requisitos

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)
- MCP de Linear configurado en Claude Code (`claude mcp add`)

### Instalación

```bash
git clone https://github.com/Avilocap/linear-tasks-enricher.git
cd linear-tasks-enricher
npm install
cp .env.example .env
```

Edita `.env`:

```
PORT=3000
LINEAR_WEBHOOK_SECRET=tu_signing_secret
LINEAR_TEAM_KEY=TU_TEAM_KEY
```

### Cloudflare Tunnel

```bash
cloudflared login
cloudflared tunnel create tasks-enricher
cloudflared tunnel route dns tasks-enricher tu-subdominio.tudominio.com
```

### Webhook en Linear

Settings → API → Webhooks → Crear webhook:
- **URL**: `https://tu-subdominio.tudominio.com/webhook`
- **Resource types**: Issues
- **Actions**: Create

Copia el signing secret a `LINEAR_WEBHOOK_SECRET` en `.env`.

### Arrancar

```bash
./start.sh
```

Para ejecución desatendida en macOS, usar launchd (ver sección más abajo).

## Endpoints

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `POST` | `/webhook` | Linear signature | Recibe webhooks de Linear |
| `POST` | `/enrich` | Bearer token | Enriquece tareas existentes |
| `GET` | `/health` | — | Health check |

### Enriquecer tareas existentes

```bash
curl -X POST https://tu-subdominio.tudominio.com/enrich \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_WEBHOOK_SECRET" \
  -d '{"issues": ["TEAM-123", "TEAM-456"]}'
```

## Ejecución desatendida (macOS launchd)

Crear dos plists en `~/Library/LaunchAgents/`:

- `com.example.tasks-enricher.plist` — servidor Node
- `com.example.tasks-enricher-tunnel.plist` — túnel Cloudflare

Ambos con `RunAtLoad` y `KeepAlive` activados. Gestión:

```bash
# Arrancar
launchctl load ~/Library/LaunchAgents/com.example.tasks-enricher.plist
launchctl load ~/Library/LaunchAgents/com.example.tasks-enricher-tunnel.plist

# Parar
launchctl unload ~/Library/LaunchAgents/com.example.tasks-enricher.plist
launchctl unload ~/Library/LaunchAgents/com.example.tasks-enricher-tunnel.plist

# Logs
tail -f logs/server.log
```

---

> **Nota**: El 100% del código de este proyecto ha sido generado usando inteligencia artificial (Claude Code de Anthropic).
