-- =============================================================================
-- Offshore Fares — AI Travel Operations Orchestrator
-- PostgreSQL schema (tables, constraints, indexes, views)
--
-- Business logic that must be transactional (idempotency, state machine,
-- locking, versioning) lives in database/functions.sql.
-- Applied automatically by docker-compose (docker-entrypoint-initdb.d).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------
CREATE TABLE rfq_statuses (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  stage       text NOT NULL,              -- INTAKE | FARE_DESK | QUOTE | CLIENT | BOOKING | AFTER_SALES | END
  is_terminal boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL
);

CREATE TABLE rfq_status_transitions (
  from_status text NOT NULL REFERENCES rfq_statuses(code),
  to_status   text NOT NULL REFERENCES rfq_statuses(code),
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE desks (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  email       text,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE operators (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  desk_code  text NOT NULL REFERENCES desks(code),
  full_name  text NOT NULL,
  email      text UNIQUE,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Customers: agencies and their travel agents (contacts)
-- -----------------------------------------------------------------------------
CREATE TABLE agencies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  code              text NOT NULL UNIQUE,
  email_domain      text UNIQUE,
  phone             text,
  country           char(2),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ON_HOLD', 'SUSPENDED')),
  priority_level    text NOT NULL DEFAULT 'STANDARD' CHECK (priority_level IN ('STANDARD', 'VIP')),
  preferred_channel text CHECK (preferred_channel IN ('email', 'whatsapp')),
  notes             text,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id            uuid REFERENCES agencies(id),
  first_name           text,
  last_name            text,
  email                text,
  phone                text,
  whatsapp_phone       text,             -- digits only, E.164 without "+"
  preferred_channel    text CHECK (preferred_channel IN ('email', 'whatsapp')),
  verification_status  text NOT NULL DEFAULT 'VERIFIED' CHECK (verification_status IN ('VERIFIED', 'UNVERIFIED')),
  opted_out_followups  boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_email_uq ON contacts (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX contacts_whatsapp_uq ON contacts (whatsapp_phone) WHERE whatsapp_phone IS NOT NULL;
CREATE INDEX contacts_agency_idx ON contacts (agency_id);

-- -----------------------------------------------------------------------------
-- Conversations and messages (channel-independent)
-- -----------------------------------------------------------------------------
CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel            text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  external_thread_id text NOT NULL,      -- Gmail threadId or WhatsApp wa_id
  contact_id         uuid REFERENCES contacts(id),
  agency_id          uuid REFERENCES agencies(id),
  subject            text,
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  locked_until       timestamptz,        -- per-conversation processing lock (ordering + no race on RFQ creation)
  locked_by          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_thread_id)
);
CREATE INDEX conversations_contact_idx ON conversations (contact_id);

CREATE TABLE rfq_counters (
  year       int PRIMARY KEY,
  last_value int NOT NULL DEFAULT 0
);

CREATE TABLE rfqs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_number            text NOT NULL UNIQUE CHECK (rfq_number ~ '^OFF-RFQ-[0-9]{4}-[0-9]{6}$'),
  agency_id             uuid REFERENCES agencies(id),
  contact_id            uuid REFERENCES contacts(id),
  conversation_id       uuid REFERENCES conversations(id),
  related_rfq_id        uuid REFERENCES rfqs(id),
  intent                text NOT NULL,
  trip_type             text CHECK (trip_type IN ('ONE_WAY', 'ROUND_TRIP', 'MULTI_CITY', 'UNKNOWN')),
  cabin                 text CHECK (cabin IN ('ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST', 'UNKNOWN')),
  origin_iata           text,
  destination_iata      text,
  departure_date        date,
  return_date           date,
  adults                int CHECK (adults IS NULL OR adults BETWEEN 0 AND 99),
  children              int NOT NULL DEFAULT 0,
  infants               int NOT NULL DEFAULT 0,
  preferred_airlines    text[] NOT NULL DEFAULT '{}',
  requirements          jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_fields        text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL REFERENCES rfq_statuses(code),
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  priority_score        int NOT NULL DEFAULT 0 CHECK (priority_score BETWEEN 0 AND 100),
  priority_level        text NOT NULL DEFAULT 'LOW' CHECK (priority_level IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
  priority_breakdown    jsonb,
  assigned_team         text REFERENCES desks(code),
  assigned_user         uuid REFERENCES operators(id),
  source_channel        text CHECK (source_channel IN ('email', 'whatsapp', 'manual')),
  requires_human        boolean NOT NULL DEFAULT false,
  human_review_reason   text,
  sla_breached          boolean NOT NULL DEFAULT false,
  security_flags        text[] NOT NULL DEFAULT '{}',
  classification        jsonb,
  extraction_meta       jsonb,
  clarification_due_at  timestamptz,
  clarification_count   int NOT NULL DEFAULT 0,
  last_clarification_key text,
  selected_option_id    uuid,
  requires_fare_recheck boolean NOT NULL DEFAULT false,
  booking_reference     text,
  after_sales_type      text CHECK (after_sales_type IN ('CHANGE', 'CANCELLATION', 'REFUND')),
  handoff               jsonb,
  is_demo               boolean NOT NULL DEFAULT false,
  first_response_at     timestamptz,
  quoted_at             timestamptz,
  booking_requested_at  timestamptz,
  closed_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rfqs_status_idx ON rfqs (status, status_changed_at);
CREATE INDEX rfqs_conversation_idx ON rfqs (conversation_id, updated_at DESC);
CREATE INDEX rfqs_contact_idx ON rfqs (contact_id, updated_at DESC);
CREATE INDEX rfqs_agency_idx ON rfqs (agency_id);
CREATE INDEX rfqs_created_idx ON rfqs (created_at DESC);
CREATE INDEX rfqs_booking_ref_idx ON rfqs (booking_reference) WHERE booking_reference IS NOT NULL;
CREATE INDEX rfqs_clarification_due_idx ON rfqs (clarification_due_at) WHERE clarification_due_at IS NOT NULL;

CREATE TABLE rfq_segments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id           uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  seq              int NOT NULL,
  origin_iata      text,
  destination_iata text,
  departure_date   date,
  UNIQUE (rfq_id, seq)
);

-- Passenger counts per type. No names, passport or payment data are stored (POC – see docs/security.md).
CREATE TABLE rfq_passengers (
  rfq_id   uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  pax_type text NOT NULL CHECK (pax_type IN ('ADT', 'CHD', 'INF')),
  count    int NOT NULL CHECK (count >= 0),
  PRIMARY KEY (rfq_id, pax_type)
);

CREATE TABLE rfq_status_history (
  id          bigserial PRIMARY KEY,
  rfq_id      uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor_type  text NOT NULL,
  actor_id    text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rfq_status_history_rfq_idx ON rfq_status_history (rfq_id, created_at);

CREATE TABLE messages (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         uuid NOT NULL REFERENCES conversations(id),
  rfq_id                  uuid REFERENCES rfqs(id),
  channel                 text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  direction               text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  external_message_id     text,
  sender                  text,
  recipient               text,
  subject                 text,
  content                 text NOT NULL DEFAULT '',
  content_raw             text,
  kind                    text,          -- OUTBOUND: ACK | CLARIFICATION | QUOTE | FOLLOWUP | CONFIRMATION_QUESTION | BOOKING_ACK | AFTER_SALES_ACK | OPT_OUT_ACK
  in_reply_to             text,
  attachments             jsonb NOT NULL DEFAULT '[]'::jsonb,
  referenced_rfq_numbers  text[] NOT NULL DEFAULT '{}',
  security_flags          text[] NOT NULL DEFAULT '{}',
  classification          jsonb,
  received_at             timestamptz,
  sent_at                 timestamptz,
  processed_at            timestamptz,
  processing_status       text NOT NULL DEFAULT 'PENDING'
                          CHECK (processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED', 'DEAD_LETTER', 'SENT')),
  processing_execution_id text,
  processing_started_at   timestamptz,
  retry_count             int NOT NULL DEFAULT 0,
  next_retry_at           timestamptz,
  processing_notes        jsonb,
  delivery_status         text CHECK (delivery_status IN ('SIMULATED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  delivery_error          text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: the same inbound email / WhatsApp message can never be stored (and processed) twice.
CREATE UNIQUE INDEX messages_inbound_external_uq ON messages (channel, external_message_id) WHERE direction = 'INBOUND';
CREATE INDEX messages_outbound_external_idx ON messages (external_message_id) WHERE direction = 'OUTBOUND';
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_rfq_idx ON messages (rfq_id, created_at);
CREATE INDEX messages_pending_idx ON messages (processing_status, created_at) WHERE processing_status IN ('PENDING', 'FAILED', 'PROCESSING');

-- -----------------------------------------------------------------------------
-- Fares, quotes, approvals
-- -----------------------------------------------------------------------------
CREATE TABLE fare_options (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id                 uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  batch_no               int NOT NULL,
  option_no              int NOT NULL,
  option_code            text NOT NULL CHECK (option_code ~ '^OPT-[0-9]{3}$'),
  airline                text NOT NULL,
  flight_segments        jsonb NOT NULL DEFAULT '[]'::jsonb,
  departure_at           timestamp,
  arrival_at             timestamp,
  return_departure_at    timestamp,
  total_duration_minutes int,
  stops                  int,
  cabin                  text NOT NULL,
  fare_amount            numeric(12, 2) NOT NULL CHECK (fare_amount > 0),
  fare_currency          char(3) NOT NULL,
  fare_basis             text NOT NULL DEFAULT 'PER_PASSENGER' CHECK (fare_basis IN ('PER_PASSENGER', 'TOTAL')),
  baggage                text NOT NULL,
  change_penalty         text NOT NULL,
  refund_penalty         text NOT NULL,
  fare_valid_until       timestamptz NOT NULL,
  source                 text NOT NULL CHECK (source IN ('MANUAL', 'MOCK', 'GDS', 'NDC', 'CONSOLIDATOR')),
  verified               boolean NOT NULL DEFAULT true,
  entered_by             text,
  notes                  text,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, batch_no, option_no)
);
CREATE INDEX fare_options_active_idx ON fare_options (rfq_id) WHERE is_active;
ALTER TABLE rfqs ADD CONSTRAINT rfqs_selected_option_fk FOREIGN KEY (selected_option_id) REFERENCES fare_options(id);

CREATE TABLE quotes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id            uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  version           int NOT NULL,
  status            text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'SENT', 'EXPIRED')),
  email_subject     text NOT NULL,
  email_body        text NOT NULL,
  whatsapp_body     text NOT NULL,
  quote_model       jsonb NOT NULL,       -- structured data the texts were generated from
  generated_by      text NOT NULL CHECK (generated_by IN ('AI', 'TEMPLATE', 'HUMAN_EDIT')),
  ai_model          text,
  validation        jsonb,
  content_hash      text NOT NULL,
  edited_from       uuid REFERENCES quotes(id),
  valid_until       timestamptz,
  approved_by       text,
  approved_at       timestamptz,
  sent_at           timestamptz,
  delivery_channel  text,
  delivery_status   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, version)
);
CREATE INDEX quotes_rfq_idx ON quotes (rfq_id, version DESC);

CREATE TABLE quote_options (
  quote_id       uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  fare_option_id uuid NOT NULL REFERENCES fare_options(id),
  display_order  int NOT NULL,
  PRIMARY KEY (quote_id, fare_option_id)
);

CREATE TABLE approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id         uuid NOT NULL REFERENCES quotes(id),
  rfq_id           uuid NOT NULL REFERENCES rfqs(id),
  quote_version    int NOT NULL,
  action           text NOT NULL CHECK (action IN ('APPROVE', 'EDIT', 'REJECT', 'AUTO_APPROVE')),
  approval_status  text NOT NULL CHECK (approval_status IN ('APPROVED', 'EDITED', 'REJECTED')),
  approved_by      text NOT NULL,
  approved_at      timestamptz NOT NULL DEFAULT now(),
  approval_note    text,
  content_hash     text NOT NULL,         -- SHA-256 of the exact texts approved
  content_snapshot jsonb NOT NULL
);
CREATE INDEX approvals_rfq_idx ON approvals (rfq_id, approved_at);
-- A quote version can be approved only once (protects against double-click / replayed approval webhooks).
CREATE UNIQUE INDEX approvals_one_approval_per_quote_uq ON approvals (quote_id) WHERE action IN ('APPROVE', 'AUTO_APPROVE');

-- -----------------------------------------------------------------------------
-- Operations: assignments, follow-ups, alerts
-- -----------------------------------------------------------------------------
CREATE TABLE assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id        uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  desk_code     text NOT NULL REFERENCES desks(code),
  operator_id   uuid REFERENCES operators(id),
  rule          text,
  assigned_by   text NOT NULL DEFAULT 'SYSTEM',
  is_current    boolean NOT NULL DEFAULT true,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz
);
CREATE UNIQUE INDEX assignments_current_uq ON assignments (rfq_id) WHERE is_current;

