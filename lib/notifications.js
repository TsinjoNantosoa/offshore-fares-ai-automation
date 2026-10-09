'use strict';
/**
 * Non-commercial outbound texts (no fares, no rules, no commitments).
 * Each builder returns { subject, email_body, whatsapp_body }.
 */
const { recapLines } = require('./requirements');
const { formatShort } = require('./dates');

function reSubject(original, fallback) {
  if (!original) return fallback;
  return /^re:/i.test(original) ? original : `Re: ${original}`;
}

function wrapEmail(name, paragraphs, signature) {
  return [`Hello${name ? ` ${name}` : ''},`, '', ...paragraphs.flatMap((p) => [p, '']), 'Kind regards,', signature || 'Offshore Fares'].join('\n');
}

/** Acknowledgement with a recap of what was understood – lets the agent catch extraction errors early. */
function acknowledgement({ rfqNumber, requirements, contactName, deskName, originalSubject, signature }) {
  const recap = recapLines(requirements);
  const email = wrapEmail(contactName, [
    `Thank you – we have registered your request under reference ${rfqNumber}:`,
    recap.map((l) => `• ${l}`).join('\n'),
    `Our ${deskName || 'fares desk'} is now searching the best available options and will revert shortly. If any detail above is incorrect, simply reply to this message.`,
  ], signature);
  const wa = `Thanks${contactName ? ` ${contactName}` : ''}! Request ${rfqNumber} registered: ${recap.slice(0, 4).map((l) => l.replace(/^[^:]+: /, '')).join(' · ')}. Our ${deskName || 'fares desk'} is on it – we'll revert shortly. Reply if anything needs correcting.`;
  return { subject: reSubject(originalSubject, `${rfqNumber} | Request received`), email_body: email, whatsapp_body: wa };
}

function bookingAcknowledgement({ rfqNumber, optionNo, airline, contactName, requiresRecheck, originalSubject, signature }) {
  const recheck = requiresRecheck
    ? 'Please note the quoted fare has passed its validity time, so our ticketing desk will first recheck availability and price with you.'
    : 'Our ticketing desk will revalidate the fare and availability and contact you for the passenger details needed to complete the booking.';
  const email = wrapEmail(contactName, [
    `Thank you – we have received your confirmation for Option ${optionNo} (${airline}) on ${rfqNumber}.`,
    recheck,
    'The booking is not confirmed until ticketed. Please do not send card details by email or WhatsApp.',
  ], signature);
  const wa = `Thanks${contactName ? ` ${contactName}` : ''}! Option ${optionNo} (${airline}) noted for ${rfqNumber}. ${requiresRecheck ? 'The fare validity has passed – our ticketing desk will recheck price and availability with you first.' : 'Our ticketing desk will revalidate and contact you for passenger details.'} Not confirmed until ticketed.`;
  return { subject: reSubject(originalSubject, `${rfqNumber} | Booking request received`), email_body: email, whatsapp_body: wa };
}

function researchAcknowledgement({ rfqNumber, contactName, kind, airlines, originalSubject, signature }) {
  const what = kind === 'PRICE_OBJECTION'
    ? 'our fares desk is rechecking for lower fares and alternative options'
    : `our fares desk is checking alternative options${airlines && airlines.length ? ` (${airlines.join(', ')})` : ''}`;
  const email = wrapEmail(contactName, [`Thank you for your feedback on ${rfqNumber} – ${what} and will revert shortly.`], signature);
  const wa = `Noted${contactName ? ` ${contactName}` : ''} – ${what} for ${rfqNumber}. We'll revert shortly.`;
  return { subject: reSubject(originalSubject, `${rfqNumber} | Rechecking options`), email_body: email, whatsapp_body: wa };
}

function afterSalesAcknowledgement({ rfqNumber, contactName, type, bookingReference, travelDate, deskName, originalSubject, signature }) {
  const label = type === 'CHANGE' ? 'change request' : type === 'CANCELLATION' ? 'cancellation request' : 'refund request';
  const ref = bookingReference ? ` for booking ${bookingReference}` : '';
  const when = travelDate ? ` (travel ${formatShort(String(travelDate).slice(0, 10))})` : '';
  const email = wrapEmail(contactName, [
    `We have received your ${label}${ref}${when} – reference ${rfqNumber}.`,
    `Our ${deskName || 'ticketing desk'} is reviewing it now and will confirm the applicable conditions and any charges before anything is changed.`,
  ], signature);
  const wa = `Received your ${label}${ref}${when} – ref ${rfqNumber}. Our ${deskName || 'ticketing desk'} is reviewing it and will confirm conditions and any charges before making changes.`;
  return { subject: reSubject(originalSubject, `${rfqNumber} | ${label.charAt(0).toUpperCase()}${label.slice(1)} received`), email_body: email, whatsapp_body: wa };
}

function confirmationRequest({ question, rfqNumber, originalSubject, contactName, signature }) {
  return { subject: reSubject(originalSubject, `${rfqNumber} | Please confirm your option`), email_body: wrapEmail(contactName, [question.replace(/^Thanks[^.]*\.\s*/, '')], signature), whatsapp_body: question };
}

module.exports = { acknowledgement, bookingAcknowledgement, researchAcknowledgement, afterSalesAcknowledgement, confirmationRequest, reSubject };
