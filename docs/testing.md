# Testing

## Master command

```bash
npm run verify          # everything, ends with a PASS / FAIL table
npm run verify:quick    # no Docker: lint, build, config, secret scan, unit tests
```

| # | Step | What it proves |
|---|---|---|
| 1 | Lint | every JS file parses (`node --check`) |
| 2 | Build | `n8n/*.json` regenerated from `lib/` + `prompts/` (reports when a re-import is needed) |
| 3 | Configuration | `.env` respects the rules of `lib/envCheck.js` (production rules when `DEMO_MODE=false`) |
| 4 | Security scan | no key, token, private key, card number or credential URL in any distributable file; `.env` ignored by git and Docker |
| 5 | Unit tests (71) | business logic + quality gates |
| 6 | Stack health | postgres, n8n and the console are *healthy*; `/ready` = db + n8n |
| 7 | Workflow validation | the 18 workflows deployed in n8n are active **and identical** to `n8n/*.json` |
| 8 | Database tests | SQL API in a rolled-back transaction (17 groups, self-contained test agency) |
| 9 | Demo reset → E2E → demo reset → E2E | 16 scenarios, twice, after a reset each time |
| 10 | OpenAI smoke test | real key: connection, classification, extraction, validation, quote numbers (SKIP without a key) |

## End-to-end scenarios (`npm run test:e2e`)

Every scenario **creates its own state through the real system**: a new email thread, a new WhatsApp number, and its own RFQ, fares, quote and booking. None of them uses a seeded RFQ or depends on another scenario, so they can run in any order (`--only S5,S10`) and the suite can be re-run without a reset.

| # | Scenario | Key assertions |
|---|---|---|
| S1 | Complete email request | NEW_QUOTE, BOM→LHR, round trip, 3 adults, Business, 17→25 Nov, Qatar + Emirates, ±1, **HIGH**, Premium Desk, acknowledgement, journey steps |
| S2 | Idempotency | duplicate email → DUPLICATE; duplicate WhatsApp webhook → stored and processed once |
| S3 | Fares → quote | invalid fares 422; quote PENDING_APPROVAL; `USD 2,450 per passenger` verbatim; nothing sent |
| S4 | **Approval gate** | not approved → no quote, no follow-up, resend refused; approve → sent; duplicate approval refused; duplicate send refused; exactly one quote message |
| S5 | "Option 2 works. Please proceed." | BOOKING_REQUESTED, OPT-002, Ticketing Desk notified, handoff, journey up to TICKETING NOTIFIED |
| S6 | Missing data | NEEDS_INFORMATION, no invented date, one clarification |
| S7 | 5 WhatsApp messages | one consolidated RFQ, complete |
| S8 | Price objection | PRICE_CHECK, back to the desk, no price in the reply, no new quote |
| S9 | "go ahead" (several options) | confirmation question on WhatsApp, no booking |
| S10 | "I need to change tomorrow's flight." | builds its own ticketed booking (PNR) departing tomorrow → CHANGE_REQUESTED, **CRITICAL**, Ticketing Desk, no amount stated |
| S11 | Prompt injection | OTHER + human, no RFQ, SECURITY alert, nothing sent |
| S12 | Reject | SEARCHING, no quote sent |
| S13 | **Anti-hallucination** | quote shows USD 2,450; an edit to 2,400 is flagged and blocks approval until acknowledged; stored fare stays 2450 |
| S14 | Follow-ups + SLA | 1st after 4 h, not repeated, 2nd after 24 h, max 2, none after booking; SLA breach never alerted twice |
| S15 | WhatsApp webhook | verification 200/403, malformed 400 |
| S16 | Security | ops token required (403); console rejects cross-origin and form-encoded writes; security headers; `/ready` |

## Coverage of the required areas

| Area | Where |
|---|---|
| Classification / extraction / dates | `extraction.test.js`, `dates.test.js`, `business-rules.test.js`; E2E S1, S6, S7 |
| Validation / missing fields | unit tests; E2E S3 (422), S6 |
| Priority, routing, SLA | `business-rules.test.js`; E2E S1 (HIGH), S10 (CRITICAL), S14 |
| Status transitions | `router-and-schema.test.js` (JS ⇄ SQL identical); SQL test 5 (DB refuses NEW → TICKETED) |
| Idempotency (email, WhatsApp, approval, send, follow-up) | SQL 1, 3, 10; E2E S2, S4, S14; unique index on approvals |
| Human approval | SQL 8; E2E S3, S4, S12, S13 |
| Anti-hallucination (2450 stays 2450) | `quote-and-replies.test.js` (2450→2400 rejected, invented number, discount, disclaimer); E2E S3, S13; OpenAI smoke step 5 |
| Follow-up safety | `business-rules.test.js`; E2E S4, S14 |
| Prompt injection / secrets | `channels-security.test.js`, `quality-gates.test.js`, `security-scan`; E2E S11 |
| OpenAI failure (timeout, invalid JSON, refusal, secret in output) | `channels-security.test.js` + workflow fallback (E2E runs with `AI_PROVIDER=rules`) |
| Database failure / retries | SQL 15 (retry with backoff → dead letter) |
| Configuration (demo vs production) | `env-check.test.js` |
| WhatsApp | `channels-security.test.js` (parsing, HMAC, 24 h); E2E S9, S15 |

## Real OpenAI

`npm run smoke:openai` checks, with your key and the **same prompts and validations as the workflows**: connection and model, classification (NEW_QUOTE), extraction (BOM/LHR, 3 adults, Business, 17/25 Nov, Qatar, nothing dropped by the guards), priority HIGH, and the quote formatter keeping USD 2,450 verbatim. `npm run smoke:openai:stack` also sends the request through n8n (`AI_PROVIDER=openai`) and checks `extraction_meta.source = openai`. The key is never printed.

## Results

The latest `npm run verify` results are recorded in [READY_FOR_DEMO.md](../READY_FOR_DEMO.md).
