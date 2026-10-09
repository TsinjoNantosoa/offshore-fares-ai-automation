'use strict';
/**
 * Fare options: validation and normalisation of what the fare desk (or a
 * future FareProvider) supplies. Commercial data ONLY comes from here –
 * never from the language model.
 */
const CABINS = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];
const SOURCES = ['MANUAL', 'MOCK', 'GDS', 'NDC', 'CONSOLIDATOR'];
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function isDateTime(v) {
  return typeof v === 'string' && DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v.length === 16 ? `${v}:00Z` : v));
}

function cleanText(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max || 200);
}

function normalizeSegment(seg, i, errors, prefix) {
  const s = seg || {};
  const out = {
    direction: ['OUTBOUND', 'INBOUND'].includes(String(s.direction || '').toUpperCase()) ? String(s.direction).toUpperCase() : 'OUTBOUND',
    flight_no: cleanText(s.flight_no || s.flight || '', 12).toUpperCase(),
    from: cleanText(s.from || s.origin || '', 3).toUpperCase(),
    to: cleanText(s.to || s.destination || '', 3).toUpperCase(),
    depart_at: s.depart_at || s.departure_at || null,
    arrive_at: s.arrive_at || s.arrival_at || null,
  };
  if (!/^[A-Z]{3}$/.test(out.from) || !/^[A-Z]{3}$/.test(out.to)) errors.push(`${prefix}.segments[${i}]: from/to must be IATA codes`);
  if (out.flight_no && !/^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/.test(out.flight_no)) errors.push(`${prefix}.segments[${i}]: invalid flight number "${out.flight_no}"`);
  if (out.depart_at && !isDateTime(out.depart_at)) errors.push(`${prefix}.segments[${i}]: depart_at must be ISO date-time`);
  if (out.arrive_at && !isDateTime(out.arrive_at)) errors.push(`${prefix}.segments[${i}]: arrive_at must be ISO date-time`);
  return out;
}

/**
 * Validate a list of fare options entered by the fare desk.
 * @returns {{ ok: boolean, errors: string[], options: object[] }}
 */
function validateFareOptions(input, { rfq, now } = {}) {
  const errors = [];
  const list = Array.isArray(input) ? input : [];
  if (list.length === 0) errors.push('At least one fare option is required');
  if (list.length > 5) errors.push('Maximum 5 options per quote');
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const options = list.slice(0, 5).map((raw, idx) => {
    const o = raw || {};
    const p = `option ${idx + 1}`;
    const amount = Number(o.fare && o.fare.amount !== undefined ? o.fare.amount : o.fare_amount);
    const currency = String((o.fare && o.fare.currency) || o.fare_currency || '').toUpperCase().trim();
    const segments = (Array.isArray(o.flight_segments) ? o.flight_segments : []).map((s, i) => normalizeSegment(s, i, errors, p));
    const out = {
      option_no: idx + 1,
      option_code: `OPT-${String(idx + 1).padStart(3, '0')}`,
      airline: cleanText(o.airline, 80),
      flight_segments: segments,
      departure_at: o.departure_at || (segments[0] && segments[0].depart_at) || null,
      arrival_at: o.arrival_at || null,
      return_departure_at: o.return_departure_at || (segments.find((s) => s.direction === 'INBOUND') || {}).depart_at || null,
      total_duration_minutes: Number.isInteger(Number(o.total_duration_minutes)) ? Number(o.total_duration_minutes) : null,
      stops: Number.isInteger(Number(o.stops)) ? Number(o.stops) : Math.max(0, segments.filter((s) => s.direction === 'OUTBOUND').length - 1),
      cabin: String(o.cabin || (rfq && rfq.cabin) || '').toUpperCase(),
      fare: { amount, currency },
      fare_basis: o.fare_basis === 'TOTAL' ? 'TOTAL' : 'PER_PASSENGER',
      baggage: cleanText(o.baggage, 60),
      change_penalty: cleanText(o.change_penalty, 80),
      refund_penalty: cleanText(o.refund_penalty, 80),
      fare_valid_until: o.fare_valid_until || null,
      source: SOURCES.includes(String(o.source || '').toUpperCase()) ? String(o.source).toUpperCase() : 'MANUAL',
      verified: o.verified !== false,
      notes: cleanText(o.notes, 300),
    };
    if (!out.airline) errors.push(`${p}: airline is required`);
    if (!Number.isFinite(amount) || amount <= 0) errors.push(`${p}: fare amount must be a positive number`);
    else if (Math.round(amount * 100) !== amount * 100) errors.push(`${p}: fare amount has more than 2 decimals`);
    if (!/^[A-Z]{3}$/.test(currency)) errors.push(`${p}: currency must be a 3-letter ISO code`);
    if (!CABINS.includes(out.cabin)) errors.push(`${p}: cabin must be one of ${CABINS.join(', ')}`);
    if (!out.departure_at || !isDateTime(out.departure_at)) errors.push(`${p}: departure_at (ISO date-time) is required`);
    if (out.return_departure_at && !isDateTime(out.return_departure_at)) errors.push(`${p}: return_departure_at must be ISO date-time`);
    if (!out.baggage) errors.push(`${p}: baggage allowance is required`);
    if (!out.change_penalty) errors.push(`${p}: change penalty is required (write "Not permitted" if applicable)`);
    if (!out.refund_penalty) errors.push(`${p}: refund penalty is required (write "Non-refundable" if applicable)`);
    if (!out.fare_valid_until || !isDateTime(out.fare_valid_until)) errors.push(`${p}: fare_valid_until (ISO date-time) is required`);
    else if (Date.parse(out.fare_valid_until) <= nowMs) errors.push(`${p}: fare_valid_until is already in the past`);
    if (rfq && rfq.trip_type === 'ROUND_TRIP' && !out.return_departure_at) errors.push(`${p}: return flight is required for a round trip`);
    if (!out.verified) errors.push(`${p}: option must be verified by the fare desk before quoting`);
    return out;
  });
  return { ok: errors.length === 0, errors, options };
}

/** Earliest validity among options – the quote is only as valid as its first-expiring fare. */
function quoteValidUntil(options) {
  const times = (options || []).map((o) => Date.parse(o.fare_valid_until)).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function isExpired(option, now) {
  const t = Date.parse(option && option.fare_valid_until);
  return !Number.isFinite(t) || t <= (now ? new Date(now).getTime() : Date.now());
}

module.exports = { validateFareOptions, quoteValidUntil, isExpired, isDateTime };
