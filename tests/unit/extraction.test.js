'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rulesExtract, validateExtraction } = require('../../lib/extraction');
const { rulesClassify, validateClassification } = require('../../lib/intents');
const { mergeRequirements } = require('../../lib/requirements');
const { buildClarification } = require('../../lib/clarification');

const today = '2026-10-05';

const SCENARIO_1 = `Hi team,

Need 3 business class seats from Mumbai to London.

Departure 17 November 2026, return 25 November.

Qatar preferred but open to Emirates.

Dates flexible +/- 1 day.

Please send best fare urgently.`;

function extractAndMerge(text, current) {
  const { delta } = rulesExtract({ text, today, context: { requirements: current } });
  return mergeRequirements(current, delta).requirements;
}

test('scenario 1 – complete request (rules path)', () => {
  const cls = validateClassification(rulesClassify({ message: { text: SCENARIO_1 }, today }), 0.7);
  assert.equal(cls.intent, 'NEW_QUOTE');
  assert.equal(cls.requires_human, false);
  const r = extractAndMerge(SCENARIO_1, null);
  assert.equal(r.origin.iata, 'BOM');
  assert.equal(r.destination.iata, 'LHR');
  assert.equal(r.trip_type, 'ROUND_TRIP');
  assert.equal(r.departure_date, '2026-11-17');
  assert.equal(r.return_date, '2026-11-25');
  assert.equal(r.passengers.adults, 3);
  assert.equal(r.cabin, 'BUSINESS');
  assert.deepEqual(r.preferred_airlines, ['Qatar Airways', 'Emirates']);
  assert.equal(r.date_flexibility_days, 1);
  assert.equal(r.urgency, 'HIGH');
  assert.equal(r.ready_for_processing, true);
  assert.deepEqual(r.missing_fields, []);
});

test('success-criteria one-liner', () => {
  const r = extractAndMerge('Hi team, need 3 business seats BOM-LHR 17 Nov return 25 Nov, Qatar preferred, urgent.', null);
  assert.equal(r.origin.iata, 'BOM');
  assert.equal(r.destination.iata, 'LHR');
  assert.equal(r.departure_date, '2026-11-17');
  assert.equal(r.return_date, '2026-11-25');
  assert.equal(r.passengers.adults, 3);
  assert.equal(r.cabin, 'BUSINESS');
  assert.deepEqual(r.preferred_airlines, ['Qatar Airways']);
  assert.equal(r.ready_for_processing, true);
});

test('scenario 2 – missing data is not invented', () => {
  const r = extractAndMerge('Need 2 business seats from Delhi to New York next week.', null);
  assert.equal(r.origin.iata, 'DEL');
  assert.equal(r.destination.iata, 'JFK');
  assert.equal(r.departure_date, null);
  assert.equal(r.ready_for_processing, false);
  assert.deepEqual(r.missing_fields, ['departure_date', 'trip_type']);
  const c = buildClarification({ missing: r.missing_fields, requirements: r, contactName: 'Priya', rfqNumber: 'OFF-RFQ-2026-000002' });
  assert.match(c.whatsapp_body, /exact departure date \(you mentioned "next week"\)/);
  assert.match(c.whatsapp_body, /one-way or return/);
});

test('section 14 – trip type unknown -> single compact question', () => {
  const r = extractAndMerge('Need 2 business class seats from Mumbai to London on 15 November.', null);
  assert.deepEqual(r.missing_fields, ['trip_type']);
  const c = buildClarification({ missing: r.missing_fields, requirements: r, rfqNumber: 'OFF-RFQ-2026-000003' });
  assert.match(c.question, /^Could you please confirm whether this is one-way or return travel\? If return, please also share the preferred return date\.$/);
});

test('scenario 3 – five WhatsApp messages merge into one complete RFQ', () => {
  const msgs = ['Need London from Mumbai business', '3 pax', '17 Nov', 'return 25th', 'Qatar if possible'];
  let req = null;
  const missingTrail = [];
  for (const text of msgs) {
    req = extractAndMerge(text, req);
    missingTrail.push(req.missing_fields.join(','));
  }
  assert.equal(missingTrail[0], 'departure_date,trip_type,passengers.adults');
  assert.equal(missingTrail[1], 'departure_date,trip_type');
  assert.equal(missingTrail[2], 'trip_type');
  assert.equal(missingTrail[3], '');
  assert.equal(req.origin.iata, 'BOM');
  assert.equal(req.destination.iata, 'LHR');
  assert.equal(req.passengers.adults, 3);
  assert.equal(req.departure_date, '2026-11-17');
  assert.equal(req.return_date, '2026-11-25');
  assert.equal(req.trip_type, 'ROUND_TRIP');
  assert.deepEqual(req.preferred_airlines, ['Qatar Airways']);
});

