'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFareOptions } = require('../../lib/fares');
const Q = require('../../lib/quote');
const { reconcileResponse, rulesInterpret, confirmationQuestion } = require('../../lib/responses');
const { MockFareProvider } = require('../../lib/providers/mockFareProvider');
const { AmadeusFareProvider } = require('../../lib/providers/fareProvider');

const now = '2026-10-05T12:00:00Z';
const requirements = {
  trip_type: 'ROUND_TRIP', origin: { iata: 'BOM' }, destination: { iata: 'LHR' }, departure_date: '2026-11-17', return_date: '2026-11-25',
  passengers: { adults: 3, children: 0, infants: 0 }, cabin: 'BUSINESS', preferred_airlines: ['Qatar Airways'],
};
const rfq = { rfq_number: 'OFF-RFQ-2026-000001', trip_type: 'ROUND_TRIP', cabin: 'BUSINESS' };

function demoOptions() {
  const raw = MockFareProvider.sampleOptions(requirements, now);
  const v = validateFareOptions(raw, { rfq, now });
  assert.equal(v.ok, true, v.errors.join('; '));
  return v.options;
}

test('mock fare desk produces the demo Qatar option at USD 2,450 / 40 kg / 150 / 250', () => {
  const [qr] = demoOptions();
  assert.equal(qr.airline, 'Qatar Airways');
  assert.equal(qr.fare.amount, 2450);
  assert.equal(qr.baggage, '40 kg');
  assert.equal(qr.change_penalty, 'USD 150');
  assert.equal(qr.refund_penalty, 'USD 250');
  assert.equal(qr.option_code, 'OPT-001');
  assert.equal(qr.stops, 1);
});

test('fare validation rejects incomplete or unsafe options', () => {
  const bad = validateFareOptions([{ airline: '', fare: { amount: -5, currency: 'US' }, cabin: 'LUXURY', departure_at: 'tomorrow', fare_valid_until: '2020-01-01T00:00:00Z', verified: false }], { rfq, now });
  assert.equal(bad.ok, false);
  const text = bad.errors.join('\n');
  for (const needle of ['airline is required', 'positive number', '3-letter', 'cabin must be', 'departure_at', 'baggage', 'change penalty', 'refund penalty', 'already in the past', 'return flight is required', 'verified']) {
    assert.match(text, new RegExp(needle), needle);
  }
  assert.equal(validateFareOptions([], { rfq, now }).ok, false);
});

test('templates contain exact fare strings and pass the validator', () => {
  const model = Q.buildQuoteModel({ rfq, requirements, contact: { first_name: 'John' }, options: demoOptions(), timeZone: 'UTC', now });
  const email = Q.renderEmail(model);
  const wa = Q.renderWhatsApp(model);
  assert.match(email.body, /OPTION 1 — Qatar Airways/);
  assert.match(email.body, /USD 2,450 per passenger \(USD 7,350 total for 3 passengers\)/);
  assert.match(email.body, /Mumbai \(BOM\) → Doha \(DOH\) → London Heathrow \(LHR\)/);
  assert.match(email.body, /17 November 2026/);
  assert.match(email.body, /Fares and availability remain subject to confirmation until ticketed\./);
  assert.ok(wa.length < email.body.length / 1.5, 'WhatsApp version is compact');
  const check = Q.validateFormattedQuote({ email_subject: email.subject, email_body: email.body, whatsapp_body: wa }, model);
  assert.deepEqual(check.errors, []);
});

test('AI output that alters a fare (2450 -> 2400) is rejected', () => {
  const model = Q.buildQuoteModel({ rfq, requirements, contact: { first_name: 'John' }, options: demoOptions(), timeZone: 'UTC', now });
  const email = Q.renderEmail(model);
  const wa = Q.renderWhatsApp(model);
  const tampered = { email_subject: email.subject, email_body: email.body.replace('USD 2,450 per passenger', 'USD 2,400 per passenger'), whatsapp_body: wa };
  const r = Q.validateFormattedQuote(tampered, model);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /fare "USD 2,450 per passenger" missing or altered/.test(e)));
  assert.ok(r.errors.some((e) => /numbers not present in fare data: 2400/.test(e)));
});