CREATE TABLE followups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id        uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  quote_id      uuid NOT NULL REFERENCES quotes(id),
  sequence_no   int NOT NULL,
  status        text NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  channel       text,
  quote_expired boolean NOT NULL DEFAULT false,
  message_id    uuid REFERENCES messages(id),
  sent_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, quote_id, sequence_no)
);

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid REFERENCES rfqs(id) ON DELETE CASCADE,
  alert_type  text NOT NULL CHECK (alert_type IN ('SLA_BREACH', 'DESK_NOTIFICATION', 'HUMAN_REVIEW', 'RECHECK_FARE', 'SECURITY', 'WORKFLOW_ERROR', 'DELIVERY_FAILED')),
  severity    text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  desk_code   text REFERENCES desks(code),
  title       text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  text UNIQUE,                -- prevents repeated alerts for the same event
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text
);
CREATE INDEX alerts_open_idx ON alerts (status, created_at DESC);
CREATE INDEX alerts_rfq_idx ON alerts (rfq_id);

-- -----------------------------------------------------------------------------
-- Observability: audit trail, structured workflow events, errors
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  rfq_id      uuid REFERENCES rfqs(id) ON DELETE CASCADE,
  action      text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('SYSTEM', 'AI', 'HUMAN', 'CLIENT')),
  actor_id    text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_rfq_idx ON audit_logs (rfq_id, created_at);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

