'use strict';
/** Text helpers: email clean-up, reference detection, small formatting utilities. */

const RFQ_RE = /\bOFF-RFQ-(\d{4})-(\d{6})\b/gi;

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Very small HTML -> text conversion for emails that only have an HTML part. */
function htmlToText(html) {
  return normalizeWhitespace(String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'"));
}

const REPLY_MARKERS = [
  /^On .{3,200}wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^From:\s.+\n(?:Sent|Date):\s/m,
  /^_{10,}\s*$/m,
];
const SIGNATURE_MARKERS = [/^--\s*$/m, /^Sent from my (?:iPhone|iPad|Android|mobile|Galaxy).*$/im, /^Get Outlook for .*$/im];
const DISCLAIMER = /^(?:DISCLAIMER|CONFIDENTIALITY NOTICE|This (?:e-?mail|message) and any attachments? (?:is|are) confidential).*$/im;
const SIGN_OFF = /^(?:best regards|kind regards|warm regards|regards|best|thanks(?: (?:&|and) regards)?|thank you|cheers|sincerely|rgds|br)[,.!]?\s*$/im;

/**
 * Remove quoted replies, signatures and legal footers so only the new content is analysed.
 * Conservative: a sign-off is only cut when it sits in the last part of the message.
 */
function stripEmailNoise(body) {
  let text = normalizeWhitespace(body);
  const cut = (re) => {
    const m = re.exec(text);
    if (m && m.index > 0) text = text.slice(0, m.index);
  };
  REPLY_MARKERS.forEach(cut);
  text = text.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
  SIGNATURE_MARKERS.forEach(cut);
  cut(DISCLAIMER);
  // Sign-off ("Best regards,") followed only by a few short lines (name, agency, phone) = signature block.
  const signOff = SIGN_OFF.exec(text);
  if (signOff && signOff.index > 0) {
    const tail = text.slice(signOff.index).split('\n');
    if (tail.length <= 8 && tail.every((line) => line.length <= 80)) text = text.slice(0, signOff.index);
  }
  return normalizeWhitespace(text);
}

function findRfqNumbers(text) {
  const out = new Set();
  let m;
  const re = new RegExp(RFQ_RE.source, 'gi');
  while ((m = re.exec(String(text || ''))) !== null) out.add(`OFF-RFQ-${m[1]}-${m[2]}`);
  return Array.from(out);
}

/** Booking reference / PNR (6 alphanumerics with at least one letter) introduced by a keyword. */
function findBookingReference(text) {
  const src = String(text || '');
  const keyword = /\b(?:PNR|booking(?:\s+(?:ref(?:erence)?|no\.?|number|code))?|ref(?:erence)?|record locator|locator)\s*[:#-]?\s*([A-Z0-9]{6})\b/i.exec(src);
  if (keyword && /[A-Z]/i.test(keyword[1]) && /^[A-Z0-9]+$/.test(keyword[1])) return keyword[1].toUpperCase();
  return null;
}

/** "John Carter <john@apextravel.example>" -> { name, email } */
function parseAddress(value) {
  const src = String(value || '').trim();
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(src);
  if (angle) return { name: angle[1].trim() || null, email: angle[2].trim().toLowerCase() };
  const email = /[^\s<>"]+@[^\s<>"]+/.exec(src);
  return { name: null, email: email ? email[0].toLowerCase() : null };
}

function emailDomain(email) {
  const m = /@([^@\s>]+)$/.exec(String(email || '').toLowerCase());
  return m ? m[1] : null;
}

/** Digits-only E.164 representation ("+44 7700-900123" -> "447700900123"). */
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function formatMoney(amount, currency) {
  const n = Number(amount);
  const hasCents = Math.round(n * 100) % 100 !== 0;
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2 });
  return `${String(currency || '').toUpperCase()} ${formatted}`.trim();
}

function listJoin(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

module.exports = {
  normalizeWhitespace,
  htmlToText,
  stripEmailNoise,
  findRfqNumbers,
  findBookingReference,
  parseAddress,
  emailDomain,
  normalizePhone,
  truncate,
  formatMoney,
  listJoin,
};
