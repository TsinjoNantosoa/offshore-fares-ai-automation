'use strict';
/**
 * WF04 – Travel request extraction.
 *
 * The model extracts a DELTA: only what the CURRENT message states (using the
 * active request as context to interpret short replies such as "return 25th").
 * Every field is then verified here against the message text:
 *   - dates must be backed by an evidence span that really expresses that date,
 *   - locations / airlines / cabin / passenger counts must appear in the text.
 * Unverifiable values are dropped and reported, never silently kept.
 * Merging the delta into the RFQ is deterministic (requirements.js).
 */
const { S } = require('./openai');
const { wrapUntrusted } = require('./security');
const { INTENTS } = require('./intents');
const { resolveLocation, findLocations } = require('./airports');
const { findDates, verifyDateEvidence, diffDays } = require('./dates');
const { normalizeAirline, findAirlines, isMentioned } = require('./airlines');

const TRIP_TYPES = ['ONE_WAY', 'ROUND_TRIP', 'MULTI_CITY', 'UNKNOWN'];
const CABINS = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST', 'UNKNOWN'];
const URGENCY = ['LOW', 'NORMAL', 'HIGH'];

const LOCATION = S.obj({ raw: S.nstr(), iata: S.nstr() }, true);

const EXTRACTION_SCHEMA = S.obj({
  intent: S.enumOf(INTENTS),
  is_update_to_existing: S.bool(),
  trip_type: S.enumOf(TRIP_TYPES, true),
  origin: LOCATION,
  destination: LOCATION,
  segments: S.arr(S.obj({
    origin: LOCATION,
    destination: LOCATION,
    date: S.nstr(),
    date_evidence: S.nstr(),
  })),
  departure_date: S.nstr(),
  departure_date_evidence: S.nstr(),
  return_date: S.nstr(),
  return_date_evidence: S.nstr(),
  date_flexibility_days: S.nint(),
  passengers: S.obj({ adults: S.nint(), children: S.nint(), infants: S.nint() }, true),
  passengers_evidence: S.nstr(),
  cabin: S.enumOf(CABINS, true),
  preferred_airlines: S.arr(S.str()),
  excluded_airlines: S.arr(S.str()),
  direct_only: S.nbool(),
  max_stops: S.nint(),
  budget: S.nnum(),
  currency: S.nstr(),
  special_requests: S.arr(S.str()),
  urgency: S.enumOf(URGENCY, true),
  ambiguities: S.arr(S.str()),
});

const CABIN_WORDS = {
  FIRST: /\b(first(?:\s+class)?|f\s*class)\b/i,
  BUSINESS: /\b(business|biz|j\s*class|c\s*class|busi?ness class)\b/i,
  PREMIUM_ECONOMY: /\b(premium\s*economy|prem(?:ium)?\s*eco|w\s*class|\bPE\b)\b/i,
  ECONOMY: /\b(economy|eco|y\s*class|coach)\b/i,
};
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, single: 1, couple: 2 };
const PAX_NOUN = '(?:pax|passengers?|adults?|adt|seats?|people|persons|travell?ers|tickets?)';

function detectCabin(text) {
  const t = String(text || '');
  if (/\bpremium\s*economy\b|\bprem(?:ium)?\s*eco\b/i.test(t)) return 'PREMIUM_ECONOMY';
  // "first class" / "first" next to seats; avoid "first week", "first option"
  if (/\bfirst\s+class\b|\bf\s*class\b|\bfirst\s+(?:seats?|cabin|tickets?)\b|\b\d+\s+first\b/i.test(t)) return 'FIRST';
  if (CABIN_WORDS.BUSINESS.test(t)) return 'BUSINESS';
  if (CABIN_WORDS.ECONOMY.test(t)) return 'ECONOMY';
  return null;
}

function buildExtractorUserContent({ message, channel, today, timezone, context }) {
  const ctx = context || {};
  const lines = [
    `CURRENT_DATE: ${today} (${timezone || 'UTC'})`,
    `CHANNEL: ${channel}`,
  ];
  if (ctx.requirements) {
    lines.push('ACTIVE_REQUEST_REQUIREMENTS (trusted, produced by our system):');
    lines.push(JSON.stringify(compactRequirements(ctx.requirements)));
  } else {
    lines.push('ACTIVE_REQUEST_REQUIREMENTS: none (this is a new request)');
  }
  lines.push('MESSAGE (untrusted data – extract only what THIS message states):');
  lines.push(wrapUntrusted(message.subject ? `Subject: ${message.subject}\n${message.text}` : message.text));
  return lines.join('\n');
}

