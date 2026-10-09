# Render deployment – ops console (backend + dashboard)

```
Browser ──HTTPS──▶ Render Web Service (dashboard/server.js + dashboard/public/)
                        ├──▶ Neon PostgreSQL        (DATABASE_URL, SSL)
                        └──▶ n8n on the OVH VPS     (N8N_WEBHOOK_BASE + X-Ops-Token)
n8n (OVH) ──▶ OpenAI, Neon
```
Only the console runs on Render. n8n stays on the VPS, and the business database stays on Neon. The frontend (HTML/CSS/JS) is served by the same service and calls relative `/api/...` routes, so no CORS is needed and no Vercel project is required.

## Service settings

| Setting | Value |
|---|---|
| Service Type | Web Service |
| Runtime | Docker |
| Root Directory | *(empty)* |
| Dockerfile Path | `./dashboard/Dockerfile` |
| Docker Context | `.` |
| Health Check | `/api/health` |
| Build Command | *(empty)* |
| Start Command | *(empty)* |

The image copies `dashboard/` (server + public), `lib/` and `demo/` only. `.env`, `n8n/`, `database/`, `docs/` and `tests/` are excluded by `.dockerignore`, so no secret is baked into the image. The server listens on Render's `PORT` (fallback 3000 locally).

## Environment variables (Render → Environment)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Neon connection string | keep `sslmode=require`; mark as **secret** |
| `N8N_WEBHOOK_BASE` | `https://<your-n8n-domain>/webhook` | HTTPS URL of the OVH n8n, **with** `/webhook` and no trailing slash |
| `OPS_API_TOKEN` | same value as the n8n credential *Ops Console Token* | secret; sent server-side only in `X-Ops-Token` |
| `CONSOLE_USER` | operator login | **required**: the URL is public |
| `CONSOLE_PASSWORD` | 12+ characters | secret |
| `DEMO_MODE` | `true` | `false` only with real channels, see PRODUCTION_SETUP.md |
| `REQUIRE_HUMAN_APPROVAL` | `true` | displayed in the console header |
| `AI_PROVIDER` | `openai` | display only (the AI runs in n8n) |
| `OPENAI_MODEL` | `gpt-4.1-mini` | display only |
| `BUSINESS_TIMEZONE` | `Indian/Antananarivo` | |
| `SLA_NEW_MINUTES` | `5` | the console computes the SLA badges of the live queue |
| `SLA_READY_FOR_SEARCH_MINUTES` | `10` | |
| `SLA_ASSIGNED_MINUTES` | `15` | |
| `SLA_SEARCHING_MINUTES` | `45` | |
| `SLA_FARES_FOUND_MINUTES` | `10` | |
| `SLA_PENDING_APPROVAL_MINUTES` | `10` | |
| `SLA_BOOKING_REQUEST_MINUTES` | `5` | |
| `SLA_CHANGE_REQUEST_MINUTES` | `15` | |
| `SLA_REFUND_REQUEST_MINUTES` | `60` | |
| `SLA_CRITICAL_FACTOR` | `0.5` | |

Keep the SLA values identical to the ones configured in n8n (WF08 uses them for alerts).

**Do NOT set on Render:** `PORT` (Render provides it), `N8N_ENCRYPTION_KEY`, `N8N_VERSION`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `CONSOLE_DB_PASSWORD`, `PG*`, `OPENAI_API_KEY`, `WHATSAPP_*`, `GMAIL_*`, `LOAD_DEMO_DATA`. They belong to n8n or to the local Docker stack.

## Start-up behaviour
- The console validates its configuration on start (`lib/envCheck.js`). With `DEMO_MODE=false` it **refuses to start** without `CONSOLE_USER`/`CONSOLE_PASSWORD`, a real `OPS_API_TOKEN` (24+ characters) and `N8N_WEBHOOK_BASE`. Errors list variable names, never values.
- `GET /api/health` (alias `/health`): 200 when the process runs **and** Neon answers; 503 otherwise. This is the Render health check (public, returns no data).
- `GET /ready`: 200 only when Neon **and** n8n (`<n8n>/healthz/readiness`) are reachable. Useful to diagnose the n8n link; not used by Render.
- Logs are JSON lines (Render → Logs). They never contain `DATABASE_URL`, passwords or the ops token.
- The pg library prints a one-time `SECURITY WARNING` about `sslmode=require` being treated as `verify-full`. This is harmless: Neon certificates are fully verified.

## n8n side (OVH)
- The console calls `POST {N8N_WEBHOOK_BASE}/demo/email`, `/whatsapp`, `/fare-desk/options`, `/quote/decision`, `/ops/action`, `/ops/run-followups`, `/ops/run-sla`. Every call carries `X-Ops-Token`, except `/whatsapp`, which is protected by the Meta signature in n8n.
- The 18 workflows must be **published**. The n8n credential *Ops Console Token* must contain exactly the `OPS_API_TOKEN` value, and the n8n Postgres credential must point to the **same Neon database**.
- The n8n instance needs `DEMO_MODE=true` for the demo webhooks and the simulator.

## Security checklist
- [x] `.env` is git-ignored and excluded from the Docker build context
- [x] `npm run security:scan` → NO EXPOSED SECRETS
- [x] `dashboard/public/*` contains no credential; the browser only calls relative `/api/...` routes
- [x] `DATABASE_URL` and `OPS_API_TOKEN` are only used server-side and never returned by any endpoint
- [x] Basic auth on every page and API route (except `/api/health`, `/health`, `/ready`)
- [x] CSP, `X-Frame-Options: DENY`, no CORS, cross-site / non-JSON writes rejected (403), HSTS when `DEMO_MODE=false`

## After the first deploy
1. Open `https://<service>.onrender.com/api/health` → `{"status":"ok","db":true}`.
2. Open `https://<service>.onrender.com/ready` → `"n8n": true`. If it is false, check `N8N_WEBHOOK_BASE` and the HTTPS reachability of the VPS.
3. Log in → the dashboard shows the Neon data → Demo Simulator → *Scenario 1*.
4. Optional: `CONSOLE_URL=https://<service>.onrender.com N8N_URL=https://<your-n8n-domain> CONSOLE_USER=… CONSOLE_PASSWORD=… npm run test:e2e`.
