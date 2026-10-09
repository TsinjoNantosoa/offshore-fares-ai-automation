-- V002 – production readiness hardening (idempotent, safe on an existing database).
-- Schema part; the function changes are applied by re-running database/functions.sql (CREATE OR REPLACE).
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_approval_per_quote_uq
  ON approvals (quote_id) WHERE action IN ('APPROVE', 'AUTO_APPROVE');
COMMIT;