function compactRequirements(req) {
  const r = req || {};
  return {
    trip_type: r.trip_type || null,
    origin: r.origin ? r.origin.iata || r.origin.raw : null,
    destination: r.destination ? r.destination.iata || r.destination.raw : null,
    departure_date: r.departure_date || null,
    return_date: r.return_date || null,
    passengers: r.passengers || null,
    cabin: r.cabin || null,
    preferred_airlines: r.preferred_airlines || [],
    missing_fields: r.missing_fields || [],
  };
}

function textHas(text, needle) {
  if (!needle) return false;
  return String(text || '').toLowerCase().includes(String(needle).toLowerCase().trim());
}

function verifyLocation(loc, text, report, field) {
  if (!loc || (!loc.raw && !loc.iata)) return null;
  const evidence = (loc.raw && textHas(text, loc.raw)) || (loc.iata && new RegExp(`\\b${loc.iata}\\b`, 'i').test(text));
  if (!evidence) {
    report.push({ field, action: 'dropped', reason: 'not_in_message', value: loc });
    return null;
  }
  const resolved = resolveLocation(loc.raw || loc.iata, loc.iata ? String(loc.iata).toUpperCase() : null);
  if (!resolved || !resolved.iata) {
    report.push({ field, action: 'kept_unresolved', reason: 'unknown_location', value: loc });
    return { raw: loc.raw, iata: null };
  }
  if (loc.iata && resolved.iata !== String(loc.iata).toUpperCase()) {
    report.push({ field, action: 'corrected', reason: 'reference_airport', from: loc.iata, to: resolved.iata });
  }
  return { raw: loc.raw || resolved.raw, iata: resolved.iata };
}

function verifyPassengerCount(value, evidence, text) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 99) return undefined;
  if (n === 0) return 0;
  const span = evidence && textHas(text, evidence) ? evidence : text;
  const digits = new RegExp(`\\b${n}\\b`).test(span);
  const word = Object.entries(NUMBER_WORDS).some(([w, v]) => v === n && new RegExp(`\\b${w}\\b`, 'i').test(span));
  const solo = n === 1 && /\b(myself|me only|one pax|single pax|1 pax|for me)\b/i.test(span);
  return digits || word || solo ? n : undefined;
}

/**
 * Validate the model's delta against the message. Returns { delta, report }.
 * `context.requirements` (current RFQ) gives the anchor for "return 25th".
 */
