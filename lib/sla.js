'use strict';
/**
 * WF08 – SLA evaluation. Thresholds (minutes) per status are configurable;
 * CRITICAL requests get a tighter SLA (SLA_CRITICAL_FACTOR, default 0.5).
 * Statuses waiting on the client (NEEDS_INFORMATION, AWAITING_CLIENT) have no internal SLA.
 */

function thresholds(cfg) {
  return {
    NEW: cfg.SLA_NEW_MINUTES,
    READY_FOR_SEARCH: cfg.SLA_READY_FOR_SEARCH_MINUTES,
    ASSIGNED: cfg.SLA_ASSIGNED_MINUTES,
    SEARCHING: cfg.SLA_SEARCHING_MINUTES,
    FARES_FOUND: cfg.SLA_FARES_FOUND_MINUTES,
    PENDING_APPROVAL: cfg.SLA_PENDING_APPROVAL_MINUTES,
    BOOKING_REQUESTED: cfg.SLA_BOOKING_REQUEST_MINUTES,
    CHANGE_REQUESTED: cfg.SLA_CHANGE_REQUEST_MINUTES,
    REFUND_REQUESTED: cfg.SLA_REFUND_REQUEST_MINUTES,
  };
}

/**
 * @param {{ status, status_changed_at, priority_level }} rfq
 * @returns {{ tracked, breached, minutes_in_status, threshold_minutes, dedupe_key }}
 */
function evaluateSla(rfq, now, cfg) {
  const limits = thresholds(cfg);
  const base = limits[rfq.status];
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const since = new Date(rfq.status_changed_at).getTime();
  const minutes = Math.max(0, (nowMs - since) / 60000);
  if (base === undefined || base === null || !Number.isFinite(since)) {
    return { tracked: false, breached: false, minutes_in_status: Math.round(minutes) };
  }
  const threshold = rfq.priority_level === 'CRITICAL' ? Math.max(1, Math.round(base * cfg.SLA_CRITICAL_FACTOR)) : base;
  const breached = minutes > threshold;
  return {
    tracked: true,
    breached,
    minutes_in_status: Math.round(minutes),
    threshold_minutes: threshold,
    // One alert per RFQ per status episode – re-entering the status later creates a new episode.
    dedupe_key: `SLA:${rfq.id}:${rfq.status}:${since}`,
  };
}

module.exports = { evaluateSla, thresholds };
