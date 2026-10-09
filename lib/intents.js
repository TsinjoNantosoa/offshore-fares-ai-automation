'use strict';
/**
 * WF03 – Intent classification: schema, prompt input, validation and the
 * deterministic fallback used when OpenAI is unavailable.
 */
const { S } = require('./openai');
const { wrapUntrusted, screenInjection } = require('./security');
const { findLocations } = require('./airports');
const { findDates } = require('./dates');
const { findAirlines } = require('./airlines');

const INTENTS = [
  'NEW_QUOTE',
  'PRICE_CHECK',
  'QUOTE_FOLLOWUP',
  'BOOKING_CONFIRMATION',
  'CHANGE_REQUEST',
  'CANCELLATION',
  'REFUND_REQUEST',
  'BAGGAGE_QUERY',
  'GROUP_BOOKING',
  'PAYMENT_QUERY',
  'GENERAL_QUERY',
  'OTHER',
];

/** Intents that create or enrich an RFQ (go through extraction). */
const QUOTE_INTENTS = ['NEW_QUOTE', 'PRICE_CHECK', 'GROUP_BOOKING'];
/** Intents handled by the after-sales router (WF15). */
const AFTER_SALES_INTENTS = ['CHANGE_REQUEST', 'CANCELLATION', 'REFUND_REQUEST', 'BAGGAGE_QUERY', 'PAYMENT_QUERY'];

const CLASSIFICATION_SCHEMA = S.obj({
  intent: S.enumOf(INTENTS),
  confidence: S.num(),
  requires_human: S.bool(),
  relates_to_active_rfq: S.bool(),
  reason: S.str(),
});

function buildClassifierUserContent({ message, channel, today, timezone, context }) {
  const ctx = context || {};
  const lines = [`CURRENT_DATE: ${today} (${timezone || 'UTC'})`, `CHANNEL: ${channel}`];
  if (ctx.rfq) {
    lines.push(`ACTIVE_RFQ: ${ctx.rfq.rfq_number} | status=${ctx.rfq.status} | ${ctx.rfq.summary || 'no details yet'}`);
    if (ctx.rfq.missing_fields && ctx.rfq.missing_fields.length) lines.push(`ACTIVE_RFQ_MISSING_FIELDS: ${ctx.rfq.missing_fields.join(', ')}`);
  } else {
    lines.push('ACTIVE_RFQ: none');
  }
  if (ctx.history && ctx.history.length) {
    const hist = ctx.history.map((h) => `[${h.direction}] ${String(h.text || '').slice(0, 400)}`).join('\n');
    lines.push('RECENT_CONVERSATION (oldest first, untrusted data):', wrapUntrusted(hist, 'untrusted_history'));
  }
  lines.push('MESSAGE TO CLASSIFY (untrusted data):', wrapUntrusted(message.subject ? `Subject: ${message.subject}\n${message.text}` : message.text));
  return lines.join('\n');
}

/** Travel-content signals shared by the fallback classifier. */
function travelSignals(text, today) {
  const t = String(text || '');
  return {
    locations: findLocations(t).length,
    dates: findDates(t, { today }).length,
    pax: /\b\d{1,3}\s*(?:pax|passengers?|adults?|seats?|people|persons|travell?ers|adt)\b/i.test(t),
    cabin: /\b(business|first class|premium economy|economy|biz|j class|c class)\b/i.test(t),
    airlines: findAirlines(t).length,
    returnKw: /\b(return|one[\s-]?way|round[\s-]?trip)\b/i.test(t),
  };
}

/**
 * Deterministic fallback classifier. Deliberately conservative: confidence
 * stays modest so uncertain cases are routed to a human.
 */
