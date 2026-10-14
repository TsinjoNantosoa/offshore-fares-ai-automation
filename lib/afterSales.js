'use strict';
/**
 * Deterministic after-sales interpretation.
 *
 * Partial dates are resolved against the parent journey, never against the
 * processing date. The result is only a human-review request; it does not
 * perform any ticketing operation.
 */
const { findDates, parseIso, isIsoDate } = require('./dates');

const DATE_CHANGE = /\b(change|move|reschedule|postpone|bring forward|push back)\b[\s\S]{0,60}\b(date|dates|departure|return|flight|travel|trip|it)\b|\b(change|move|reschedule)\b[\s\S]{0,35}\b(?:\d{1,2}(?:st|nd|rd|th)?|tomorrow|next|this|coming)\b/i;
const RETURN_WORDS = /\b(return|returning|inbound|coming back|flight back)\b/i;

function parentSummary(parent) {
  const p = parent || {};
  const req = p.requirements || {};
  const passengers = req.passengers || {
    adults: p.adults == null ? null : Number(p.adults),
    children: Number(p.children || 0),
    infants: Number(p.infants || 0),
  };
  return {
    parent_rfq_id: p.id || p.parent_rfq_id || null,
    parent_rfq_number: p.rfq_number || p.parent_rfq_number || null,
    origin: p.origin_iata || (req.origin && req.origin.iata) || null,
    destination: p.destination_iata || (req.destination && req.destination.iata) || null,
    trip_type: p.trip_type || req.trip_type || null,
    passengers,
    cabin: p.cabin || req.cabin || null,
    selected_option: p.selected_option || null,
    departure_date: p.departure_date || req.departure_date || null,
    return_date: p.return_date || req.return_date || null,
    booking_reference: p.booking_reference || null,
  };
}

function resolveRequest({ text, today, parent, intent }) {
  const source = String(text || '');
  const original = parentSummary(parent);
  const mentions = findDates(source, { today });
  // A bare ordinal in an after-sales change names a day within the parent
  // departure or return month. It may legitimately move the journey to an
  // earlier day in that same month.
  for (const mention of mentions) {
    if (mention.kind !== 'day_only') continue;
    const nearby = source.slice(Math.max(0, mention.start - 30), mention.end + 5);
    const targetsReturn = RETURN_WORDS.test(nearby);
    const anchor = parseIso(targetsReturn ? original.return_date : original.departure_date);
    if (!anchor) {
      mention.iso = null;
      mention.ambiguous = true;
      continue;
    }
    const iso = `${anchor.y}-${String(anchor.m).padStart(2, '0')}-${String(mention.day).padStart(2, '0')}`;
    mention.iso = isIsoDate(iso) ? iso : null;
    mention.ambiguous = !mention.iso;
  }
  const ambiguous = mentions.filter((m) => m.ambiguous);
  const resolved = mentions.filter((m) => m.iso);
  let requestedDeparture = null;
  let requestedReturn = null;

  for (const mention of resolved) {
    const nearby = source.slice(Math.max(0, mention.start - 30), mention.end + 5);
    if (RETURN_WORDS.test(nearby)) requestedReturn = requestedReturn || mention.iso;
    else if (!requestedDeparture) requestedDeparture = mention.iso;
    else if (!requestedReturn) requestedReturn = mention.iso;
  }

  const dateChangeRequested = (intent || 'CHANGE_REQUEST') === 'CHANGE_REQUEST' && DATE_CHANGE.test(source);
  const clarificationRequired = ambiguous.length > 0 || (dateChangeRequested && !requestedDeparture && !requestedReturn);
  return {
    original,
    requested_departure_date: clarificationRequired ? null : requestedDeparture,
    requested_return_date: clarificationRequired ? null : requestedReturn,
    clarification_required: clarificationRequired,
    ambiguities: ambiguous.map((m) => m.candidates
      ? `"${m.text}" could mean ${m.candidates.join(' or ')}`
      : `"${m.text}" is not a specific date`),
    date_mentions: mentions.map((m) => ({ text: m.text, iso: m.iso, ambiguous: m.ambiguous, kind: m.kind })),
  };
}

module.exports = { resolveRequest, parentSummary };