function validateExtraction(ai, { text, today, context }) {
  const report = [];
  const src = String(text || '');
  const data = ai || {};
  const current = (context && context.requirements) || {};
  const delta = {
    intent: INTENTS.includes(data.intent) ? data.intent : 'NEW_QUOTE',
    is_update_to_existing: Boolean(data.is_update_to_existing),
    trip_type: null,
    origin: verifyLocation(data.origin, src, report, 'origin'),
    destination: verifyLocation(data.destination, src, report, 'destination'),
    segments: [],
    departure_date: null,
    return_date: null,
    date_flexibility_days: null,
    passengers: null,
    cabin: null,
    preferred_airlines: [],
    excluded_airlines: [],
    direct_only: null,
    max_stops: null,
    budget: null,
    currency: null,
    special_requests: [],
    urgency: null,
    ambiguities: Array.isArray(data.ambiguities) ? data.ambiguities.map(String).slice(0, 5) : [],
  };

  if (delta.origin && delta.destination && delta.origin.iata && delta.origin.iata === delta.destination.iata) {
    report.push({ field: 'destination', action: 'dropped', reason: 'same_as_origin' });
    delta.destination = null;
  }

  // Dates -----------------------------------------------------------------
  const dep = data.departure_date ? verifyDateEvidence(data.departure_date, data.departure_date_evidence, src, { today, anchor: null }) : null;
  if (dep) {
    if (dep.ok) delta.departure_date = dep.iso;
    report.push({ field: 'departure_date', action: dep.ok ? (dep.reason === 'verified' ? 'verified' : dep.reason) : 'dropped', reason: dep.reason });
  }
  const anchor = delta.departure_date || current.departure_date || null;
  const ret = data.return_date ? verifyDateEvidence(data.return_date, data.return_date_evidence, src, { today, anchor }) : null;
  if (ret) {
    if (ret.ok) delta.return_date = ret.iso;
    report.push({ field: 'return_date', action: ret.ok ? (ret.reason === 'verified' ? 'verified' : ret.reason) : 'dropped', reason: ret.reason });
  }
  for (const field of ['departure_date', 'return_date']) {
    if (delta[field] && delta[field] < today) {
      report.push({ field, action: 'dropped', reason: 'date_in_past', value: delta[field] });
      delta.ambiguities.push(`${field.replace('_', ' ')} ${delta[field]} is in the past`);
      delta[field] = null;
    }
  }
  if (delta.return_date && anchor && delta.return_date < anchor) {
    report.push({ field: 'return_date', action: 'dropped', reason: 'before_departure' });
    delta.ambiguities.push('return date is before the departure date');
    delta.return_date = null;
  }

  // Multi-city segments ---------------------------------------------------
  if (Array.isArray(data.segments)) {
    let segAnchor = null;
    for (const seg of data.segments.slice(0, 6)) {
      const origin = verifyLocation(seg.origin, src, report, 'segment.origin');
      const destination = verifyLocation(seg.destination, src, report, 'segment.destination');
      const date = seg.date ? verifyDateEvidence(seg.date, seg.date_evidence, src, { today, anchor: segAnchor }) : null;
      const iso = date && date.ok ? date.iso : null;
      if (iso) segAnchor = iso;
      if (origin || destination) delta.segments.push({ origin, destination, date: iso });
    }
  }

  // Trip type -------------------------------------------------------------
  const tt = TRIP_TYPES.includes(data.trip_type) ? data.trip_type : null;
  const oneWayWords = /\b(one[\s-]?way|oneway|\bOW\b|single journey|no return)\b/i.test(src);
  const returnWords = /\b(return(?:ing)?|round[\s-]?trip|\bRT\b|both ways|come back|coming back)\b/i.test(src);
  if (delta.return_date) delta.trip_type = 'ROUND_TRIP';
  else if (tt === 'ONE_WAY' && oneWayWords) delta.trip_type = 'ONE_WAY';
  else if (tt === 'ROUND_TRIP' && returnWords) delta.trip_type = 'ROUND_TRIP';
  else if (tt === 'MULTI_CITY' && delta.segments.length >= 2) delta.trip_type = 'MULTI_CITY';
  else if (tt && tt !== 'UNKNOWN') report.push({ field: 'trip_type', action: 'dropped', reason: 'not_stated', value: tt });

  // Passengers ------------------------------------------------------------
  if (data.passengers) {
    const pax = {};
    for (const key of ['adults', 'children', 'infants']) {
      const v = verifyPassengerCount(data.passengers[key], data.passengers_evidence, src);
      if (v === undefined) report.push({ field: `passengers.${key}`, action: 'dropped', reason: 'not_in_message', value: data.passengers[key] });
      else if (v !== null) pax[key] = v;
    }
    if (Object.keys(pax).length) delta.passengers = pax;
  }

  // Cabin -----------------------------------------------------------------
  if (data.cabin && data.cabin !== 'UNKNOWN') {
    const detected = detectCabin(src);
    if (detected === data.cabin || (data.cabin === 'FIRST' && /\bfirst\b/i.test(src) && !detected)) delta.cabin = data.cabin;
    else if (detected) {
      delta.cabin = detected;
      report.push({ field: 'cabin', action: 'corrected', from: data.cabin, to: detected });
    } else report.push({ field: 'cabin', action: 'dropped', reason: 'not_in_message', value: data.cabin });
  }

  // Airlines --------------------------------------------------------------
  for (const key of ['preferred_airlines', 'excluded_airlines']) {
    for (const name of Array.isArray(data[key]) ? data[key] : []) {
      if (isMentioned(name, src)) {
        const n = normalizeAirline(name);
        if (n && !delta[key].includes(n)) delta[key].push(n);
      } else report.push({ field: key, action: 'dropped', reason: 'not_in_message', value: name });
    }
  }

  // Misc ------------------------------------------------------------------
  if (Number.isInteger(data.date_flexibility_days) && data.date_flexibility_days >= 0 && data.date_flexibility_days <= 14) {
    if (/flexib|\+\/-|±|plus\/minus|plus or minus|\+-/i.test(src) && new RegExp(`\\b${data.date_flexibility_days}\\b`).test(src)) delta.date_flexibility_days = data.date_flexibility_days;
    else report.push({ field: 'date_flexibility_days', action: 'dropped', reason: 'not_in_message' });
  }
  if (typeof data.direct_only === 'boolean' && /\b(direct|non[\s-]?stop)\b/i.test(src)) delta.direct_only = data.direct_only;
  if (Number.isInteger(data.max_stops) && /\bstops?\b|\bconnection/i.test(src)) delta.max_stops = data.max_stops;
  if (typeof data.budget === 'number' && data.budget > 0 && new RegExp(String(Math.round(data.budget)).replace(/\B(?=(\d{3})+(?!\d))/g, ',?')).test(src)) {
    delta.budget = data.budget;
    delta.currency = data.currency && /^[A-Z]{3}$/.test(data.currency) ? data.currency : null;
  }
  delta.special_requests = (Array.isArray(data.special_requests) ? data.special_requests : []).map((s) => String(s).slice(0, 200)).slice(0, 10);
  if (data.urgency === 'HIGH' && /\b(urgent\w*|asap|immediate\w*|rush|priority|today|tonight|tomorrow|quickly|fast)\b/i.test(src)) delta.urgency = 'HIGH';
  else if (data.urgency === 'HIGH') report.push({ field: 'urgency', action: 'downgraded', reason: 'no_urgency_words' });

  return { delta, report };
}

