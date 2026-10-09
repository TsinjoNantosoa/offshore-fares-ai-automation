# Client configuration: information to request from Offshore Fares

Use this checklist in the kick-off call. Each item says **what we need**, **why**, and **where it goes** in the system. Secrets (tokens, passwords, client secrets) must be sent through a password manager or secure vault, **never by email or WhatsApp**.

## 1. Email (Gmail / mailbox)
| Information | Why | Where |
|---|---|---|
| Email platform (Google Workspace, Microsoft 365, other) | Gmail node vs Outlook / IMAP adaptation | WF01 / WF12 |
| Address(es) of the shared inbox(es); one per desk? | intake + reply-from address | Gmail Trigger filter |
| Google Cloud project access (or the admin to create the OAuth client) | OAuth client ID / secret | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` |
| Who signs in the OAuth consent (mailbox owner) | connect the n8n credential | n8n → Credentials |
| Labels / folders and rules (what must be ignored: newsletters, auto-replies) | intake filter | WF01 query |
| Email signature and reply-from name | outbound texts | `COMPANY_SIGNATURE` |

## 2. WhatsApp Business account / Meta Business Manager
| Information | Why | Where |
|---|---|---|
| Are you on the **WhatsApp Business Platform (Cloud API)** or the WhatsApp Business **app**? | the app can't be automated officially and must be migrated to the Cloud API | – |
| Meta Business Manager admin access (or a person who can act) | create the app, system user, token | – |
| **Phone number ID** and WhatsApp Business Account ID | sending endpoint | `WHATSAPP_PHONE_NUMBER_ID` |
| Permanent **system-user access token** | sending | `WHATSAPP_ACCESS_TOKEN` (n8n credential) |
| **App secret** | webhook signature verification | `WHATSAPP_APP_SECRET` |
| Display name, verified business status, messaging tier | volume limits | – |
| Approved **message templates** (follow-up, out-of-hours) | messages outside the 24 h window | `WHATSAPP_FOLLOWUP_TEMPLATE` |
| Opt-in / opt-out policy for agents | compliance | contacts table, "STOP" keyword |

## 3. GDS / fare provider
| Information | Why |
|---|---|
| GDS used: Amadeus, Sabre, Travelport, other | FareProvider adapter |
| NDC / consolidator / airline APIs used | additional adapters |
| API access available? Test environment? Credentials, PCC / office ID | phase 5 integration |
| How fares are found today (terminal, web tools) | manual fare-desk process in the meantime |
| Fare validity rules (ticketing time limits) | `fare_valid_until` |
| Quote format: per passenger or total, taxes included, service fee / markup | quote template |

## 4. CRM and agency data
| Information | Why |
|---|---|
| CRM used (HubSpot, Salesforce, Zoho, spreadsheet…) and API access | agency memory, sync |
| List of agencies: name, email domain(s), phone, country, **VIP level**, preferred channel | `agencies` table, priority |
| List of agents: name, email, WhatsApp number (international format) | `contacts` table (unknown senders are flagged) |
| Credit / payment status per agency (on hold?) | `agencies.status` |

## 5. Operators and desks
| Information | Why |
|---|---|
| Team structure (Premium, Group, Ticketing, Refund, General… or different) | `desks` table |
| Operators per desk (name, email) and working hours | `operators` table, assignment |
| How requests are assigned today (round robin, by agency, by route, by language) | WF09 routing rules |
| Who can approve quotes (all operators or supervisors only)? | approval policy |

## 6. SLAs and business hours
| Information | Why | Where |
|---|---|---|
| Target first response time, time to quote, booking handoff time | SLA thresholds | `SLA_*_MINUTES` |
| Business hours and timezone(s) | SLA and acknowledgements | `BUSINESS_TIMEZONE` |
| Out-of-hours behaviour (on-call desk, auto-reply wording, urgent travel < 24 h) | routing / templates | WF06, WF09 |
| Escalation contacts for CRITICAL requests | alerts | Desk Inbox / notifications |

## 7. Approval policy
| Question | Where |
|---|---|
| Must every quote be approved by a human? Exceptions (e.g. repeat route, small amounts)? | `REQUIRE_HUMAN_APPROVAL` (+ future per-agency rule) |
| Can operators edit quote texts? Who approves an edited price? | WF11 (edits with price changes need an explicit acknowledgement) |
| Mandatory wording / legal disclaimer | `lib/quote.js` template |

## 8. Follow-up policy
| Question | Where |
|---|---|
| When to follow up (hours) and how many times | `FOLLOWUP_1_HOURS`, `FOLLOWUP_2_HOURS`, `MAX_FOLLOWUPS` |
| Tone / languages | `lib/followup.js`, WhatsApp template |
| When to mark a quote as lost | operator action / future rule |

## 9. Booking and ticketing workflow
| Question | Why |
|---|---|
| What happens after "option 2, please proceed" today (who, which tools)? | Ticketing Desk handoff content |
| Passenger data collection (names, passports): which secure channel? | out of scope of the POC; never by email/WhatsApp |
| Payment process (credit line, card link, bank transfer) | out of scope; handoff note |
| Change / cancellation / refund procedure and who quotes penalties | WF15 human tasks |
| PNR / ticket number format and where it is recorded | `MARK_TICKETED` action |

## 10. Volumes and constraints
- Requests per day (average / peak), email vs WhatsApp split, languages used by agents.
- Date convention of agents (day/month), default airports per city (London: LHR only?).
- Data protection requirements (GDPR, DPDP), retention period for messages, hosting region.
- Which requests must **always** involve a human.