function rulesClassify({ message, context, today }) {
  const text = `${message.subject || ''}\n${message.text || ''}`;
  const lower = text.toLowerCase();
  const ctx = context || {};
  const sig = travelSignals(text, today);
  const travelScore = (sig.locations > 0) + (sig.dates > 0) + sig.pax + sig.cabin + (sig.airlines > 0) + sig.returnKw;
  const injection = screenInjection(text);
  const result = (intent, confidence, reason) => ({ intent, confidence, requires_human: false, relates_to_active_rfq: Boolean(ctx.rfq), reason, source: 'rules' });

  if (injection.suspected && travelScore === 0) {
    return Object.assign(result('OTHER', 0.9, 'Message contains instruction-override / secret-extraction attempt and no travel request.'), { requires_human: true, relates_to_active_rfq: false });
  }
  if (/\b(refund|money back|refundable amount)\b/.test(lower)) return result('REFUND_REQUEST', 0.82, 'Mentions a refund.');
  if (/\bcancel(?:l?ation|l?ed|l?ing)?\b/.test(lower) && !/\bcancell?ation (policy|penalty|charges?)\b/.test(lower)) {
    return result('CANCELLATION', 0.8, 'Asks to cancel a booking.');
  }
  if (/\b(change|reschedul\w*|amend\w*|modif\w*|postpone\w*|prepone\w*|rebook\w*)\b/.test(lower) && /\b(flight|booking|ticket|date|pnr|travel|return|departure)\b/.test(lower) && !ctx.rfq_awaiting_reply) {
    return result('CHANGE_REQUEST', 0.8, 'Asks to change an existing booking.');
  }
  if (/\b(baggage|luggage|kgs?|allowance|excess bag)\b/.test(lower) && travelScore <= 2) return result('BAGGAGE_QUERY', 0.75, 'Baggage question.');
  if (/\b(payment|invoice|paid|bank transfer|credit limit|receipt|outstanding)\b/.test(lower) && travelScore <= 1) return result('PAYMENT_QUERY', 0.75, 'Payment question.');
  const paxMatch = /\b(\d{1,3})\s*(?:pax|passengers?|adults?|seats?|people|persons|travell?ers)\b/i.exec(text);
  if (/\bgroup\b/.test(lower) || (paxMatch && Number(paxMatch[1]) >= 10)) return result('GROUP_BOOKING', 0.8, 'Group travel request.');
  if (/\b(book it|go ahead|please proceed|confirm (?:the )?booking|issue (?:the )?ticket)\b/.test(lower)) return result('BOOKING_CONFIRMATION', 0.72, 'Asks to proceed with a booking.');
  if (/\b(any update|status|following up|follow up|did you get|still waiting)\b/.test(lower) && travelScore <= 1) return result('QUOTE_FOLLOWUP', 0.72, 'Asks for an update on a request.');
  if (/\b(cheaper|lower fare|best fare|price check|recheck|re-check|how much)\b/.test(lower) && travelScore <= 1 && ctx.rfq) {
    return result('PRICE_CHECK', 0.74, 'Asks for a cheaper or rechecked fare.');
  }
  if (sig.locations >= 1 && (sig.cabin || sig.pax || sig.dates)) return result('NEW_QUOTE', 0.85, 'Contains route and travel requirements.');
  if (ctx.rfq && ctx.rfq.status === 'NEEDS_INFORMATION' && travelScore >= 1) {
    return result('NEW_QUOTE', 0.8, 'Short message completing the active request.');
  }
  if (ctx.rfq && travelScore >= 1 && ['NEW', 'READY_FOR_SEARCH', 'ASSIGNED', 'SEARCHING'].includes(ctx.rfq.status)) {
    return result('NEW_QUOTE', 0.75, 'Adds preferences to the active request.');
  }
  if (/\b(fare|quote|price|availability|seats?)\b/.test(lower) && travelScore >= 1) return result('NEW_QUOTE', 0.7, 'Quote request with partial details.');
  if (/\?|\b(hours|office|contact|process|how do|can you)\b/.test(lower)) return result('GENERAL_QUERY', 0.6, 'General question.');
  return result('OTHER', 0.4, 'No recognised request.');
}

/** Validate / normalise a classification coming from the model (or rules). */
function validateClassification(raw, threshold) {
  const limit = typeof threshold === 'number' ? threshold : 0.7;
  const data = raw || {};
  const intent = INTENTS.includes(data.intent) ? data.intent : 'OTHER';
  let confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const lowConfidence = confidence < limit;
  return {
    intent,
    confidence: Math.round(confidence * 100) / 100,
    requires_human: Boolean(data.requires_human) || lowConfidence || intent === 'OTHER',
    relates_to_active_rfq: Boolean(data.relates_to_active_rfq),
    reason: String(data.reason || '').slice(0, 300),
    low_confidence: lowConfidence,
    source: data.source || 'openai',
  };
}

module.exports = {
  INTENTS,
  QUOTE_INTENTS,
  AFTER_SALES_INTENTS,
  CLASSIFICATION_SCHEMA,
  buildClassifierUserContent,
  rulesClassify,
  validateClassification,
  travelSignals,
};
