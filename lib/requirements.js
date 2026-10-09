'use strict';
/**
 * Canonical RFQ requirements: deterministic merging of extraction deltas
 * (request merging across several messages) and completeness rules.
 */
const { cityName } = require('./airports');
const { formatShort } = require('./dates');

const QUOTE_INTENTS = ['NEW_QUOTE', 'PRICE_CHECK', 'GROUP_BOOKING', 'QUOTE_FOLLOWUP'];

function emptyRequirements() {
  return {
    intent: 'NEW_QUOTE',
    trip_type: 'UNKNOWN',
    origin: null,
    destination: null,
    segments: [],
    departure_date: null,
    return_date: null,
    date_flexibility_days: null,
    passengers: { adults: null, children: 0, infants: 0 },
    cabin: 'UNKNOWN',
    preferred_airlines: [],
    excluded_airlines: [],
    direct_only: false,
    max_stops: null,
    budget: null,
    currency: null,
    special_requests: [],
    urgency: 'NORMAL',
    ambiguities: [],
    missing_fields: [],
    ready_for_processing: false,
  };
}

const URGENCY_RANK = { LOW: 0, NORMAL: 1, HIGH: 2 };
const uniq = (list) => Array.from(new Set(list.filter(Boolean)));

/**
 * Merge a validated delta into the current requirements.
 * Later messages override scalar values; lists are combined; an airline that is
 * later excluded is removed from the preferred list (and vice versa).
 */
function mergeRequirements(current, delta) {
  const base = Object.assign(emptyRequirements(), JSON.parse(JSON.stringify(current || {})));
  base.passengers = Object.assign({ adults: null, children: 0, infants: 0 }, base.passengers || {});
  const d = delta || {};
  const changes = [];
  const set = (key, value) => {
    if (value === null || value === undefined) return;
    if (JSON.stringify(base[key]) !== JSON.stringify(value)) changes.push(key);
    base[key] = value;
  };

  if (d.intent && d.intent !== 'QUOTE_FOLLOWUP' && (!current || !current.intent || d.intent === 'GROUP_BOOKING')) set('intent', d.intent);
  set('origin', d.origin && d.origin.iata ? d.origin : d.origin && !base.origin ? d.origin : null);
  set('destination', d.destination && d.destination.iata ? d.destination : d.destination && !base.destination ? d.destination : null);
  if (Array.isArray(d.segments) && d.segments.length) set('segments', d.segments);
  set('departure_date', d.departure_date);
  set('return_date', d.return_date);
  if (d.trip_type && d.trip_type !== 'UNKNOWN') set('trip_type', d.trip_type);
  if (base.trip_type === 'ONE_WAY' && base.return_date) {
    if (d.return_date) set('trip_type', 'ROUND_TRIP');
    else base.return_date = null;
  }
  if (base.return_date && (!base.trip_type || base.trip_type === 'UNKNOWN')) set('trip_type', 'ROUND_TRIP');
  set('date_flexibility_days', d.date_flexibility_days);
  if (d.passengers) {
    const pax = Object.assign({}, base.passengers);
    for (const k of ['adults', 'children', 'infants']) if (d.passengers[k] !== null && d.passengers[k] !== undefined) pax[k] = d.passengers[k];
    set('passengers', pax);
  }
  if (d.cabin && d.cabin !== 'UNKNOWN') set('cabin', d.cabin);
  const excluded = uniq((base.excluded_airlines || []).concat(d.excluded_airlines || []));
  const preferredDelta = d.preferred_airlines || [];
  const preferred = uniq((base.preferred_airlines || []).concat(preferredDelta));
  set('preferred_airlines', preferred.filter((a) => !(d.excluded_airlines || []).includes(a)));
  set('excluded_airlines', excluded.filter((a) => !preferredDelta.includes(a)));
  if (d.direct_only === true || d.direct_only === false) set('direct_only', d.direct_only);
  set('max_stops', d.max_stops);
  set('budget', d.budget);
  set('currency', d.currency);
  if (Array.isArray(d.special_requests) && d.special_requests.length) set('special_requests', uniq((base.special_requests || []).concat(d.special_requests)));
  if (d.urgency && URGENCY_RANK[d.urgency] > URGENCY_RANK[base.urgency || 'NORMAL']) set('urgency', d.urgency);
  base.ambiguities = d.ambiguities && d.ambiguities.length ? d.ambiguities.slice(0, 5) : [];

  const completeness = computeMissingFields(base);
  base.missing_fields = completeness.missing;
  base.ready_for_processing = completeness.ready;
  return { requirements: base, changes };
}

