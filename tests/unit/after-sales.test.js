'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRequest, parentSummary } = require('../../lib/afterSales');
const { routeToDesk } = require('../../lib/routing');

const today = '2026-10-14';
const parent = {
  id: '00000000-0000-0000-0000-000000000032',
  rfq_number: 'OFF-RFQ-2026-000032',
  origin_iata: 'DEL', destination_iata: 'JFK', trip_type: 'ROUND_TRIP',
  departure_date: '2026-11-20', return_date: '2026-11-27', cabin: 'BUSINESS',
  requirements: { passengers: { adults: 2, children: 0, infants: 0 } },
  selected_option: { code: 'OPT-002', airline: 'Emirates', fare_amount: 2610, fare_currency: 'USD' },
};

test('after-sales day-only changes use the parent departure month', () => {
  assert.equal(resolveRequest({ text: 'change dates to 18th', today, parent, intent: 'CHANGE_REQUEST' }).requested_departure_date, '2026-11-18');
  assert.equal(resolveRequest({ text: 'change departure to the 22nd', today, parent, intent: 'CHANGE_REQUEST' }).requested_departure_date, '2026-11-22');
});

test('after-sales return day-only changes use the parent return month', () => {
  const crossMonth = Object.assign({}, parent, { departure_date: '2026-11-28', return_date: '2026-12-05' });
  const r = resolveRequest({ text: 'change return to 18th', today, parent: crossMonth, intent: 'CHANGE_REQUEST' });
  assert.equal(r.requested_departure_date, null);
  assert.equal(r.requested_return_date, '2026-12-18');
  assert.equal(r.clarification_required, false);

  const missingReturn = resolveRequest({ text: 'change inbound to 18th', today, parent: Object.assign({}, crossMonth, { return_date: null }), intent: 'CHANGE_REQUEST' });
  assert.equal(missingReturn.requested_return_date, null);
  assert.equal(missingReturn.clarification_required, true);
});

test('after-sales explicit month keeps deterministic year resolution', () => {
  assert.equal(resolveRequest({ text: 'change to 18 December', today, parent, intent: 'CHANGE_REQUEST' }).requested_departure_date, '2026-12-18');
  assert.equal(resolveRequest({ text: 'change to 3 January', today, parent, intent: 'CHANGE_REQUEST' }).requested_departure_date, '2027-01-03');
});

test('ambiguous after-sales dates are not invented and require clarification', () => {
  const r = resolveRequest({ text: 'change my flight next week', today, parent, intent: 'CHANGE_REQUEST' });
  assert.equal(r.requested_departure_date, null);
  assert.equal(r.requested_return_date, null);
  assert.equal(r.clarification_required, true);
  assert.match(r.ambiguities[0], /not a specific date/);
  const noParent = resolveRequest({ text: 'change dates to 18th', today, parent: null, intent: 'CHANGE_REQUEST' });
  assert.equal(noParent.requested_departure_date, null);
  assert.equal(noParent.clarification_required, true);
});

test('parent context preserves route, passengers, cabin, option and original dates', () => {
  assert.deepEqual(parentSummary(parent), {
    parent_rfq_id: parent.id, parent_rfq_number: parent.rfq_number,
    origin: 'DEL', destination: 'JFK', trip_type: 'ROUND_TRIP',
    passengers: { adults: 2, children: 0, infants: 0 }, cabin: 'BUSINESS',
    selected_option: parent.selected_option,
    departure_date: '2026-11-20', return_date: '2026-11-27', booking_reference: null,
  });
});

test('change and refund routing remain unchanged', () => {
  assert.equal(routeToDesk({ intent: 'CHANGE_REQUEST', requirements: {} }).desk_code, 'TICKETING_DESK');
  assert.equal(routeToDesk({ intent: 'REFUND_REQUEST', requirements: {} }).desk_code, 'REFUND_DESK');
});
