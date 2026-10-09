'use strict';
/**
 * WF10 – Quote model, deterministic templates and AI-output validation.
 *
 * All commercial strings (fares, penalties, baggage, dates, flight numbers) are
 * formatted HERE from structured fare data. The model may only re-phrase the
 * surrounding text; validateFormattedQuote() rejects any output that alters,
 * omits or invents a number, in which case the deterministic template is used.
 */
const { S } = require('./openai');
const { containsSecret } = require('./security');
const { formatMoney, listJoin } = require('./text');
const { formatLong, formatShort, formatDateTime } = require('./dates');
const { cityName } = require('./airports');
const { CABIN_LABEL, paxLabel } = require('./requirements');
const { isExpired } = require('./fares');

const QUOTE_SCHEMA = S.obj({
  email_subject: S.str(),
  email_body: S.str(),
  whatsapp_body: S.str(),
});

const DISCLAIMER = 'Fares and availability remain subject to confirmation until ticketed.';

function formatInZone(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]));
    return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${timeZone || 'UTC'}`;
  } catch (_) {
    return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

function durationLabel(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function routeOf(segments, direction) {
  const segs = (segments || []).filter((s) => s.direction === direction);
  if (!segs.length) return null;
  const codes = [segs[0].from].concat(segs.map((s) => s.to));
  return codes;
}

/** Build the canonical quote model from an RFQ, contact and validated fare options. */
function buildQuoteModel({ rfq, requirements, contact, options, timeZone, now }) {
  const req = requirements || {};
  const pax = req.passengers || {};
  const payingPax = (pax.adults || 0) + (pax.children || 0);
  const cabin = CABIN_LABEL[req.cabin] || 'Business';
  const opts = (options || []).map((o, i) => {
    const outCodes = routeOf(o.flight_segments, 'OUTBOUND') || [req.origin && req.origin.iata, req.destination && req.destination.iata].filter(Boolean);
    const inCodes = routeOf(o.flight_segments, 'INBOUND');
    const amount = Number(o.fare.amount);
    const perPax = o.fare_basis !== 'TOTAL';
    const total = perPax && payingPax > 0 ? amount * payingPax : null;
    const outSegs = (o.flight_segments || []).filter((s) => s.direction === 'OUTBOUND');
    const inSegs = (o.flight_segments || []).filter((s) => s.direction === 'INBOUND');
    return {
      no: i + 1,
      option_code: o.option_code || `OPT-${String(i + 1).padStart(3, '0')}`,
      airline: o.airline,
      route_label: outCodes.map((c) => `${cityName(c)} (${c})`).join(' → '),
      route_codes: outCodes.join(' → '),
      return_route_codes: inCodes ? inCodes.join(' → ') : null,
      outbound_flights: outSegs.map((s) => s.flight_no).filter(Boolean).join(' / ') || null,
      return_flights: inSegs.map((s) => s.flight_no).filter(Boolean).join(' / ') || null,
      departure_label: formatDateTime(o.departure_at),
      departure_date_label: formatLong(String(o.departure_at).slice(0, 10)),
      return_label: o.return_departure_at ? formatDateTime(o.return_departure_at) : null,
      return_date_label: o.return_departure_at ? formatLong(String(o.return_departure_at).slice(0, 10)) : null,
      stops_label: o.stops === 0 ? 'Non-stop' : `${o.stops} stop${o.stops > 1 ? 's' : ''}${outCodes.length > 2 ? ` (${outCodes.slice(1, -1).join(', ')})` : ''}`,
      duration_label: durationLabel(o.total_duration_minutes),
      cabin_label: `${CABIN_LABEL[o.cabin] || cabin} Class`,
      fare_amount_label: formatMoney(amount, o.fare.currency),
      fare_label: perPax ? `${formatMoney(amount, o.fare.currency)} per passenger` : `${formatMoney(amount, o.fare.currency)} total`,
      total_label: total ? `${formatMoney(total, o.fare.currency)} total for ${payingPax} passenger${payingPax > 1 ? 's' : ''}` : null,
      baggage: o.baggage,
      change_penalty: o.change_penalty,
      refund_penalty: o.refund_penalty,
      validity_label: formatInZone(o.fare_valid_until, timeZone),
      expired: isExpired(o, now),
    };
  });
  const first = (contact && (contact.first_name || contact.name)) || null;
  return {
    rfq_number: rfq.rfq_number,
    greeting_name: first,
    cabin_label: `${cabin} Class`,
    route_summary: `${req.origin ? req.origin.iata : ''} → ${req.destination ? req.destination.iata : ''}`,
    travel_dates: req.return_date ? `${formatShort(req.departure_date)} – ${formatShort(req.return_date)}` : formatShort(req.departure_date),
    pax_label: paxLabel(req),
    preferred_airlines: req.preferred_airlines || [],
    options: opts,
    disclaimer: DISCLAIMER,
  };
}

function renderEmail(model, signature) {
  const lines = [];
  lines.push(model.greeting_name ? `Dear ${model.greeting_name},` : 'Dear Partner,', '');
  lines.push('Thank you for your request.', '');
  lines.push(`Please find the available ${model.cabin_label} options below for ${model.route_summary} (${model.travel_dates}, ${model.pax_label}).`, '');
  for (const o of model.options) {
    lines.push(`OPTION ${o.no} — ${o.airline}`, '');
    lines.push('Route:', `${o.route_label} (${o.stops_label})`, '');
    lines.push('Departure:', `${o.departure_date_label}${o.outbound_flights ? ` — ${o.outbound_flights}, departs ${o.departure_label}` : ''}`, '');
    if (o.return_date_label) lines.push('Return:', `${o.return_date_label}${o.return_flights ? ` — ${o.return_flights}, departs ${o.return_label}` : ''}`, '');
    lines.push('Cabin:', o.cabin_label, '');
    lines.push('Fare:', o.fare_label + (o.total_label ? ` (${o.total_label})` : ''), '');
    lines.push('Baggage:', o.baggage, '');
    lines.push('Change penalty:', o.change_penalty, '');
    lines.push('Refund penalty:', o.refund_penalty, '');
    lines.push('Fare validity:', `until ${o.validity_label}`, '');
  }
  lines.push('Please let us know which option you would like to proceed with.', '');
  lines.push(model.disclaimer, '');
  lines.push('Kind regards,', signature || 'Offshore Fares');
  const subject = `${model.rfq_number} | ${model.cabin_label} options ${model.route_summary} (${model.travel_dates})`;
  return { subject, body: lines.join('\n') };
}

function renderWhatsApp(model) {
  const lines = [];
  lines.push(`${model.greeting_name ? `Hi ${model.greeting_name}, here` : 'Here'} are the ${model.cabin_label} options for ${model.route_summary} (${model.travel_dates}, ${model.pax_label}) – ref ${model.rfq_number}`);
  for (const o of model.options) {
    lines.push('');
    lines.push(`*Option ${o.no} – ${o.airline}*`);
    lines.push(`${o.route_codes} · ${o.stops_label}`);
    lines.push(`Out ${o.departure_label}${o.return_label ? ` · Ret ${o.return_label}` : ''}`);
    lines.push(`${o.fare_label}${o.total_label ? ` (${o.total_label})` : ''}`);
    lines.push(`Bag ${o.baggage} · Change ${o.change_penalty} · Refund ${o.refund_penalty}`);
  }
  lines.push('');
  const validity = model.options.map((o) => o.validity_label).sort()[0];
  lines.push(`Valid until ${validity}. Reply with the option number to proceed. ${model.disclaimer}`);
  return lines.join('\n');
}

function buildFormatterUserContent(model, channelHint) {
  return [
    `PRIMARY_CHANNEL: ${channelHint || 'email'}`,
    'QUOTE_DATA (trusted, produced by our fare desk – copy every value verbatim):',
    JSON.stringify(model, null, 2),
    'The agent request is summarised in QUOTE_DATA. Do not use any other source.',
  ].join('\n');
}

/** Numeric tokens normalised for comparison ("2,450.00" -> "2450", "02:40" -> "2:40"). */
function numericTokens(text) {
  const out = [];
  const re = /\d[\d,]*(?:\.\d+)?(?::\d{2})?/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    let t = m[0].replace(/,(?=\d{3}\b)/g, '').replace(/,$/, '');
    if (t.includes(':')) t = t.split(':').map((p) => String(Number(p))).join(':');
    else if (t.includes('.')) t = String(Number(t));
    else t = String(Number(t));
    out.push(t);
  }
  return out;
}

const FORBIDDEN = /\b(guaranteed|is confirmed|are confirmed|confirmed booking|has been booked|(?:has been|have been|is|are) ticketed|discount(?:ed)?|special price)\b/i;

/**
 * Validate AI-formatted text against the quote model.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateFormattedQuote(ai, model) {
  const errors = [];
  const data = ai || {};
  const email = String(data.email_body || '');
  const wa = String(data.whatsapp_body || '');
  const subject = String(data.email_subject || '');
  if (!email.trim()) errors.push('email_body is empty');
  if (!wa.trim()) errors.push('whatsapp_body is empty');
  if (wa.length > 4000) errors.push('whatsapp_body exceeds WhatsApp limit');
  const allowed = new Set(numericTokens(JSON.stringify(model)));
  for (const o of model.options) {
    for (const [label, value] of [['fare', o.fare_label], ['baggage', o.baggage], ['change penalty', o.change_penalty], ['refund penalty', o.refund_penalty], ['airline', o.airline]]) {
      if (value && !email.includes(value)) errors.push(`email: option ${o.no} ${label} "${value}" missing or altered`);
    }
    if (!email.includes(o.departure_date_label)) errors.push(`email: option ${o.no} departure date missing or altered`);
    if (o.return_date_label && !email.includes(o.return_date_label)) errors.push(`email: option ${o.no} return date missing or altered`);
    if (!wa.includes(o.fare_amount_label)) errors.push(`whatsapp: option ${o.no} fare "${o.fare_amount_label}" missing or altered`);
    if (!wa.includes(o.airline)) errors.push(`whatsapp: option ${o.no} airline missing`);
  }
  for (const [name, text] of [['email', email], ['whatsapp', wa], ['subject', subject]]) {
    const unknown = numericTokens(text).filter((t) => !allowed.has(t));
    if (unknown.length) errors.push(`${name}: numbers not present in fare data: ${Array.from(new Set(unknown)).slice(0, 5).join(', ')}`);
    if (FORBIDDEN.test(text)) errors.push(`${name}: contains a forbidden commitment phrase`);
    if (containsSecret(text)) errors.push(`${name}: contains a secret-like pattern`);
  }
  if (!/subject to (?:re)?confirmation|subject to availability/i.test(email)) errors.push('email: availability disclaimer missing');
  if (!/subject to (?:re)?confirmation|subject to availability/i.test(wa)) errors.push('whatsapp: availability disclaimer missing');
  if (!subject.includes(model.rfq_number)) errors.push('subject: RFQ reference missing');
  return { ok: errors.length === 0, errors };
}

/** Validation of a human-edited quote: same checks, reported as warnings. */
function reviewEditedQuote(edited, model) {
  const result = validateFormattedQuote(edited, model);
  return { warnings: result.errors, clean: result.ok };
}

function optionsSummary(model) {
  return listJoin(model.options.map((o) => `Option ${o.no} ${o.airline} ${o.fare_amount_label}`));
}

module.exports = {
  QUOTE_SCHEMA,
  DISCLAIMER,
  buildQuoteModel,
  renderEmail,
  renderWhatsApp,
  buildFormatterUserContent,
  validateFormattedQuote,
  reviewEditedQuote,
  numericTokens,
  optionsSummary,
  formatInZone,
};
