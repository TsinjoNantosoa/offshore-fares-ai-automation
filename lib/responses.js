'use strict';
/**
 * WF14 – Client response interpretation after a quote was sent.
 *
 * Deterministic evidence (option numbers, ordinals, airline names) is combined
 * with the model's classification. A booking selection is only accepted when
 * the message itself identifies exactly one option; otherwise we ask.
 */
const { S } = require('./openai');
const { wrapUntrusted } = require('./security');
const { findAirlines, normalizeAirline } = require('./airlines');

const ACTIONS = [
  'SELECT_OPTION', // agent chooses an option / asks to proceed
  'HOLD', // asks to hold / will revert
  'PRICE_OBJECTION', // too expensive / anything cheaper
  'ALTERNATIVE_REQUEST', // other airline / other routing
  'CHANGE_REQUIREMENTS', // new dates / pax / cabin before booking
  'DECLINE', // not needed any more
  'QUESTION', // question about the options
  'OTHER',
];

const ACTION_TO_INTENT = {
  SELECT_OPTION: 'BOOKING_CONFIRMATION',
  HOLD: 'QUOTE_FOLLOWUP',
  PRICE_OBJECTION: 'PRICE_CHECK',
  ALTERNATIVE_REQUEST: 'PRICE_CHECK',
  CHANGE_REQUIREMENTS: 'NEW_QUOTE',
  DECLINE: 'QUOTE_FOLLOWUP',
  QUESTION: 'GENERAL_QUERY',
  OTHER: 'OTHER',
};

const RESPONSE_SCHEMA = S.obj({
  action: S.enumOf(ACTIONS),
  selected_option_number: S.nint(),
  confidence: S.num(),
  requested_airlines: S.arr(S.str()),
  reason: S.str(),
});

const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };

function buildResponseUserContent({ message, options, rfq }) {
  const optionLines = (options || []).map((o) => `Option ${o.option_no} (${o.option_code}): ${o.airline}, ${o.fare_amount} ${o.fare_currency}${o.expired ? ' [FARE EXPIRED]' : ''}`);
  return [
    `RFQ: ${rfq.rfq_number} | status=${rfq.status}`,
    'OPTIONS SENT TO THE AGENT (trusted):',
    optionLines.join('\n') || 'none',
    'AGENT REPLY (untrusted data):',
    wrapUntrusted(message.text),
  ].join('\n');
}

