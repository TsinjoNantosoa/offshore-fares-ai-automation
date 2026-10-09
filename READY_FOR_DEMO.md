# READY FOR DEMO

**Status: READY FOR DEMO** — verified on 2026-10-06 with `npm run verify` (local Docker Desktop, `AI_PROVIDER=rules`).

| Check | Result |
|---|---|
| Lint (50 JS files) | PASS |
| Build (18 workflows from `lib/` + `prompts/`) | PASS |
| Configuration (`.env`) | PASS |
| Security scan | PASS – NO EXPOSED SECRETS |
| Unit tests | PASS – 71/71 |
| Stack health (postgres, n8n, console) | PASS |
| Workflow validation (deployed = repository) | PASS – 18/18 active and identical |
| Database tests (SQL API) | PASS – 17/17 groups |
| E2E round 1 | PASS – 16/16 |
| Demo reset → E2E round 2 | PASS – 16/16 |
| OpenAI smoke test | SKIP – ready for a real key (`npm run smoke:openai`) |

## Run the demo
```bash
cp .env.example .env    # first time
npm run demo            # or npm run demo:step for a live, step-by-step presentation
```
Console http://localhost:3000 · n8n http://localhost:5678 · guide: [docs/DEMO.md](docs/DEMO.md) · script: [docs/client-demo-script.md](docs/client-demo-script.md)

## Before showing real AI
Set `OPENAI_API_KEY` and `AI_PROVIDER=openai` in `.env`, then run `npm run smoke:openai` and `docker compose run --rm -e N8N_FORCE_REIMPORT=true n8n-init && docker compose up -d n8n`.

## Not demonstrated (needs client accounts)
Real Gmail / WhatsApp sending, GDS fares, automatic ticketing (out of scope). See [docs/PRODUCTION_SETUP.md](docs/PRODUCTION_SETUP.md) and [docs/CLIENT_CONFIGURATION.md](docs/CLIENT_CONFIGURATION.md).
