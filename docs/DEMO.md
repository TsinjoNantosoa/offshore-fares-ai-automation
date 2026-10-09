# Demo

Everything runs locally with `DEMO_MODE=true`: no Gmail, WhatsApp or GDS account needed. Incoming messages go through the **real n8n intake webhooks** in the real Gmail / WhatsApp Cloud API formats. Only outbound sending is simulated (see the console **Outbox**).

## One command

```bash
cp .env.example .env      # first time only: set passwords + OPS_API_TOKEN (any values work locally)
npm run demo              # starts the stack if needed, resets the demo data, plays the client story
```

`npm run demo` prints every milestone of the story and finishes with the link to the RFQ in the console:

```
✔ MESSAGE RECEIVED           email from John Carter (Apex Travel, VIP)
✔ AI CLASSIFIED              NEW_QUOTE (confidence 0.95, openai)
✔ AI EXTRACTED               BOM → LHR · ROUND_TRIP · 3 adults · BUSINESS · 2026-11-17 → 2026-11-25 · Qatar Airways + Emirates
✔ RFQ CREATED                OFF-RFQ-2026-000031
✔ PRIORITY CALCULATED        HIGH (55: BUSINESS +20, MULTI_PAX_PREMIUM +10, VIP_AGENCY +15, EXPLICIT_URGENT +10)
✔ FARE DESK ASSIGNED         Premium Desk · Aisha Khan
✔ FARES ENTERED              1) Qatar Airways USD 2,450 · 2) Emirates USD 2,610 · 3) British Airways USD 2,890
✔ QUOTE GENERATED            v1 · formatted by AI, numbers verified
✔ WAITING FOR APPROVAL       nothing is sent before a human approves
✔ APPROVED                   by Aisha Khan (who / when / content hash stored)
✔ QUOTE SENT                 email · SIMULATED · same thread as John's email
✔ CLIENT SELECTED OPTION 2   OPT-002 · Emirates
✔ BOOKING REQUESTED          no ticket is issued automatically
✔ TICKETING NOTIFIED         Ticketing Desk · Sofia Lindqvist (handoff summary ready)
```

| Command | Use |
|---|---|
| `npm run demo` | full story, automatically (≈ 1 min once the stack is up) |
| `npm run demo:step` | same story, **pauses before each step** (live presentation: press Enter) |
| `npm run demo:reset` | restore the demo data in seconds (RFQs, quotes, statuses, assignments, follow-ups, alerts, audit). n8n is untouched |
| `npm run demo:rebuild` | wipe everything (volumes) and rebuild from scratch (≈ 6–9 min) |
| `npm run stack:up` | start the stack and wait until it is ready |

URLs: **ops console** http://localhost:3000 · **n8n** http://localhost:5678 (create the owner account on first visit).

The AI runs in `AI_PROVIDER=rules` mode (deterministic, offline) unless an OpenAI key is configured. To show real AI: put `OPENAI_API_KEY` in `.env`, set `AI_PROVIDER=openai`, then run `npm run smoke:openai` to check the key and `docker compose run --rm -e N8N_FORCE_REIMPORT=true n8n-init && docker compose up -d n8n` to load the credential.

## Doing the story by hand in the console
1. **Demo Simulator** → *Scenario 1 – complete request* → **Send email**, then click the RFQ link.
2. RFQ page: the journey shows MESSAGE RECEIVED → … → FARE DESK ASSIGNED. Check the requirements card, the AI badge and the audit trail (priority breakdown).
3. **Mock Fare Desk** → *Load sample fares* → *Submit fares & generate quote* → quote v1 (email + WhatsApp tabs).
4. **Approve & send** → the quote appears in the conversation and in the **Outbox**.
5. **Simulate an agent reply** → *Option 2 works. Please proceed.* → BOOKING REQUESTED, OPT-002 highlighted, handoff card, Ticketing Desk task in the **Desk Inbox**.

## The 8 required scenarios

| # | Scenario | How (console) | Expected |
|---|---|---|---|
| 1 | Complete request | Simulator → Scenario 1 | NEW_QUOTE · BOM→LHR · round trip · 3 adults · Business · 17→25 Nov · Qatar + Emirates · HIGH · Premium Desk |
| 2 | Missing data | Simulator → Scenario 2 | NEEDS_INFORMATION · no date invented · one clarification ("next week" + one-way/return) |
| 3 | Multi-message WhatsApp | Simulator → *Send the 5 messages* | ONE RFQ, complete (burst merged, clarification debounced) |
| 4 | Quote | RFQ → Load sample fares → Submit | quote v1 PENDING_APPROVAL, nothing sent |
| 5 | Client selection | reply "Option 2 works. Please proceed." | BOOKING_REQUESTED · OPT-002 · Ticketing Desk |
| 6 | Price objection | on a quoted RFQ reply "Too expensive. Anything cheaper?" | PRICE_CHECK · back to the fare desk · holding reply without a price |
| 7 | Urgent change | Simulator → Scenario 7 | booking K7Q2LM → CHANGE_REQUESTED · CRITICAL · Ticketing Desk |
| 8 | Prompt injection | Simulator → Scenario 8 | OTHER · human task · SECURITY alert · no reply |

Other things to show: "go ahead" with 3 options (→ confirmation question), "STOP" (opt-out), quote **Edit** with a changed price (warning to acknowledge), **Reject**, *Follow-ups as if +5 h later*, SLA monitor, Activity / dead letters.

## Automated proof
```bash
npm run verify     # lint, build, config, secrets, unit, stack health, deployed workflows, SQL,
                   # reset → 16 E2E → reset → 16 E2E, OpenAI smoke (skipped without a key)
npm run test:e2e   # 16 self-contained scenarios; can be re-run without a reset
```
Reports: `tests/e2e/reports/report-<run>.json`.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `webhook … is not registered` / 503 right after start | n8n is still starting; `npm run stack:up` waits until it is really ready |
| The demo story stops at "processing" | `docker compose logs n8n`, console → Activity (workflow errors, dead letters) |
| AI shows "rules fallback" | no / invalid OpenAI key, or `AI_PROVIDER=rules` (expected offline) |
| Data looks messy after many tests | `npm run demo:reset` |