test('AI output that invents a number, a discount or drops the disclaimer is rejected', () => {
  const model = Q.buildQuoteModel({ rfq, requirements, contact: null, options: demoOptions(), timeZone: 'UTC', now });
  const email = Q.renderEmail(model);
  const wa = Q.renderWhatsApp(model);
  assert.equal(Q.validateFormattedQuote({ email_subject: email.subject, email_body: `${email.body}\nOnly 2 seats left!`, whatsapp_body: wa }, model).ok, true, '2 is an existing option number');
  assert.equal(Q.validateFormattedQuote({ email_subject: email.subject, email_body: `${email.body}\nOnly 4 seats left!`, whatsapp_body: wa }, model).ok, false);
  assert.equal(Q.validateFormattedQuote({ email_subject: email.subject, email_body: `${email.body}\nSpecial discounted fare.`, whatsapp_body: wa }, model).ok, false);
  assert.equal(Q.validateFormattedQuote({ email_subject: email.subject, email_body: email.body.replace(Q.DISCLAIMER, ''), whatsapp_body: wa }, model).ok, false);
});

test('scenario 5 – "Option 2 works. Please proceed." selects OPT-002', () => {
  const options = demoOptions().map((o) => ({ option_no: o.option_no, option_code: o.option_code, airline: o.airline }));
  const r = reconcileResponse({ action: 'SELECT_OPTION', selected_option_number: 2, confidence: 0.94, requested_airlines: [], reason: '' }, 'Option 2 works. Please proceed.', options, 0.7);
  assert.equal(r.intent, 'BOOKING_CONFIRMATION');
  assert.equal(r.selected_option_code, 'OPT-002');
  assert.equal(r.needs_confirmation, false);
  // rules-only path gives the same answer
  const rules = reconcileResponse(null, 'Option 2 looks good, please proceed.', options, 0.7);
  assert.equal(rules.selected_option_code, 'OPT-002');
  assert.equal(rules.needs_confirmation, false);
});

test('selection variants and ambiguity', () => {
  const options = [{ option_no: 1, option_code: 'OPT-001', airline: 'Qatar Airways' }, { option_no: 2, option_code: 'OPT-002', airline: 'Emirates' }, { option_no: 3, option_code: 'OPT-003', airline: 'British Airways' }];
  assert.equal(reconcileResponse(null, 'second one', options).selected_option_code, 'OPT-002');
  assert.equal(reconcileResponse(null, 'book Qatar', options).selected_option_code, 'OPT-001');
  assert.equal(reconcileResponse(null, '3', options).selected_option_code, 'OPT-003');
  // AI claims option 1 but the message gives no evidence -> confirmation required
  const goAhead = reconcileResponse({ action: 'SELECT_OPTION', selected_option_number: 1, confidence: 0.9, requested_airlines: [], reason: '' }, 'go ahead', options);
  assert.equal(goAhead.needs_confirmation, true);
  assert.equal(goAhead.selected_option_code, null);
  assert.equal(reconcileResponse(null, 'option 1 or 2 is fine', options).needs_confirmation, true);
  assert.equal(reconcileResponse(null, 'option 5 please', options).needs_confirmation, true);
  // AI picks a different option than the message states -> confirmation
  assert.equal(reconcileResponse({ action: 'SELECT_OPTION', selected_option_number: 1, confidence: 0.95, requested_airlines: [], reason: '' }, 'Option 2 please', options).needs_confirmation, true);
  assert.match(confirmationQuestion(options, 'John'), /Option 1 \(Qatar Airways\), Option 2 \(Emirates\), Option 3 \(British Airways\)/);
});

test('scenario 6 and other reply types', () => {
  const options = [{ option_no: 1, option_code: 'OPT-001', airline: 'Qatar Airways' }, { option_no: 2, option_code: 'OPT-002', airline: 'British Airways' }];
  const price = reconcileResponse(null, 'Too expensive. Anything cheaper?', options);
  assert.equal(price.action, 'PRICE_OBJECTION');
  assert.equal(price.intent, 'PRICE_CHECK');
  assert.equal(rulesInterpret('please hold', options).action, 'HOLD');
  assert.equal(rulesInterpret('change dates to 18th', options).action, 'CHANGE_REQUIREMENTS');
  const alt = reconcileResponse(null, 'can you check Emirates?', options);
  assert.equal(alt.action, 'ALTERNATIVE_REQUEST');
  assert.deepEqual(alt.requested_airlines, ['Emirates']);
  assert.equal(rulesInterpret('client has booked elsewhere, not needed', options).action, 'DECLINE');
});

test('GDS providers are explicit placeholders, not fake integrations', async () => {
  await assert.rejects(() => new AmadeusFareProvider().searchFlights({}), (e) => e.code === 'FARE_PROVIDER_NOT_CONFIGURED');
});
