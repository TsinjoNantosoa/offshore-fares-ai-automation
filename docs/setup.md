# Setup (local)

> Production deployment: see [PRODUCTION_SETUP.md](PRODUCTION_SETUP.md).

## 1. Local demo (5 minutes of work, ~6 minutes of waiting)

```bash
git clone <repo> offshore-fares-ai-automation && cd offshore-fares-ai-automation
cp .env.example .env
```
Edit `.env`:

| Variable | Value |
|---|---|
| `N8N_ENCRYPTION_KEY` | long random string (keep it: it decrypts the stored credentials) |
| `POSTGRES_PASSWORD`, `CONSOLE_DB_PASSWORD`, `OPS_API_TOKEN` | random values |
| `OPENAI_API_KEY` | your key, **or** leave it empty and set `AI_PROVIDER=rules` for an offline demo |
| `WHATSAPP_VERIFY_TOKEN` | any string (used for the Meta handshake) |

```bash
docker compose up -d
docker compose logs -f n8n-init     # imports credentials + 18 workflows, then publishes them (first start only)
```
Then open:
- **Ops console**: http://localhost:3000
- **n8n**: http://localhost:5678 (create the owner account on first visit; the workflows are already active)

Useful commands:

| Command | Effect |
|---|---|
| `npm run demo` | start if needed, reset demo data, play the client story ([DEMO.md](DEMO.md)) |
| `npm run demo:reset` | restore the demo data in seconds (n8n untouched) |
| `npm run demo:rebuild` | wipe volumes, rebuild, reload demo data (≈ 6–9 min) |
| `npm run verify` | master verification (PASS / FAIL table) |
| `npm run config:check` | validate `.env` with the production rules |
| `npm run workflows:reimport` | rebuild `n8n/*.json` from `lib/` + `prompts/`, re-import, restart n8n |
| `npm test` · `npm run test:sql` · `npm run test:e2e` | unit / SQL API / end-to-end tests |
| `npm run build:seed` | regenerate demo data (dates relative to now) |

`N8N_FORCE_REIMPORT=true` in `.env` forces the import on the next `docker compose up`.

## 2. OpenAI
1. Put the key in `.env` (`OPENAI_API_KEY`) and set `AI_PROVIDER=openai`.
2. `docker compose run --rm -e N8N_FORCE_REIMPORT=true n8n-init && docker compose up -d n8n` (re-creates the credential and reloads `AI_PROVIDER`), then `npm run smoke:openai`.
   Or edit the **OpenAI (Offshore Fares)** credential directly in n8n → *Credentials*.
3. `OPENAI_MODEL` accepts any model that supports Structured Outputs (`json_schema`). For reasoning models (`gpt-5*`, `o*`) temperature is omitted automatically.

The key is only read by the one-shot init container and stored encrypted by n8n. It never appears in the workflow JSON, in the n8n worker environment, or in logs.

## 3. Gmail (shared inbox)
1. Google Cloud console → OAuth client (type *Web application*), redirect URI `http(s)://<n8n-host>/rest/oauth2-credential/callback`, Gmail API enabled.
2. `.env`: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, then re-run the init (step 2.2 above).
3. n8n → Credentials → **Gmail (Offshore Fares)** → *Connect my account* (sign in with the shared mailbox).
4. Open **WF01_EMAIL_INTAKE** → enable the **Gmail Trigger** node → publish. Adjust the search filter (`in:inbox -from:me`) and labels to the mailbox rules.
5. Set `DEMO_MODE=false` to really send replies (WF12 replies in the original thread when it knows it).

## 4. WhatsApp Business Cloud API
1. Meta Business Manager → WhatsApp → app with the *WhatsApp* product, phone number, **permanent system-user token**.
2. `.env`: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`.
3. Expose n8n over **HTTPS** (reverse proxy / tunnel) and configure the webhook in Meta:
   - Callback URL: `https://<n8n-host>/webhook/whatsapp`
   - Verify token: `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to `messages`.
4. Create and get approval for a **template** for follow-ups outside the 24 h window (name = `WHATSAPP_FOLLOWUP_TEMPLATE`, 2 body parameters: first name, RFQ number).
5. `DEMO_MODE=false`. From then on, the signature is mandatory and unsigned webhooks are rejected with 401.

## 5. Production checklist
- HTTPS everywhere, n8n behind a reverse proxy, console behind SSO or basic auth (`CONSOLE_USER/PASSWORD`).
- Managed PostgreSQL with backups and PITR; n8n in queue mode (Redis + workers) for volume.
- n8n external secrets (Vault / AWS Secrets Manager) instead of env-based bootstrap.
- `DEMO_MODE=false`, `LOAD_DEMO_DATA=false`, real agencies/contacts imported, real desks/operators.
- Monitoring: alert on `alerts` (CRITICAL), `workflow_errors`, dead letters; n8n execution retention.
- Data retention policy for messages (see [security.md](security.md)).

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `The requested webhook ... is not registered` right after start | n8n is still activating workflows: wait for `Finished building workflow dependency index` in `docker compose logs n8n` |
| AI fields come from `rules` | `AI_PROVIDER=rules`, missing or invalid key, or an OpenAI error (see `extraction_meta.ai_error` on the RFQ) |
| Quote delivery `FAILED` | Outbox / RFQ page shows the error; fix the credential, then **Retry quote delivery** (RFQ stays `APPROVED`) |
| Message in dead letter | Console → Activity → **Retry** after fixing the cause |
| Port already in use | change `N8N_PORT`, `CONSOLE_PORT`, `POSTGRES_PORT` in `.env` |