/** Deterministic evidence about which option(s) the message refers to. */
function optionEvidence(text, options) {
  const src = String(text || '');
  const lower = src.toLowerCase();
  const count = (options || []).length;
  const numbers = new Set();
  let m;
  // "option 2", "opt 2", "#2", "options 1 or 2", "option 1, 2 and 3"
  const re = /(?:\b(?:options?|opt\.?|choices?|no\.?|number)|#)\s*#?\s*(\d)\b((?:\s*(?:,|or|and|\/|&)\s*#?\s*\d\b)*)/gi;
  while ((m = re.exec(src)) !== null) {
    numbers.add(Number(m[1]));
    for (const extra of (m[2] || '').match(/\d/g) || []) numbers.add(Number(extra));
  }
  for (const [word, n] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b(?:the\\s+)?${word}\\s+(?:one|option|choice|fare|flight)\\b|\\b(?:option|choice)\\s+${word}\\b`, 'i').test(lower)) numbers.add(n === -1 ? count : n);
  }
  if (/^\s*#?\s*(\d)\s*[.!]?\s*$/.test(src)) numbers.add(Number(/(\d)/.exec(src)[1]));
  const valid = Array.from(numbers).filter((n) => n >= 1 && n <= count);
  const invalid = Array.from(numbers).filter((n) => n < 1 || n > count);
  const airlinesMentioned = findAirlines(src).map((a) => a.name);
  const airlineMatches = (options || []).filter((o) => airlinesMentioned.includes(normalizeAirline(o.airline))).map((o) => o.option_no);
  return { numbers: valid, invalid_numbers: invalid, airlines: airlinesMentioned, airline_option_numbers: airlineMatches };
}

const AFFIRM = /\b(proceed|go ahead|book(?:\s+it)?|confirm|works|looks good|take it|let'?s do|we'?ll take|go with|yes please|ok(?:ay)?(?: for)?|fine|approved?|please issue|block it)\b/i;

/** Rules-only interpretation (fallback + cross-check of the AI). */
function rulesInterpret(text, options) {
  const src = String(text || '');
  const lower = src.toLowerCase();
  const ev = optionEvidence(src, options);
  const r = (action, extra) => Object.assign({ action, selected_option_number: null, confidence: 0.75, requested_airlines: [], reason: '', evidence: ev, source: 'rules' }, extra || {});

  if (/\b(too (?:expensive|high|costly)|cheaper|lower (?:fare|price)|best (?:price|fare)|reduce|budget is|over budget|any discount)\b/.test(lower)) {
    return r('PRICE_OBJECTION', { reason: 'Agent finds the fares too expensive.' });
  }
  if (/\b(not needed|no longer|drop it|cancel (?:the )?(?:request|enquiry|inquiry)|client (?:has )?(?:cancelled|dropped)|not interested|booked elsewhere)\b/.test(lower)) {
    return r('DECLINE', { reason: 'Agent no longer needs the quote.' });
  }
  if (/\b(hold|block (?:the )?seats?|will revert|get back to you|checking with (?:the )?(?:client|pax|passenger))\b/.test(lower) && !/\bproceed\b/.test(lower)) {
    return r('HOLD', { reason: 'Agent asks to hold or will revert.' });
  }
  if (/\b(change|move|shift|instead|make it)\b/.test(lower) && /\b(\d{1,2}(?:st|nd|rd|th)?|date|dates|pax|passengers?|adults?|business|first|economy|return)\b/.test(lower) && !AFFIRM.test(lower)) {
    return r('CHANGE_REQUIREMENTS', { reason: 'Agent changes travel requirements before booking.' });
  }
  const askOther = /\b(can you (?:also )?check|what about|anything (?:on|with)|other airlines?|alternatives?|options? (?:on|with))\b/.test(lower);
  if (askOther && ev.airlines.length && !ev.airline_option_numbers.length) {
    return r('ALTERNATIVE_REQUEST', { requested_airlines: ev.airlines, reason: 'Agent asks for another airline.' });
  }
  if (askOther && !ev.numbers.length) return r('ALTERNATIVE_REQUEST', { reason: 'Agent asks for alternatives.' });
  const affirm = AFFIRM.test(lower) || /^\s*(yes|yep|ok|okay|sure)\b/i.test(src);
  const candidates = Array.from(new Set(ev.numbers.concat(ev.airline_option_numbers)));
  if (candidates.length === 1 && (affirm || ev.numbers.length || /\b(book|take|want|prefer|choose|go)\b/.test(lower))) {
    return r('SELECT_OPTION', { selected_option_number: candidates[0], confidence: affirm ? 0.92 : 0.85, reason: 'Message identifies exactly one option.' });
  }
  if (candidates.length > 1) return r('SELECT_OPTION', { selected_option_number: null, confidence: 0.4, reason: 'Message refers to several options.' });
  if (ev.invalid_numbers.length) return r('SELECT_OPTION', { selected_option_number: null, confidence: 0.4, reason: 'Message refers to an option that was not quoted.' });
  if (affirm && (options || []).length === 1) return r('SELECT_OPTION', { selected_option_number: 1, confidence: 0.8, reason: 'Single option quoted and agent confirms.' });
  if (affirm) return r('SELECT_OPTION', { selected_option_number: null, confidence: 0.4, reason: 'Agent wants to proceed but no option identified.' });
  if (/\?/.test(src)) return r('QUESTION', { confidence: 0.6, reason: 'Question about the quote.' });
  return r('OTHER', { confidence: 0.4, reason: 'Unrecognised reply.' });
}

/**
 * Reconcile model output with deterministic evidence.
 * Returns { action, intent, selected_option_number, selected_option_code, confidence, ambiguous, needs_confirmation, reason }
 */
function reconcileResponse(ai, text, options, threshold) {
  const limit = typeof threshold === 'number' ? threshold : 0.7;
  const rules = rulesInterpret(text, options);
  const model = ai && ACTIONS.includes(ai.action) ? ai : null;
  let action = model ? model.action : rules.action;
  let confidence = model ? Math.max(0, Math.min(1, Number(model.confidence) || 0)) : rules.confidence;
  let selected = null;
  let ambiguous = false;
  let reason = model ? String(model.reason || '') : rules.reason;
  const ev = rules.evidence;
  const evidenceCandidates = Array.from(new Set(ev.numbers.concat(ev.airline_option_numbers)));

  if (action === 'SELECT_OPTION') {
    const proposed = model ? model.selected_option_number : rules.selected_option_number;
    if (evidenceCandidates.length === 1 && (proposed === null || proposed === evidenceCandidates[0])) selected = evidenceCandidates[0];
    else if (evidenceCandidates.length === 0 && (options || []).length === 1 && (proposed === 1 || proposed === null)) selected = 1;
    else {
      ambiguous = true;
      if (evidenceCandidates.length > 1) reason = 'Several options referenced – confirmation needed.';
      else if (evidenceCandidates.length === 1) reason = 'Model selection does not match the option named in the message – confirmation needed.';
      else reason = 'Proceed requested without an identifiable option – confirmation needed.';
    }
    if (ev.invalid_numbers.length && !selected) {
      ambiguous = true;
      reason = `Option ${ev.invalid_numbers.join(', ')} does not exist in the quote.`;
    }
  }
  if (model && rules.action !== action && ['PRICE_OBJECTION', 'DECLINE'].includes(rules.action) && action === 'SELECT_OPTION') {
    ambiguous = true;
    reason = 'Model and rules disagree (selection vs objection) – confirmation needed.';
  }
  // Deterministic evidence for the same option is a strong signal even if the model was unsure.
  if (action === 'SELECT_OPTION' && selected && rules.selected_option_number === selected) confidence = Math.max(confidence, rules.confidence);
  const lowConfidence = confidence < limit;
  const option = selected ? (options || []).find((o) => o.option_no === selected) : null;
  const requestedAirlines = Array.from(new Set(((model && model.requested_airlines) || rules.requested_airlines || []).map(normalizeAirline).filter(Boolean)));
  return {
    action,
    intent: ACTION_TO_INTENT[action],
    selected_option_number: option ? option.option_no : null,
    selected_option_code: option ? option.option_code : null,
    selected_option_expired: option ? Boolean(option.expired) : false,
    requested_airlines: requestedAirlines,
    confidence: Math.round(confidence * 100) / 100,
    ambiguous: action === 'SELECT_OPTION' ? ambiguous || !option : false,
    needs_confirmation: action === 'SELECT_OPTION' ? ambiguous || !option || lowConfidence : false,
    requires_human: ['QUESTION', 'OTHER'].includes(action) || (lowConfidence && action !== 'SELECT_OPTION'),
    reason: reason.slice(0, 300),
    source: model ? 'openai+rules' : 'rules',
    evidence: ev,
  };
}

function confirmationQuestion(options, contactName) {
  const list = (options || []).map((o) => `Option ${o.option_no} (${o.airline})`).join(', ');
  return `Thanks${contactName ? ` ${contactName}` : ''}. To make sure we book the right fare, could you please confirm which option you would like to proceed with: ${list}?`;
}

module.exports = {
  ACTIONS,
  ACTION_TO_INTENT,
  RESPONSE_SCHEMA,
  buildResponseUserContent,
  optionEvidence,
  rulesInterpret,
  reconcileResponse,
  confirmationQuestion,
};
