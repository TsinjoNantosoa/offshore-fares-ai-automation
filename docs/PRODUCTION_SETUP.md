# Production setup: from DEMO to PRODUCTION

This is the exact procedure to move from the local demo (`DEMO_MODE=true`) to a production deployment with real channels. Each step ends with a check. **Do not skip step 12 (smoke tests).**

> The stack refuses to start in production with an unsafe configuration: `lib/envCheck.js` runs in the `n8n-init` container and in the ops console. Run `npm run config:check` at any time to see what is missing (variable names only, never values).

## What changes between the two modes

| | `DEMO_MODE=true` | `DEMO_MODE=false` |
|---|---|---|
| Demo data | loaded (`LOAD_DEMO_DATA=true`) | **refused**: `LOAD_DEMO_DATA` must be `false` |
| Demo webhooks (`/webhook/demo/email`), console simulator | enabled | **disabled** (403) |
| Mock Fare Desk sample fares | enabled | **disabled** (403); fares come from the desk or a GDS adapter |
| Email / WhatsApp delivery | simulated (recorded, not sent) | real (Gmail API / WhatsApp Cloud API) |
| WhatsApp webhook signature | optional | **mandatory** (`WHATSAPP_APP_SECRET`, otherwise 401) |
| Console authentication | optional (warning) | **mandatory**: the console exits on start without `CONSOLE_USER`/`CONSOLE_PASSWORD` |
| Secrets | placeholders accepted | placeholders (`change-me…`, `local-test…`, `YOUR_…`) refused; minimum lengths enforced |
| OpenAI key | optional (rules fallback) | required when `AI_PROVIDER=openai` |
| Channels | none required | at least one channel complete (Gmail and/or WhatsApp) |
| HSTS header on the console | no | yes |
| `npm run demo`, `demo:reset`, `demo:rebuild` | allowed | refused |

## 1. Deploy the server
- A Linux VM (2 vCPU / 4 GB RAM minimum) with Docker Engine and Compose v2, **or** split hosting (managed PostgreSQL + your own n8n + the console as a container).
- Clone the repository and run `cp .env.example .env`.
- ✔ Check: `docker compose version`.

