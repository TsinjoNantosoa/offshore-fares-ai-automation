'use strict';
/**
 * Channel adapters -> common normalized message format (section 9).
 * Everything downstream of intake is channel-independent.
 */
const { stripEmailNoise, htmlToText, parseAddress, normalizePhone, findRfqNumbers, normalizeWhitespace } = require('./text');
const { screenInjection } = require('./security');

function baseMessage(channel) {
  return {
    channel,
    external_message_id: null,
    conversation_key: null,
    contact_id: '',
    agency_id: '',
    sender: { name: null, email: null, phone: null },
    message: { subject: null, text: '', text_raw: '', received_at: null },
    attachments: [],
    in_reply_to: null,
    referenced_rfq_numbers: [],
    security: { injection_suspected: false, signals: [] },
  };
}

function finalize(msg) {
  const all = `${msg.message.subject || ''}\n${msg.message.text}`;
  msg.referenced_rfq_numbers = findRfqNumbers(all);
  const screen = screenInjection(all);
  msg.security = { injection_suspected: screen.suspected, signals: screen.signals };
  return msg;
}

function firstAddress(field) {
  if (!field) return { name: null, email: null };
  if (typeof field === 'string') return parseAddress(field);
  if (Array.isArray(field.value) && field.value[0]) {
    return { name: field.value[0].name || null, email: String(field.value[0].address || '').toLowerCase() || null };
  }
  if (field.text) return parseAddress(field.text);
  return { name: null, email: null };
}

/**
 * Gmail Trigger output (simplify = false, mailparser format) or the demo
 * webhook payload { message_id, thread_id, from, subject, body, received_at }.
 */
function normalizeEmail(item) {
  const src = item || {};
  const msg = baseMessage('email');
  const isDemo = src.body !== undefined && src.from !== undefined && !src.headers;
  const from = firstAddress(src.from);
  msg.sender = { name: from.name, email: from.email, phone: null };
  msg.external_message_id = isDemo ? src.message_id : src.id || src.messageId;
  msg.conversation_key = isDemo ? src.thread_id || src.message_id : src.threadId || src.id;
  const rawText = isDemo ? src.body : src.text || (src.html ? htmlToText(src.html) : src.snippet || '');
  msg.message.subject = src.subject ? String(src.subject).slice(0, 500) : null;
  msg.message.text_raw = normalizeWhitespace(rawText).slice(0, 20000);
  msg.message.text = stripEmailNoise(rawText).slice(0, 8000) || msg.message.text_raw.slice(0, 8000);
  msg.message.received_at = new Date(src.received_at || src.date || Date.now()).toISOString();
  msg.in_reply_to = src.in_reply_to || (src.headers && (src.headers['in-reply-to'] || src.headers['In-Reply-To'])) || null;
  const atts = Array.isArray(src.attachments) ? src.attachments : [];
  msg.attachments = atts.slice(0, 20).map((a) => ({ filename: a.filename || a.name || null, content_type: a.contentType || a.mimeType || a.content_type || null, size: a.size || null }));
  return finalize(msg);
}

/** One parsed WhatsApp message (from whatsapp.parseWebhook). */
function normalizeWhatsApp(parsed) {
  const msg = baseMessage('whatsapp');
  msg.external_message_id = parsed.external_message_id;
  msg.conversation_key = normalizePhone(parsed.from);
  msg.sender = { name: parsed.profile_name || null, email: null, phone: normalizePhone(parsed.from) };
  msg.message.text_raw = String(parsed.text || '').slice(0, 4096);
  msg.message.text = normalizeWhitespace(parsed.text).slice(0, 4096);
  msg.message.received_at = parsed.received_at;
  msg.in_reply_to = parsed.context_message_id || null;
  return finalize(msg);
}

function validateNormalized(msg) {
  const errors = [];
  if (!['email', 'whatsapp'].includes(msg.channel)) errors.push('channel');
  if (!msg.external_message_id) errors.push('external_message_id');
  if (!msg.conversation_key) errors.push('conversation_key');
  if (!msg.sender.email && !msg.sender.phone) errors.push('sender');
  if (!msg.message.text && !msg.message.subject) errors.push('message.text');
  return { ok: errors.length === 0, errors };
}

module.exports = { normalizeEmail, normalizeWhatsApp, validateNormalized };
