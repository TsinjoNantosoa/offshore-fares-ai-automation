'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../lib/dates');

const today = '2026-10-05'; // Monday

test('explicit day-month resolves to the next future occurrence', () => {
  const [m] = D.findDates('Departure 17 November', { today });
  assert.equal(m.iso, '2026-11-17');
  assert.equal(D.findDates('on 3 Feb', { today })[0].iso, '2027-02-03');
  assert.equal(D.findDates('Nov 17th, 2026', { today })[0].iso, '2026-11-17');
  assert.equal(D.findDates('17/11/2026', { today })[0].iso, '2026-11-17');
});

test('return keyword marks the return role and day-only uses the departure month', () => {
  const ms = D.findDates('17 Nov return 25th', { today });
  assert.equal(ms[0].iso, '2026-11-17');
  assert.equal(ms[1].iso, '2026-11-25');
  assert.equal(ms[1].role, 'return');
  const anchored = D.findDates('return 25th', { today, anchor: '2026-11-17' });
  assert.equal(anchored[0].iso, '2026-11-25');
  // day before the anchor day rolls to the next month
  assert.equal(D.findDates('return 5th', { today, anchor: '2026-11-17' })[0].iso, '2026-12-05');
});

test('ranges produce departure and return', () => {
  const ms = D.findDates('travel 17-25 Nov', { today });
  assert.deepEqual(ms.map((m) => m.iso), ['2026-11-17', '2026-11-25']);
});

test('relative dates', () => {
  assert.equal(D.findDates('tomorrow', { today })[0].iso, '2026-10-06');
  assert.equal(D.findDates("tomorrow's flight", { today })[0].iso, '2026-10-06');
  assert.equal(D.findDates('this Friday', { today })[0].iso, '2026-10-09');
  assert.equal(D.findDates('in 3 days', { today })[0].iso, '2026-10-08');
});

test('ambiguous expressions are never resolved', () => {
  for (const phrase of ['next week', 'next month', 'mid November', 'early December', 'in November', 'this weekend']) {
    const ms = D.findDates(phrase, { today });
    assert.ok(ms.length >= 1, phrase);
    assert.ok(ms.every((m) => m.iso === null && m.ambiguous), phrase);
  }
  const nf = D.findDates('next Friday', { today })[0];
  assert.equal(nf.iso, null);
  assert.deepEqual(nf.candidates, ['2026-10-09', '2026-10-16']);
});

test('numbers that are not dates are ignored', () => {
  assert.equal(D.findDates('3 pax, 40 kg, flexible +/- 1 day', { today }).filter((m) => m.iso).length, 0);
});

test('verifyDateEvidence accepts, corrects or rejects AI dates', () => {
  const text = 'Need BOM-LHR 17 Nov return 25 Nov';
  assert.deepEqual(D.verifyDateEvidence('2026-11-17', '17 Nov', text, { today }).ok, true);
  // AI picked the wrong year -> corrected by the deterministic parser
  const fixed = D.verifyDateEvidence('2027-11-17', '17 Nov', text, { today });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.iso, '2026-11-17');
  // evidence not present in the message -> rejected (hallucination guard)
  assert.equal(D.verifyDateEvidence('2026-11-18', '18 Nov', text, { today }).ok, false);
  // ambiguous evidence -> rejected
  assert.equal(D.verifyDateEvidence('2026-10-12', 'next week', 'fly next week', { today }).reason, 'ambiguous_expression');
});

test('hoursUntil uses the business timezone', () => {
  const now = '2026-10-05T12:00:00Z';
  assert.equal(Math.round(D.hoursUntil('2026-10-06', now, 'UTC')), 12);
  assert.equal(Math.round(D.hoursUntil('2026-10-06', now, 'Asia/Kolkata')), 7); // 00:00 IST = 18:30 UTC
});

test('formatting', () => {
  assert.equal(D.formatLong('2026-11-17'), '17 November 2026');
  assert.equal(D.formatShort('2026-11-17'), '17 Nov 2026');
  assert.equal(D.formatDateTime('2026-11-17T04:15'), '17 Nov 2026, 04:15');
});
