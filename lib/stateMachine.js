'use strict';
/**
 * RFQ business state machine.
 *
 * Single source of truth for allowed transitions. The same table is seeded into
 * PostgreSQL (rfq_status_transitions) and enforced by of_transition_rfq();
 * tests/unit/stateMachine.test.js checks that both definitions stay in sync.
 */

const STATUSES = [
  'NEW',
  'NEEDS_INFORMATION',
  'READY_FOR_SEARCH',
  'ASSIGNED',
  'SEARCHING',
  'FARES_FOUND',
  'PENDING_APPROVAL',
  'APPROVED',
  'QUOTED',
  'AWAITING_CLIENT',
  'CLIENT_INTERESTED',
  'BOOKING_REQUESTED',
  'TICKETING',
  'TICKETED',
  'CHANGE_REQUESTED',
  'REFUND_REQUESTED',
  'CANCELLED',
  'LOST',
  'CLOSED',
  'ERROR',
];

const TRANSITIONS = {
  NEW: ['NEEDS_INFORMATION', 'READY_FOR_SEARCH', 'CHANGE_REQUESTED', 'REFUND_REQUESTED', 'CANCELLED', 'CLOSED', 'ERROR'],
  NEEDS_INFORMATION: ['READY_FOR_SEARCH', 'CANCELLED', 'LOST', 'CLOSED', 'ERROR'],
  READY_FOR_SEARCH: ['ASSIGNED', 'NEEDS_INFORMATION', 'CANCELLED', 'CLOSED', 'ERROR'],
  ASSIGNED: ['SEARCHING', 'READY_FOR_SEARCH', 'NEEDS_INFORMATION', 'CANCELLED', 'CLOSED', 'ERROR'],
  SEARCHING: ['FARES_FOUND', 'NEEDS_INFORMATION', 'READY_FOR_SEARCH', 'CANCELLED', 'LOST', 'ERROR'],
  FARES_FOUND: ['PENDING_APPROVAL', 'APPROVED', 'SEARCHING', 'CANCELLED', 'ERROR'],
  PENDING_APPROVAL: ['APPROVED', 'SEARCHING', 'FARES_FOUND', 'CANCELLED', 'ERROR'],
  APPROVED: ['QUOTED', 'PENDING_APPROVAL', 'SEARCHING', 'ERROR'],
  QUOTED: ['AWAITING_CLIENT', 'ERROR'],
  AWAITING_CLIENT: ['CLIENT_INTERESTED', 'BOOKING_REQUESTED', 'READY_FOR_SEARCH', 'NEEDS_INFORMATION', 'CANCELLED', 'LOST', 'CLOSED', 'ERROR'],
  CLIENT_INTERESTED: ['BOOKING_REQUESTED', 'AWAITING_CLIENT', 'READY_FOR_SEARCH', 'NEEDS_INFORMATION', 'CANCELLED', 'LOST', 'CLOSED', 'ERROR'],
  BOOKING_REQUESTED: ['TICKETING', 'AWAITING_CLIENT', 'READY_FOR_SEARCH', 'CANCELLED', 'ERROR'],
  TICKETING: ['TICKETED', 'BOOKING_REQUESTED', 'CANCELLED', 'ERROR'],
  TICKETED: ['CHANGE_REQUESTED', 'REFUND_REQUESTED', 'CLOSED'],
  CHANGE_REQUESTED: ['TICKETING', 'TICKETED', 'REFUND_REQUESTED', 'CANCELLED', 'CLOSED', 'ERROR'],
  REFUND_REQUESTED: ['CLOSED', 'CANCELLED', 'ERROR'],
  CANCELLED: ['CLOSED'],
  LOST: ['READY_FOR_SEARCH', 'CLOSED'],
  CLOSED: [],
  ERROR: ['NEW', 'NEEDS_INFORMATION', 'READY_FOR_SEARCH', 'ASSIGNED', 'SEARCHING', 'CANCELLED', 'CLOSED'],
};

/** Statuses after which the RFQ no longer accepts automated changes. */
const TERMINAL = ['CANCELLED', 'LOST', 'CLOSED'];

/** Statuses in which a new client message enriches the request (request merging). */
const MERGEABLE = ['NEW', 'NEEDS_INFORMATION', 'READY_FOR_SEARCH', 'ASSIGNED', 'SEARCHING'];

/** Statuses in which a client message is interpreted as a reply to a sent quote. */
const AWAITING_REPLY = ['QUOTED', 'AWAITING_CLIENT', 'CLIENT_INTERESTED'];

/** Follow-ups are never sent in these statuses. */
const NO_FOLLOWUP = ['BOOKING_REQUESTED', 'TICKETING', 'TICKETED', 'CANCELLED', 'LOST', 'CLOSED'];

/** Human-friendly labels used by the ops console and client timeline. */
const LABELS = {
  NEW: 'Request arrived',
  NEEDS_INFORMATION: 'Waiting for missing details',
  READY_FOR_SEARCH: 'Ready for fare search',
  ASSIGNED: 'Assigned to fare desk',
  SEARCHING: 'Fare desk searching',
  FARES_FOUND: 'Fares received',
  PENDING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Quote approved',
  QUOTED: 'Quote sent',
  AWAITING_CLIENT: 'Waiting for agent reply',
  CLIENT_INTERESTED: 'Agent interested / on hold',
  BOOKING_REQUESTED: 'Booking requested',
  TICKETING: 'Ticketing in progress',
  TICKETED: 'Ticketed',
  CHANGE_REQUESTED: 'Change requested',
  REFUND_REQUESTED: 'Refund / cancellation requested',
  CANCELLED: 'Cancelled',
  LOST: 'Lost',
  CLOSED: 'Closed',
  ERROR: 'Error – needs attention',
};

function canTransition(from, to) {
  if (from === to) return true; // idempotent no-op
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function assertTransition(from, to) {
  if (!STATUSES.includes(to)) throw new Error(`UNKNOWN_STATUS: ${to}`);
  if (!canTransition(from, to)) throw new Error(`INVALID_TRANSITION: ${from} -> ${to}`);
  return true;
}

/** Shortest legal path between two statuses (used by operator shortcuts, e.g. ASSIGNED -> FARES_FOUND). */
function pathBetween(from, to) {
  if (from === to) return [from];
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    for (const next of TRANSITIONS[path[path.length - 1]] || []) {
      if (seen.has(next)) continue;
      const candidate = path.concat(next);
      if (next === to) return candidate;
      seen.add(next);
      queue.push(candidate);
    }
  }
  return null;
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  TERMINAL,
  MERGEABLE,
  AWAITING_REPLY,
  NO_FOLLOWUP,
  LABELS,
  canTransition,
  assertTransition,
  pathBetween,
};
