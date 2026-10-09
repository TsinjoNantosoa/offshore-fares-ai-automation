'use strict';
/**
 * WF09 – Fare desk routing rules (deterministic, first match wins).
 * Desk codes match the `desks` table. The concrete operator is chosen in SQL
 * (least open assignments within the desk).
 */
const { totalPassengers } = require('./requirements');

const DESKS = {
  PREMIUM_DESK: 'Premium Desk',
  GROUP_DESK: 'Group Desk',
  TICKETING_DESK: 'Ticketing Desk',
  REFUND_DESK: 'Refund Desk',
  GENERAL_DESK: 'General Desk',
};

const RULES = [
  { id: 'BOOKING_TO_TICKETING', when: (r) => ['BOOKING_CONFIRMATION'].includes(r.intent) || r.status === 'BOOKING_REQUESTED', desk: 'TICKETING_DESK' },
  { id: 'CHANGE_TO_TICKETING', when: (r) => ['CHANGE_REQUEST', 'CANCELLATION', 'BAGGAGE_QUERY'].includes(r.intent), desk: 'TICKETING_DESK' },
  { id: 'REFUND_TO_REFUND_DESK', when: (r) => ['REFUND_REQUEST'].includes(r.intent), desk: 'REFUND_DESK' },
  { id: 'PAYMENT_TO_GENERAL', when: (r) => ['PAYMENT_QUERY', 'GENERAL_QUERY', 'OTHER'].includes(r.intent), desk: 'GENERAL_DESK' },
  { id: 'GROUP_TO_GROUP_DESK', when: (r, cfg) => r.intent === 'GROUP_BOOKING' || totalPassengers(r.requirements) >= ((cfg && cfg.GROUP_MIN_PASSENGERS) || 10), desk: 'GROUP_DESK' },
  { id: 'PREMIUM_CABIN', when: (r) => ['FIRST', 'BUSINESS', 'PREMIUM_ECONOMY'].includes((r.requirements || {}).cabin), desk: 'PREMIUM_DESK' },
  { id: 'CRITICAL_TO_PREMIUM', when: (r) => r.priority_level === 'CRITICAL', desk: 'PREMIUM_DESK' },
  { id: 'DEFAULT', when: () => true, desk: 'GENERAL_DESK' },
];

function routeToDesk(rfq, cfg) {
  const rule = RULES.find((r) => r.when(rfq || {}, cfg));
  return { desk_code: rule.desk, desk_name: DESKS[rule.desk], rule: rule.id };
}

module.exports = { DESKS, routeToDesk };