/** Mandatory information before a fare search (section 13 of the specification). */
function computeMissingFields(req) {
  const r = req || {};
  const missing = [];
  if (r.trip_type === 'MULTI_CITY') {
    if (!Array.isArray(r.segments) || r.segments.length < 2) missing.push('segments');
    else if (r.segments.some((s) => !s.origin || !s.origin.iata || !s.destination || !s.destination.iata || !s.date)) missing.push('segments');
  } else {
    if (!r.origin || !r.origin.iata) missing.push('origin');
    if (!r.destination || !r.destination.iata) missing.push('destination');
    if (!r.departure_date) missing.push('departure_date');
    if (!r.trip_type || r.trip_type === 'UNKNOWN') missing.push('trip_type');
    else if (r.trip_type === 'ROUND_TRIP' && !r.return_date) missing.push('return_date');
  }
  if (!r.passengers || !Number.isInteger(r.passengers.adults) || r.passengers.adults < 1) missing.push('passengers.adults');
  if (!r.cabin || r.cabin === 'UNKNOWN') missing.push('cabin');
  return { missing, ready: missing.length === 0 };
}

function totalPassengers(req) {
  const p = (req && req.passengers) || {};
  return (p.adults || 0) + (p.children || 0) + (p.infants || 0);
}

const CABIN_LABEL = { ECONOMY: 'Economy', PREMIUM_ECONOMY: 'Premium Economy', BUSINESS: 'Business', FIRST: 'First', UNKNOWN: 'Cabin TBC' };

function paxLabel(req) {
  const p = (req && req.passengers) || {};
  const parts = [];
  if (p.adults) parts.push(`${p.adults} adult${p.adults > 1 ? 's' : ''}`);
  if (p.children) parts.push(`${p.children} child${p.children > 1 ? 'ren' : ''}`);
  if (p.infants) parts.push(`${p.infants} infant${p.infants > 1 ? 's' : ''}`);
  return parts.join(', ') || 'passengers TBC';
}

function routeLabel(req) {
  const r = req || {};
  if (r.trip_type === 'MULTI_CITY' && Array.isArray(r.segments) && r.segments.length) {
    return r.segments.map((s) => `${(s.origin && s.origin.iata) || '?'}→${(s.destination && s.destination.iata) || '?'}`).join(', ');
  }
  const o = r.origin ? r.origin.iata || r.origin.raw : '?';
  const d = r.destination ? r.destination.iata || r.destination.raw : '?';
  return `${o} → ${d}`;
}

/** One-line summary, e.g. "BOM → LHR · 17 Nov 2026 – 25 Nov 2026 · 3 adults · Business · Pref: Qatar Airways". */
function summarize(req) {
  const r = req || {};
  const parts = [routeLabel(r)];
  if (r.departure_date) parts.push(r.return_date ? `${formatShort(r.departure_date)} – ${formatShort(r.return_date)}` : `${formatShort(r.departure_date)}${r.trip_type === 'ONE_WAY' ? ' (one-way)' : ''}`);
  parts.push(paxLabel(r));
  parts.push(CABIN_LABEL[r.cabin || 'UNKNOWN']);
  if (r.date_flexibility_days) parts.push(`±${r.date_flexibility_days} day${r.date_flexibility_days > 1 ? 's' : ''}`);
  if (r.preferred_airlines && r.preferred_airlines.length) parts.push(`Pref: ${r.preferred_airlines.join(', ')}`);
  if (r.direct_only) parts.push('Direct only');
  return parts.join(' · ');
}

/** Human readable recap used in acknowledgements so the agent can spot extraction errors. */
function recapLines(req) {
  const r = req || {};
  const lines = [];
  const o = r.origin && r.origin.iata ? `${cityName(r.origin.iata)} (${r.origin.iata})` : null;
  const d = r.destination && r.destination.iata ? `${cityName(r.destination.iata)} (${r.destination.iata})` : null;
  if (o && d) lines.push(`Route: ${o} → ${d}${r.trip_type === 'ROUND_TRIP' ? ' (return)' : r.trip_type === 'ONE_WAY' ? ' (one-way)' : ''}`);
  if (r.departure_date) lines.push(`Departure: ${formatShort(r.departure_date)}${r.date_flexibility_days ? ` (±${r.date_flexibility_days} day${r.date_flexibility_days > 1 ? 's' : ''})` : ''}`);
  if (r.return_date) lines.push(`Return: ${formatShort(r.return_date)}`);
  lines.push(`Passengers: ${paxLabel(r)}`);
  lines.push(`Cabin: ${CABIN_LABEL[r.cabin || 'UNKNOWN']}`);
  if (r.preferred_airlines && r.preferred_airlines.length) lines.push(`Preferred airlines: ${r.preferred_airlines.join(', ')}`);
  if (r.excluded_airlines && r.excluded_airlines.length) lines.push(`Excluded airlines: ${r.excluded_airlines.join(', ')}`);
  if (r.direct_only) lines.push('Direct flights only');
  return lines;
}

module.exports = {
  QUOTE_INTENTS,
  CABIN_LABEL,
  emptyRequirements,
  mergeRequirements,
  computeMissingFields,
  totalPassengers,
  paxLabel,
  routeLabel,
  summarize,
  recapLines,
};