## 2. Configure PostgreSQL
- **Bundled** (`postgres` service): set strong `POSTGRES_PASSWORD` and `CONSOLE_DB_PASSWORD`, then `LOAD_DEMO_DATA=false`.
- **Managed** (Neon, RDS…): create the database, then apply `database/schema.sql` and `database/functions.sql`. Create the read-only role `ops_console` (see `docker/postgres-init/00-offshore-fares.sh`), and use SSL (`PGSSLMODE=require` for the console, *SSL: require* in the n8n Postgres credential).
- Set up backups / point-in-time recovery.
- ✔ Check: `npm run test:sql` (runs in a rolled-back transaction, so it doesn't touch data).

## 3. Configure HTTPS
- Put n8n and the console behind a reverse proxy (Caddy, Nginx, Traefik) with TLS certificates.
- `.env`: `N8N_PROTOCOL=https`, `N8N_HOST=n8n.your-domain.com`, `N8N_WEBHOOK_URL=https://n8n.your-domain.com/`.
- Expose only 443. PostgreSQL stays on `127.0.0.1` (default in `docker-compose.yml`).
- ✔ Check: `https://n8n.your-domain.com/healthz/readiness` returns 200.

## 4. Configure n8n
- `.env`: `N8N_ENCRYPTION_KEY` = 32+ random characters. **Back it up**: without it, the stored credentials can't be decrypted.
- `OPS_API_TOKEN` = 32+ random characters (shared by the console and the operator webhooks).
- Using your own existing n8n instead of the bundled one: add the variables of `x-business-env` from `docker-compose.yml`, plus `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
- ✔ Check: `npm run config:check`.

## 5. Import the workflows
- Bundled n8n: `docker compose up -d`. The `n8n-init` container imports the 18 workflows with their fixed IDs and publishes them (first start ≈ 6–9 min).
- Your own n8n (shell access): `n8n import:workflow --separate --input=n8n/`, then `n8n publish:workflow --id=<id>` for each file. The IDs must be kept, because workflows call each other by ID.
- ✔ Check: `npm run verify` → *Workflow validation (deployed = repository)* = PASS.

## 6. Configure the OpenAI credential
- `.env`: `OPENAI_API_KEY`, `AI_PROVIDER=openai`, `OPENAI_MODEL` (any model with Structured Outputs; default `gpt-4.1-mini`, defined only in `lib/config.js`).
- Re-create the credential: `docker compose run --rm -e N8N_FORCE_REIMPORT=true n8n-init`, or edit **OpenAI (Offshore Fares)** in n8n → Credentials.
- ✔ Check: `npm run smoke:openai`, then `npm run smoke:openai:stack` (full pipeline through n8n, `extraction_meta.source = openai`).

## 7. Configure Gmail OAuth
1. In the Google Cloud console, create an OAuth client (*Web application*) with the redirect URI `https://n8n.your-domain.com/rest/oauth2-credential/callback`, and enable the Gmail API.
2. `.env`: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, then re-run the init (step 6).
3. In n8n → Credentials → **Gmail (Offshore Fares)** → *Connect my account*, sign in with the shared mailbox.
4. In **WF01_EMAIL_INTAKE**, enable the *Gmail Trigger* node, adjust the search query (`in:inbox -from:me`), then publish.
- ✔ Check: send a test email from a known agent address; it shows up in the console queue.

## 8. Configure WhatsApp Business Cloud
1. In Meta Business Manager: WhatsApp product, phone number, **permanent system-user token**, app secret.
2. `.env`: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION`.
3. Create and get approval for the follow-up template `WHATSAPP_FOLLOWUP_TEMPLATE` (2 body parameters: first name, RFQ number). Templates are mandatory outside the 24-hour window.
- ✔ Check: `npm run config:check` (all 4 WhatsApp variables required together).

## 9. Configure the webhook URL in Meta
- Callback URL: `https://n8n.your-domain.com/webhook/whatsapp`
- Verify token: `WHATSAPP_VERIFY_TOKEN`. Subscribe to the **messages** field.
- ✔ Check: Meta shows *Verified*; a message to the business number appears in the queue; a forged POST without a signature gets **401**.

## 10. Disable DEMO_MODE
- `.env`: `DEMO_MODE=false`, `LOAD_DEMO_DATA=false`, `CONSOLE_USER`, `CONSOLE_PASSWORD` (12+ characters), `REQUIRE_HUMAN_APPROVAL=true`.
- Starting from a demo database? Start from a fresh volume (`docker compose down -v` **before** any real data) or delete the demo rows (`database/reset_demo.sql` without the seed include).
- `docker compose up -d`. If anything is unsafe, `n8n-init` or the console stops with a clear message.
- ✔ Check: the console asks for a login; `/api/demo/email` and `/api/fare-desk/mock` return 403.

## 11. Configure the fare desk
- Replace the fictional desks/operators with the real team (`desks`, `operators` tables), and add the real agencies and contacts (`agencies`, `contacts`, with `email_domain` and `whatsapp_phone` in digits only).
- Adjust SLAs (`SLA_*_MINUTES`), follow-ups (`FOLLOWUP_*`), priorities (`PRIORITY_RULES_JSON`) and `BUSINESS_TIMEZONE`.
- Fares are entered through the console (Mock Fare Desk form = manual provider) until a GDS adapter is connected (see `docs/future-integrations.md`).
- ✔ Check: the routing table in `docs/business-process.md` matches the real organisation.

## 12. Run the smoke tests
```bash
npm run config:check
npm run verify -- --no-e2e     # lint, build, config, secrets, unit, stack health, deployed workflows, SQL
npm run smoke:openai
npm run smoke:openai:stack
```
In production the E2E suite is **not** run (it needs DEMO_MODE). Validate one real email and one real WhatsApp conversation end to end with a friendly agency instead.

## 13. Enable production workflows
- All 18 workflows are published by the init. Enable the **Gmail Trigger** (step 7), then check *Executions* in n8n for errors during the first hours.
- Monitor the console Desk Inbox (SLA breaches, delivery failures, workflow errors), *Activity → dead letters*, and `docker compose ps` (all services *healthy*).
- Keep `REQUIRE_HUMAN_APPROVAL=true` until the team trusts the quotes.

## Rollback
`DEMO_MODE` can't be switched back on a production database without deleting real data, so use a separate staging stack for demos. Workflow regressions: `npm run workflows:reimport` restores the versions from the repository.
