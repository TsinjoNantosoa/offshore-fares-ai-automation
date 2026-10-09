'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decideRoute, decideIntake, shouldStartNewRfq } = require('../../lib/router');
const SM = require('../../lib/stateMachine');

const today = '2026-10-05';
const quoted = { rfq_number: 'OFF-RFQ-2026-000031', status: 'AWAITING_CLIENT', origin_iata: 'BOM', destination_iata: 'LHR', correlation: 'SAME_CONVERSATION' };

test('replies to a quoted RFQ go to the response handler', () => {
  const r = decideRoute({ message: { text: 'Option 2 works. Please proceed.' }, active_rfq: quoted }, today);
  assert.equal(r.route, 'REPLY');
});

test('a brand-new route in the same thread is a new request, not a reply', () => {
  const r = decideRoute({ message: { text: 'Also need 2 business DEL to JFK on 3 Dec one way' }, active_rfq: quoted }, today);
  assert.equal(r.route, 'INTAKE');
  assert.equal(r.active_rfq, null);
});

test('weak cross-channel correlation is ignored when the message has its own route', () => {
  const weak = Object.assign({}, quoted, { correlation: 'CONTACT_SINGLE_OPEN_RFQ' });
  assert.equal(decideRoute({ message: { text: 'Need London from Mumbai business' }, active_rfq: weak }, today).active_rfq, null);
  assert.equal(decideRoute({ message: { text: 'option 2 please' }, active_rfq: weak }, today).route, 'REPLY');
});

test('opt-out and empty messages', () => {
  assert.equal(decideRoute({ message: { text: 'STOP' } }, today).route, 'OPT_OUT');
  assert.equal(decideRoute({ message: { text: '  ' } }, today).route, 'IGNORE');
});

test('intake decisions', () => {
  assert.equal(decideIntake({ intent: 'NEW_QUOTE', requires_human: false }).path, 'EXTRACT');
  assert.equal(decideIntake({ intent: 'CHANGE_REQUEST' }).path, 'AFTER_SALES');
  assert.equal(decideIntake({ intent: 'REFUND_REQUEST' }).path, 'AFTER_SALES');
  const inj = decideIntake({ intent: 'OTHER', requires_human: true, reason: 'instruction override' }, null, { injection_suspected: true });
  assert.equal(inj.path, 'HUMAN');
  assert.equal(inj.flag_security, true);
  assert.equal(decideIntake({ intent: 'BAGGAGE_QUERY' }).path, 'HUMAN');
});

test('merge vs new RFQ', () => {
  const draft = { status: 'NEEDS_INFORMATION', origin_iata: 'BOM', destination_iata: 'LHR' };
  assert.equal(shouldStartNewRfq(draft, { passengers: { adults: 3 } }).new_rfq, false);
  assert.equal(shouldStartNewRfq(draft, { origin: { iata: 'DEL' }, destination: { iata: 'JFK' }, is_update_to_existing: false }).new_rfq, true);
  assert.equal(shouldStartNewRfq(draft, { origin: { iata: 'BOM' }, destination: { iata: 'DXB' }, is_update_to_existing: true }).new_rfq, false);
  assert.equal(shouldStartNewRfq({ status: 'TICKETED' }, {}).new_rfq, true);
  assert.equal(shouldStartNewRfq(quoted, { departure_date: '2026-11-18' }, true).new_rfq, false);
  assert.equal(shouldStartNewRfq(null, {}).new_rfq, true);
});

test('state machine in SQL is identical to lib/stateMachine.js', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8');
  const block = sql.split('INSERT INTO rfq_status_transitions')[1].split(';')[0];
  const pairs = new Set(Array.from(block.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)).map((m) => `${m[1]}>${m[2]}`));
  const js = new Set(Object.entries(SM.TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`)));
  assert.deepEqual([...pairs].filter((p) => !js.has(p)), [], 'in SQL but not in JS');
  assert.deepEqual([...js].filter((p) => !pairs.has(p)), [], 'in JS but not in SQL');
  const statusBlock = sql.split('INSERT INTO rfq_statuses')[1].split(';')[0];
  const statuses = Array.from(statusBlock.matchAll(/\('([A-Z_]+)', '/g)).map((m) => m[1]);
  assert.deepEqual(statuses, SM.STATUSES);
});