test('"make it 3 passengers" updates the count and excluded airlines override preferences', () => {
  let req = extractAndMerge('2 pax BOM to DXB business 17 Nov one way, Emirates preferred', null);
  assert.equal(req.trip_type, 'ONE_WAY');
  req = extractAndMerge('make it 3 passengers', req);
  assert.equal(req.passengers.adults, 3);
  req = extractAndMerge('actually no Emirates please', req);
  assert.deepEqual(req.preferred_airlines, []);
  assert.deepEqual(req.excluded_airlines, ['Emirates']);
});

test('validateExtraction drops hallucinated values and corrects dates', () => {
  const text = 'Need 3 business seats BOM-LHR 17 Nov return 25 Nov, Qatar preferred, urgent.';
  const ai = {
    intent: 'NEW_QUOTE', is_update_to_existing: false, trip_type: 'ROUND_TRIP',
    origin: { raw: 'BOM', iata: 'BOM' }, destination: { raw: 'LHR', iata: 'LHR' }, segments: [],
    departure_date: '2027-11-17', departure_date_evidence: '17 Nov',
    return_date: '2026-11-25', return_date_evidence: 'return 25 Nov',
    date_flexibility_days: 2, passengers: { adults: 3, children: 1, infants: null }, passengers_evidence: '3 business seats',
    cabin: 'FIRST', preferred_airlines: ['Qatar Airways', 'Etihad'], excluded_airlines: [],
    direct_only: null, max_stops: null, budget: 5000, currency: 'USD', special_requests: [], urgency: 'HIGH', ambiguities: [],
  };
  const { delta, report } = validateExtraction(ai, { text, today, context: {} });
  assert.equal(delta.departure_date, '2026-11-17'); // corrected year
  assert.equal(delta.return_date, '2026-11-25');
  assert.equal(delta.cabin, 'BUSINESS'); // FIRST not in text -> corrected
  assert.deepEqual(delta.preferred_airlines, ['Qatar Airways']); // Etihad dropped
  assert.equal(delta.passengers.adults, 3);
  assert.equal(delta.passengers.children, undefined); // "1 child" not in text
  assert.equal(delta.date_flexibility_days, null);
  assert.equal(delta.budget, null);
  assert.equal(delta.urgency, 'HIGH');
  assert.ok(report.some((r) => r.field === 'preferred_airlines' && r.action === 'dropped'));
});

test('validateExtraction rejects a date resolved from an ambiguous phrase', () => {
  const text = 'Need 2 business seats from Delhi to New York next week.';
  const ai = {
    intent: 'NEW_QUOTE', trip_type: null, origin: { raw: 'Delhi', iata: 'DEL' }, destination: { raw: 'New York', iata: 'JFK' }, segments: [],
    departure_date: '2026-10-12', departure_date_evidence: 'next week', return_date: null, return_date_evidence: null,
    passengers: { adults: 2, children: null, infants: null }, passengers_evidence: '2 business seats', cabin: 'BUSINESS',
    preferred_airlines: [], excluded_airlines: [], special_requests: [], ambiguities: [],
  };
  const { delta } = validateExtraction(ai, { text, today, context: {} });
  assert.equal(delta.departure_date, null);
  assert.equal(delta.origin.iata, 'DEL');
  assert.equal(delta.destination.iata, 'JFK');
});

test('past dates and return-before-departure are rejected', () => {
  const r = extractAndMerge('BOM LHR business 2 pax 17 Nov return 10 Nov 2026', null);
  assert.equal(r.departure_date, '2026-11-17');
  assert.equal(r.return_date, null);
  assert.ok(r.missing_fields.includes('return_date'));
  const p = extractAndMerge('BOM LHR business 2 pax one way 01/09/2026', null);
  assert.equal(p.departure_date, null);
});