/**
 * Rules-based extraction used when OpenAI is unavailable. Produces the same
 * delta shape as validateExtraction so the rest of the pipeline is identical.
 */
function rulesExtract({ text, today, context, intent }) {
  const src = String(text || '');
  const current = (context && context.requirements) || {};
  const delta = {
    intent: intent || 'NEW_QUOTE',
    is_update_to_existing: Boolean(context && context.requirements),
    trip_type: null,
    origin: null,
    destination: null,
    segments: [],
    departure_date: null,
    return_date: null,
    date_flexibility_days: null,
    passengers: null,
    cabin: detectCabin(src),
    preferred_airlines: [],
    excluded_airlines: [],
    direct_only: /\b(direct|non[\s-]?stop)\b/i.test(src) ? true : null,
    max_stops: null,
    budget: null,
    currency: null,
    special_requests: [],
    urgency: /\b(urgent\w*|asap|immediate\w*|rush)\b/i.test(src) ? 'HIGH' : null,
    ambiguities: [],
  };

  // Route: "from X to Y", "Y from X", "X to Y", "X-Y"
  const locs = findLocations(src);
  if (locs.length >= 1) {
    const fromIdx = locs.findIndex((l) => /\bfrom\s*$/i.test(src.slice(Math.max(0, l.index - 6), l.index)));
    const toIdx = locs.findIndex((l) => /\b(?:to|for|into)\s*$/i.test(src.slice(Math.max(0, l.index - 6), l.index)));
    let o = null;
    let d = null;
    if (fromIdx >= 0) {
      o = locs[fromIdx];
      d = toIdx >= 0 && toIdx !== fromIdx ? locs[toIdx] : locs.find((l, i) => i !== fromIdx) || null;
    } else if (locs.length >= 2) {
      [o, d] = locs;
    } else if (toIdx >= 0) {
      d = locs[toIdx];
    } else if (current.origin && current.origin.iata && !current.destination) {
      d = locs[0];
    } else if (!current.origin) {
      o = locs[0];
    }
    if (o) delta.origin = { raw: o.raw, iata: o.iata };
    if (d && (!o || d.iata !== o.iata)) delta.destination = { raw: d.raw, iata: d.iata };
  }

  // Passengers
  const pax = {};
  const adultRe = new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})\\s*(?:x\\s*)?(?:(?:business|first|economy|premium\\s+economy|biz)(?:\\s+class)?\\s+)?${PAX_NOUN}\\b`, 'i');
  const am = adultRe.exec(src);
  if (am) pax.adults = /^\d+$/.test(am[1]) ? Number(am[1]) : NUMBER_WORDS[am[1].toLowerCase()];
  const cm = /\b(\d{1,2}|one|two|three|four)\s*(?:child|children|kids?|chd)\b/i.exec(src);
  if (cm) pax.children = /^\d+$/.test(cm[1]) ? Number(cm[1]) : NUMBER_WORDS[cm[1].toLowerCase()];
  const im = /\b(\d{1,2}|one|two)\s*(?:infants?|inf|babies|baby)\b/i.exec(src);
  if (im) pax.infants = /^\d+$/.test(im[1]) ? Number(im[1]) : NUMBER_WORDS[im[1].toLowerCase()];
  if (Object.keys(pax).length) delta.passengers = pax;

  // Dates
  const mentions = findDates(src, { today, anchor: current.departure_date || null });
  const resolved = mentions.filter((m) => m.iso);
  const ambiguous = mentions.filter((m) => m.ambiguous);
  for (const a of ambiguous) {
    delta.ambiguities.push(a.candidates ? `"${a.text}" could mean ${a.candidates.join(' or ')}` : `"${a.text}" is not a specific date`);
  }
  const returns = resolved.filter((m) => m.role === 'return');
  const departures = resolved.filter((m) => m.role !== 'return');
  if (departures.length) delta.departure_date = departures[0].iso;
  if (returns.length) delta.return_date = returns[0].iso;
  else if (departures.length >= 2 && /\b(return|round[\s-]?trip|back)\b/i.test(src)) delta.return_date = departures[1].iso;
  if (!departures.length && resolved.length === 1 && !returns.length) delta.departure_date = resolved[0].iso;
  // A lone date when the departure is already known and a return is expected is the return date.
  if (delta.departure_date && !returns.length && departures.length === 1 && current.departure_date && current.departure_date !== delta.departure_date
    && current.trip_type === 'ROUND_TRIP' && !current.return_date && delta.departure_date > current.departure_date) {
    delta.return_date = delta.departure_date;
    delta.departure_date = null;
  }
  for (const field of ['departure_date', 'return_date']) {
    if (delta[field] && delta[field] < today) {
      delta.ambiguities.push(`${field.replace('_', ' ')} ${delta[field]} is in the past`);
      delta[field] = null;
    }
  }
  const depForCheck = delta.departure_date || current.departure_date;
  if (delta.return_date && depForCheck && diffDays(depForCheck, delta.return_date) < 0) {
    delta.ambiguities.push('return date is before the departure date');
    delta.return_date = null;
  }

  // Trip type
  if (delta.return_date) delta.trip_type = 'ROUND_TRIP';
  else if (/\b(one[\s-]?way|oneway|single journey|no return)\b/i.test(src)) delta.trip_type = 'ONE_WAY';
  else if (/\b(round[\s-]?trip|return)\b/i.test(src)) delta.trip_type = 'ROUND_TRIP';

  // Flexibility "+/- 1 day", "flexible ±2 days"
  const flex = /(?:\+\/-|\+-|±|plus\/minus|plus or minus)\s*(\d{1,2})\s*days?/i.exec(src);
  if (flex) delta.date_flexibility_days = Number(flex[1]);

  // Airlines: excluded when introduced by no/avoid/except/not
  for (const hit of findAirlines(src)) {
    const before = src.slice(Math.max(0, hit.index - 14), hit.index);
    const list = /\b(no|avoid|except|not|exclude|without)\s+$/i.test(before) ? delta.excluded_airlines : delta.preferred_airlines;
    if (!list.includes(hit.name)) list.push(hit.name);
  }
  if (/\bwheelchair|wchr\b/i.test(src)) delta.special_requests.push('Wheelchair assistance');
  if (/\b(vegetarian|vgml|hindu meal|halal|kosher)\b/i.test(src)) delta.special_requests.push('Special meal requested');
  if (/\bflexib/i.test(src) && delta.date_flexibility_days === null) delta.special_requests.push('Flexible dates');
  // A message naming a full route is a new trip unless it explicitly changes the current one.
  const fullRoute = Boolean(delta.origin && delta.destination);
  delta.is_update_to_existing = Boolean(context && context.requirements) && (!fullRoute || /\b(change|instead|make it|update|actually|correction)\b/i.test(src));
  return { delta, report: [{ field: '*', action: 'rules_fallback' }] };
}

module.exports = {
  TRIP_TYPES,
  CABINS,
  EXTRACTION_SCHEMA,
  buildExtractorUserContent,
  validateExtraction,
  rulesExtract,
  detectCabin,
  compactRequirements,
};
