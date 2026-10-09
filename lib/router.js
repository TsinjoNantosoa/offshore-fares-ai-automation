'use strict';
/**
 * WF06 – Routing decisions for a claimed inbound message (pure, testable).
 *
 *   decideRoute()   before classification: reply-to-quote vs intake vs opt-out
 *   decideIntake()  after classification: extract / after-sales / human
 *   shouldStartNewRfq()  after extraction: merge into the active RFQ or open a new one
 */
const { AWAITING_REPLY, MERGEABLE } = require('./stateMachine');
const { QUOTE_INTENTS, AFTER_SALES_INTENTS, travelSignals } = require('./intents');
const { findLocations } = require('./airports');

const OPT_OUT_RE = /^\s*(stop|unsubscribe|opt[\s-]?out|stop (?:messages|follow[\s-]?ups?))\s*[.!]?\s*$/i;

function routeOf(rfq) {
  if (!rfq) return null;
  const o = rfq.origin_iata || (rfq.requirements && rfq.requirements.origin && rfq.requirements.origin.iata);
  const d = rfq.destination_iata || (rfq.requirements && rfq.requirements.destination && rfq.requirements.destination.iata);
  return o && d ? `${o}-${d}` : null;
}

function messageRoute(text) {
  const locs = findLocations(text);
  if (locs.length < 2) return null;
  const from = locs.find((l) => /\bfrom\s*$/i.test(String(text).slice(Math.max(0, l.index - 6), l.index)));
  const origin = from || locs[0];
  const destination = locs.find((l) => l !== origin && l.iata !== origin.iata);
  return destination ? `${origin.iata}-${destination.iata}` : null;
}

/**
 * @param {object} claim result of of_claim_next_message()
 * @returns {{ route: 'OPT_OUT'|'IGNORE'|'REPLY'|'INTAKE', active_rfq, reasons: string[] }}
 */
function decideRoute(claim, today) {
  const text = (claim.message && claim.message.text) || '';
  const subject = (claim.message && claim.message.subject) || '';
  const reasons = [];
  if (OPT_OUT_RE.test(text)) return { route: 'OPT_OUT', active_rfq: claim.active_rfq || null, reasons: ['opt-out keyword'] };
  if (!text.trim() && !subject.trim()) return { route: 'IGNORE', active_rfq: null, reasons: ['empty message'] };

  let rfq = claim.active_rfq || null;
  const signals = travelSignals(text, today);
  if (rfq && rfq.correlation === 'CONTACT_SINGLE_OPEN_RFQ' && signals.locations > 0) {
    reasons.push('weak cross-channel correlation ignored: message names its own route');
    rfq = null;
  }
  if (rfq && AWAITING_REPLY.includes(rfq.status)) {
    const newRoute = messageRoute(text);
    if (newRoute && newRoute !== routeOf(rfq) && rfq.correlation !== 'RFQ_NUMBER_IN_MESSAGE') {
      reasons.push(`message describes a different route (${newRoute}) than the quoted RFQ (${routeOf(rfq)})`);
      return { route: 'INTAKE', active_rfq: null, reasons };
    }
    reasons.push(`reply to quote ${rfq.rfq_number} (${rfq.correlation})`);
    return { route: 'REPLY', active_rfq: rfq, reasons };
  }
  if (rfq) reasons.push(`active RFQ ${rfq.rfq_number} (${rfq.status}, ${rfq.correlation})`);
  return { route: 'INTAKE', active_rfq: rfq, reasons };
}

/**
 * @returns {{ path: 'EXTRACT'|'AFTER_SALES'|'HUMAN', flag_security: boolean, human_reason: string|null }}
 */
function decideIntake(classification, activeRfq, security) {
  const c = classification || {};
  const injection = Boolean(security && security.injection_suspected);
  if (QUOTE_INTENTS.includes(c.intent)) {
    return { path: 'EXTRACT', flag_security: injection, human_reason: c.requires_human ? `Low-confidence or sensitive classification: ${c.reason}` : null };
  }
  if (['CHANGE_REQUEST', 'CANCELLATION', 'REFUND_REQUEST'].includes(c.intent)) {
    return { path: 'AFTER_SALES', flag_security: injection, human_reason: null };
  }
  if (activeRfq && MERGEABLE.includes(activeRfq.status) && c.relates_to_active_rfq && c.intent === 'QUOTE_FOLLOWUP') {
    return { path: 'HUMAN', flag_security: injection, human_reason: 'Agent asks for an update on an RFQ in progress' };
  }
  const reasons = {
    BAGGAGE_QUERY: 'Baggage question – answer from the booking / fare rules',
    PAYMENT_QUERY: 'Payment question',
    GENERAL_QUERY: 'General question',
    BOOKING_CONFIRMATION: 'Booking confirmation without a quote awaiting reply',
    QUOTE_FOLLOWUP: 'Follow-up question',
    OTHER: injection ? 'Possible prompt-injection / abuse attempt' : 'Unrecognised message',
  };
  return { path: 'HUMAN', flag_security: injection || (c.intent === 'OTHER' && /inject|secret|instruction/i.test(c.reason || '')), human_reason: reasons[c.intent] || 'Needs review' };
}

/** Merge into the active RFQ unless the new message clearly describes another trip. */
function shouldStartNewRfq(activeRfq, delta, allowRequote) {
  if (!activeRfq) return { new_rfq: true, reason: 'no active RFQ' };
  const mergeable = MERGEABLE.includes(activeRfq.status) || (allowRequote && AWAITING_REPLY.includes(activeRfq.status));
  if (!mergeable) return { new_rfq: true, reason: `active RFQ is ${activeRfq.status}` };
  const current = routeOf(activeRfq);
  const incoming = delta && delta.origin && delta.origin.iata && delta.destination && delta.destination.iata ? `${delta.origin.iata}-${delta.destination.iata}` : null;
  if (current && incoming && current !== incoming && !(delta && delta.is_update_to_existing)) {
    return { new_rfq: true, reason: `different route ${incoming} vs ${current}` };
  }
  return { new_rfq: false, reason: 'merge into active RFQ' };
}

module.exports = { decideRoute, decideIntake, shouldStartNewRfq, OPT_OUT_RE, routeOf, messageRoute };
