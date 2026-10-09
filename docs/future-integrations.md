# Future integrations & roadmap

## 1. FareProvider adapter (GDS / NDC / consolidator)

```
lib/providers/fareProvider.js
  searchFlights(request)   -> FareOption[]
  getFareRules(option)     -> { change_penalty, refund_penalty, baggage, raw }
  revalidateFare(option)   -> { still_valid, amount, currency, valid_until }
```

| Implementation | State |
|---|---|
| `ManualFareProvider` | ✅ fare desk entry (WF16 `/fare-desk/options`) |
| `MockFareProvider` | ✅ DEMO_MODE sample options (`/fare-desk/mock-options`) |
| `AmadeusFareProvider` (Self-Service / Enterprise Flight Offers Search + Pricing) | placeholder → `FARE_PROVIDER_NOT_CONFIGURED` |
| `SabreFareProvider` (Bargain Finder Max, Revalidate Itinerary) | placeholder |
| `TravelportFareProvider` (JSON Air API) | placeholder |
| NDC / consolidator API | to define with Offshore Fares |

No fake API calls are made. An adapter needs the provider contract, credentials and test environment from Offshore Fares.

**Integration plan**
1. New sub-workflow `WF18_FARE_SEARCH` triggered when an RFQ becomes `ASSIGNED` (opt-in per desk / route).
2. Map RFQ requirements → provider request (origin/destination, dates ± flexibility, pax by type, cabin, preferred/excluded carriers, max stops).
3. Normalise offers → the `fare_options` shape (`source = GDS|NDC`, `verified = false`).
4. The fare desk reviews, verifies and submits through the same `of_save_fare_options`, so every downstream rule (quote check, approval) stays unchanged.
5. `revalidateFare` before approval and at booking handoff (replaces the RECHECK_FARE task).
6. Booking automation (phase 8): PNR creation → payment → ticket issuance, **each step behind an explicit human confirmation**.

## 2. CRM & agency memory (phase 4)
- Sync `agencies` / `contacts` with the CRM (HubSpot, Salesforce, Zoho…).
- Agency profile: preferred airlines, usual cabins, credit status, VIP level → fed into priority and extraction context.
- Conversation history summary per agency for the fare desk.

## 3. Analytics (phase 6)
Conversion by route, agency, cabin, desk and response time; lost-reason analysis; desk workload and SLA compliance; quote-to-ticket revenue (when ticketing data is available).

## 4. AI Operations Copilot (phase 7)
A read-only assistant over the operational data:
- "Show all urgent requests." · "Which quotes are waiting for a response?" · "Which agencies requested Business Class today?" · "Show SLA breaches." · "Which routes have the best conversion?"

Design: natural language → **whitelisted parameterised queries** on views (not free SQL), read-only role, answers with links to RFQs. Built after the core workflow is in production.

## 5. Production architecture
- n8n queue mode (Redis + workers), webhook processors behind a load balancer.
- Managed PostgreSQL (backups, PITR, read replica for analytics).
- n8n external secrets (Vault / AWS Secrets Manager).
- HTTPS, SSO for the console, desk-based permissions.
- Observability: export `workflow_events` / `alerts` to the monitoring stack, with on-call alerts for CRITICAL SLA breaches and dead letters.

## 6. Roadmap

| Phase | Deliverable | Depends on |
|---|---|---|
| 1 | AI intake + RFQ | ✅ POC |
| 2 | Email + WhatsApp omnichannel | Gmail OAuth, Meta WhatsApp account + templates |
| 3 | Fare desk + quote workflow | ✅ POC, desk procedures |
| 4 | CRM + agency memory | CRM access |
| 5 | GDS / NDC integration | provider contract + API credentials |
| 6 | Analytics | 2–3 months of production data |
| 7 | AI Operations Copilot | stable data model |
| 8 | Limited booking automation | GDS booking API, payment process, strict human controls |