CREATE TABLE workflow_events (
  id              bigserial PRIMARY KEY,
  workflow        text NOT NULL,
  execution_id    text,
  rfq_id          uuid REFERENCES rfqs(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      uuid,
  event           text NOT NULL,
  status          text NOT NULL DEFAULT 'OK' CHECK (status IN ('OK', 'SKIPPED', 'WARN', 'ERROR')),
  duration_ms     int,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_events_created_idx ON workflow_events (created_at DESC);
CREATE INDEX workflow_events_rfq_idx ON workflow_events (rfq_id, created_at);

CREATE TABLE workflow_errors (
  id             bigserial PRIMARY KEY,
  workflow_id    text,
  workflow_name  text,
  execution_id   text,
  node           text,
  error_message  text,
  error_details  jsonb,
  message_id     uuid,
  retryable      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_errors_created_idx ON workflow_errors (created_at DESC);

-- -----------------------------------------------------------------------------
-- Knowledge base (non-sensitive procedures / FAQ). Never used for fares or rules.
-- -----------------------------------------------------------------------------
CREATE TABLE knowledge_base (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  title      text NOT NULL,
  category   text NOT NULL,
  content    text NOT NULL,
  keywords   text NOT NULL DEFAULT '',
  search     tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, title || ' ' || content || ' ' || keywords)) STORED,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_base_search_idx ON knowledge_base USING gin (search);

-- -----------------------------------------------------------------------------
-- Reference rows
-- -----------------------------------------------------------------------------
INSERT INTO rfq_statuses (code, label, stage, is_terminal, sort_order) VALUES
  ('NEW', 'Request arrived', 'INTAKE', false, 10),
  ('NEEDS_INFORMATION', 'Waiting for missing details', 'INTAKE', false, 20),
  ('READY_FOR_SEARCH', 'Ready for fare search', 'FARE_DESK', false, 30),
  ('ASSIGNED', 'Assigned to fare desk', 'FARE_DESK', false, 40),
  ('SEARCHING', 'Fare desk searching', 'FARE_DESK', false, 50),
  ('FARES_FOUND', 'Fares received', 'QUOTE', false, 60),
  ('PENDING_APPROVAL', 'Waiting for approval', 'QUOTE', false, 70),
  ('APPROVED', 'Quote approved', 'QUOTE', false, 80),
  ('QUOTED', 'Quote sent', 'CLIENT', false, 90),
  ('AWAITING_CLIENT', 'Waiting for agent reply', 'CLIENT', false, 100),
  ('CLIENT_INTERESTED', 'Agent interested / on hold', 'CLIENT', false, 110),
  ('BOOKING_REQUESTED', 'Booking requested', 'BOOKING', false, 120),
  ('TICKETING', 'Ticketing in progress', 'BOOKING', false, 130),
  ('TICKETED', 'Ticketed', 'BOOKING', false, 140),
  ('CHANGE_REQUESTED', 'Change requested', 'AFTER_SALES', false, 150),
  ('REFUND_REQUESTED', 'Refund / cancellation requested', 'AFTER_SALES', false, 160),
  ('CANCELLED', 'Cancelled', 'END', true, 170),
  ('LOST', 'Lost', 'END', true, 180),
  ('CLOSED', 'Closed', 'END', true, 190),
  ('ERROR', 'Error – needs attention', 'END', false, 200);

-- Must stay identical to lib/stateMachine.js (checked by tests/unit/schema-sync.test.js)
INSERT INTO rfq_status_transitions (from_status, to_status) VALUES
  ('NEW', 'NEEDS_INFORMATION'), ('NEW', 'READY_FOR_SEARCH'), ('NEW', 'CHANGE_REQUESTED'), ('NEW', 'REFUND_REQUESTED'), ('NEW', 'CANCELLED'), ('NEW', 'CLOSED'), ('NEW', 'ERROR'),
  ('NEEDS_INFORMATION', 'READY_FOR_SEARCH'), ('NEEDS_INFORMATION', 'CANCELLED'), ('NEEDS_INFORMATION', 'LOST'), ('NEEDS_INFORMATION', 'CLOSED'), ('NEEDS_INFORMATION', 'ERROR'),
  ('READY_FOR_SEARCH', 'ASSIGNED'), ('READY_FOR_SEARCH', 'NEEDS_INFORMATION'), ('READY_FOR_SEARCH', 'CANCELLED'), ('READY_FOR_SEARCH', 'CLOSED'), ('READY_FOR_SEARCH', 'ERROR'),
  ('ASSIGNED', 'SEARCHING'), ('ASSIGNED', 'READY_FOR_SEARCH'), ('ASSIGNED', 'NEEDS_INFORMATION'), ('ASSIGNED', 'CANCELLED'), ('ASSIGNED', 'CLOSED'), ('ASSIGNED', 'ERROR'),
  ('SEARCHING', 'FARES_FOUND'), ('SEARCHING', 'NEEDS_INFORMATION'), ('SEARCHING', 'READY_FOR_SEARCH'), ('SEARCHING', 'CANCELLED'), ('SEARCHING', 'LOST'), ('SEARCHING', 'ERROR'),
  ('FARES_FOUND', 'PENDING_APPROVAL'), ('FARES_FOUND', 'APPROVED'), ('FARES_FOUND', 'SEARCHING'), ('FARES_FOUND', 'CANCELLED'), ('FARES_FOUND', 'ERROR'),
  ('PENDING_APPROVAL', 'APPROVED'), ('PENDING_APPROVAL', 'SEARCHING'), ('PENDING_APPROVAL', 'FARES_FOUND'), ('PENDING_APPROVAL', 'CANCELLED'), ('PENDING_APPROVAL', 'ERROR'),
  ('APPROVED', 'QUOTED'), ('APPROVED', 'PENDING_APPROVAL'), ('APPROVED', 'SEARCHING'), ('APPROVED', 'ERROR'),
  ('QUOTED', 'AWAITING_CLIENT'), ('QUOTED', 'ERROR'),
  ('AWAITING_CLIENT', 'CLIENT_INTERESTED'), ('AWAITING_CLIENT', 'BOOKING_REQUESTED'), ('AWAITING_CLIENT', 'READY_FOR_SEARCH'), ('AWAITING_CLIENT', 'NEEDS_INFORMATION'), ('AWAITING_CLIENT', 'CANCELLED'), ('AWAITING_CLIENT', 'LOST'), ('AWAITING_CLIENT', 'CLOSED'), ('AWAITING_CLIENT', 'ERROR'),
  ('CLIENT_INTERESTED', 'BOOKING_REQUESTED'), ('CLIENT_INTERESTED', 'AWAITING_CLIENT'), ('CLIENT_INTERESTED', 'READY_FOR_SEARCH'), ('CLIENT_INTERESTED', 'NEEDS_INFORMATION'), ('CLIENT_INTERESTED', 'CANCELLED'), ('CLIENT_INTERESTED', 'LOST'), ('CLIENT_INTERESTED', 'CLOSED'), ('CLIENT_INTERESTED', 'ERROR'),
  ('BOOKING_REQUESTED', 'TICKETING'), ('BOOKING_REQUESTED', 'AWAITING_CLIENT'), ('BOOKING_REQUESTED', 'READY_FOR_SEARCH'), ('BOOKING_REQUESTED', 'CANCELLED'), ('BOOKING_REQUESTED', 'ERROR'),
  ('TICKETING', 'TICKETED'), ('TICKETING', 'BOOKING_REQUESTED'), ('TICKETING', 'CANCELLED'), ('TICKETING', 'ERROR'),
  ('TICKETED', 'CHANGE_REQUESTED'), ('TICKETED', 'REFUND_REQUESTED'), ('TICKETED', 'CLOSED'),
  ('CHANGE_REQUESTED', 'TICKETING'), ('CHANGE_REQUESTED', 'TICKETED'), ('CHANGE_REQUESTED', 'REFUND_REQUESTED'), ('CHANGE_REQUESTED', 'CANCELLED'), ('CHANGE_REQUESTED', 'CLOSED'), ('CHANGE_REQUESTED', 'ERROR'),
  ('REFUND_REQUESTED', 'CLOSED'), ('REFUND_REQUESTED', 'CANCELLED'), ('REFUND_REQUESTED', 'ERROR'),
  ('CANCELLED', 'CLOSED'),
  ('LOST', 'READY_FOR_SEARCH'), ('LOST', 'CLOSED'),
  ('ERROR', 'NEW'), ('ERROR', 'NEEDS_INFORMATION'), ('ERROR', 'READY_FOR_SEARCH'), ('ERROR', 'ASSIGNED'), ('ERROR', 'SEARCHING'), ('ERROR', 'CANCELLED'), ('ERROR', 'CLOSED');

INSERT INTO desks (code, name, description, email) VALUES
  ('PREMIUM_DESK', 'Premium Desk', 'Business / First / Premium Economy fare searches', 'premium.desk@offshorefares.example'),
  ('GROUP_DESK', 'Group Desk', 'Group requests (10+ passengers)', 'groups@offshorefares.example'),
  ('TICKETING_DESK', 'Ticketing Desk', 'Booking handoff, ticketing, changes and cancellations', 'ticketing@offshorefares.example'),
  ('REFUND_DESK', 'Refund Desk', 'Refund requests and refund quotations', 'refunds@offshorefares.example'),
  ('GENERAL_DESK', 'General Desk', 'Economy requests, payments and general questions', 'desk@offshorefares.example');
