-- =============================================================================
-- DEMO RESET – deletes ALL business data and reloads the fictional demo dataset.
-- Reference data (statuses, transitions, desks) and n8n are not touched.
-- Run through `npm run demo:reset` (refuses when DEMO_MODE=false).
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
TRUNCATE audit_logs, workflow_events, workflow_errors, alerts, followups, approvals, quote_options, quotes,
         assignments, rfq_status_history, rfq_passengers, rfq_segments, messages, fare_options, rfqs,
         conversations, contacts, agencies, operators, knowledge_base, rfq_counters
  RESTART IDENTITY CASCADE;
COMMIT;
\ir seed.sql
SELECT 'demo data restored: ' || (SELECT count(*) FROM rfqs) || ' RFQs, ' || (SELECT count(*) FROM agencies) || ' agencies, ' || (SELECT count(*) FROM contacts) || ' contacts' AS result;
