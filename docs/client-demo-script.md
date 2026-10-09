# Client demo script (5–10 minutes)

**Audience:** Offshore Fares management and operations. **Story:** Apex Travel · John Carter · 3 Business Class Mumbai → London, 17–25 Nov 2026, Qatar preferred, urgent.
**Before the call:** `npm run demo:reset` (or rehearse with `npm run demo:step`), open the console (Dashboard) and n8n (WF06 canvas) in two tabs, and set `AI_PROVIDER=openai` with a valid key.

---

### 1. Problem (45 s)
> "Your desk receives fare requests from agents by email and WhatsApp, often in pieces: '3 pax', '17 Nov', 'return 25th'. Someone has to read each one, work out the itinerary, chase missing details, pass it to the right person, re-type the fares into an email and a WhatsApp, remember to follow up… and nothing tells you which requests are waiting too long."

### 2. Before automation (30 s)
Show the **Desk Inbox / Queue** briefly: *"This is what a normal day looks like: 30 requests in every stage. Today this lives in mailboxes and phones."*

### 3. Incoming request (45 s)
Simulator → **Scenario 1**. Read the email aloud. *"An unstructured email, exactly as an agent writes it."*

### 4. AI extraction (1 min)
Open the RFQ. Point at: route BOM → LHR, return trip, 3 adults, Business, 17 → 25 Nov, Qatar + Emirates, ±1 day, urgent.
> "The AI reads the request, but it can't make things up: every value must appear in the message. If a date is vague, like 'next week', we ask instead of guessing."
Optionally send **Scenario 2** and show the one-line clarification.

### 5. RFQ creation, priority and routing (45 s)
Point at `OFF-RFQ-2026-…`, **HIGH** priority (show the score breakdown in the audit trail: Business, 3 premium pax, VIP agency, urgent), assigned to the **Premium Desk**, and the acknowledgement in the **Outbox**.
> "The agent immediately gets a reference and a recap, so if we misunderstood something, they can correct it within seconds."

### 6. Fare desk (1 min)
**Load sample fares → Submit.**
> "Fares only come from your desk (today by entry, tomorrow from Amadeus/Sabre/NDC). The AI never sets a price."
Show the validation by submitting a broken option (missing penalty → rejected).

### 7. Quote generation (45 s)
Show the email and WhatsApp tabs.
> "Same quote, two formats: professional email, compact WhatsApp. Every number is checked after the AI writes the text; if it changes 2,450 into 2,400, the text is rejected and our template is used."

### 8. Human approval (45 s)
Click **Approve & send**. Show the approval record: who, when, version, content hash.
> "Nothing commercial leaves without a human click, and you know exactly what was approved."

### 9. Client delivery (30 s)
Outbox: the quote was sent **in the same email thread** the agent used. *"If the agent wrote on WhatsApp, the reply goes on WhatsApp, never both."*

### 10. Follow-up (30 s)
Simulator → **Follow-ups as if +5 h later** on the seeded quotes.
> "Polite reminders at 4 h and 24 h, never after a reply or a booking, never presenting an expired fare as valid."

### 11. Booking handoff (1 min)
On the RFQ: **"Option 2 works. Please proceed."** → **BOOKING REQUESTED**, OPT-002 highlighted, handoff card, Ticketing Desk task.
> "The system doesn't issue tickets. It hands your ticketing team a complete, structured summary."
Optionally show **"go ahead"** on another quote → *"which option?"*

### 12. Dashboard (45 s)
Requests today, statuses, SLA breaches, average first response, quote-to-booking conversion, channels, cabins, routes, agencies.
Optionally: Simulator → **Scenario 7** (*change tomorrow's flight* → CRITICAL, Ticketing) and **Scenario 8** (prompt injection → security task, no answer).

### 13. Business impact (30 s)
Less manual reading and typing, faster first response, no forgotten requests, unified email + WhatsApp, automatic follow-ups, SLA visibility, complete audit trail, and AI under human control.

### 14. Future expansion (30 s)
CRM and agency memory → GDS/NDC search and revalidation → analytics → an operations copilot ("which quotes are waiting for a reply?") → limited booking automation with strict controls.
Close with the questions in [CLIENT_CONFIGURATION.md](CLIENT_CONFIGURATION.md).
