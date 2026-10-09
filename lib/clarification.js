'use strict';
/**
 * WF05 – Clarification questions. Deterministic templates (no AI needed):
 * only the genuinely missing fields are asked, in one short message.
 */
const { listJoin } = require('./text');
const { formatShort } = require('./dates');

function questionParts(missing, req) {
  const set = new Set(missing || []);
  const parts = [];
  if (set.has('origin') && set.has('destination')) parts.push('the departure and destination cities');
  else if (set.has('origin')) parts.push('the departure city');
  else if (set.has('destination')) parts.push('the destination city');
  if (set.has('segments')) parts.push('each flight segment (from, to and date)');
  if (set.has('departure_date')) {
    const amb = (req && req.ambiguities ? req.ambiguities : []).find((a) => /^"/.test(a));
    parts.push(amb ? `the exact departure date (${amb.replace(/^"([^"]+)".*$/, 'you mentioned "$1"')})` : 'the exact departure date');
  }
  if (set.has('trip_type')) parts.push('whether this is one-way or return travel');
  if (set.has('return_date')) parts.push('the preferred return date');
  if (set.has('passengers.adults')) parts.push('the number of passengers');
  if (set.has('cabin')) parts.push('the preferred cabin (Economy, Premium Economy, Business or First)');
  return parts;
}

/**
 * Build a clarification for the given channel.
 * Returns { subject, email_body, whatsapp_body, question }.
 */
function buildClarification({ missing, requirements, contactName, rfqNumber, companySignature, originalSubject }) {
  const parts = questionParts(missing, requirements);
  const set = new Set(missing || []);
  let question = parts.length ? `Could you please confirm ${listJoin(parts)}?` : 'Could you please confirm the travel details?';
  if (set.has('trip_type') && !set.has('return_date')) question += ' If return, please also share the preferred return date.';
  const name = contactName ? ` ${contactName}` : '';
  const known = [];
  const r = requirements || {};
  if (r.origin && r.origin.iata && r.destination && r.destination.iata) known.push(`${r.origin.iata} → ${r.destination.iata}`);
  if (r.departure_date) known.push(formatShort(r.departure_date));
  if (r.passengers && r.passengers.adults) known.push(`${r.passengers.adults} pax`);
  if (r.cabin && r.cabin !== 'UNKNOWN') known.push(r.cabin.replace('_', ' ').toLowerCase());
  const noted = known.length ? ` We have noted: ${known.join(', ')}.` : '';
  const whatsapp = `Thanks${name}.${noted} ${question}`.replace(/\s+/g, ' ').trim();
  const email = [
    `Hello${name},`,
    '',
    `Thank you for your request (ref. ${rfqNumber}).${noted}`,
    '',
    `To search the best available fares, ${question.charAt(0).toLowerCase()}${question.slice(1)}`,
    '',
    'Kind regards,',
    companySignature || 'Offshore Fares',
  ].join('\n');
  const subject = originalSubject ? (/^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`) : `${rfqNumber} – a few details needed`;
  return { subject, email_body: email, whatsapp_body: whatsapp, question };
}

/** Stable fingerprint of what was asked, so the same question is not sent twice. */
function clarificationKey(missing) {
  return (missing || []).slice().sort().join('|');
}

module.exports = { buildClarification, clarificationKey, questionParts };
