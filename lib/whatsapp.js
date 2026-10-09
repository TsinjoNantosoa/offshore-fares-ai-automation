'use strict';
/**
 * WhatsApp Business Cloud API (official Meta Graph API) helpers.
 * No WhatsApp Web automation is used anywhere in this project.
 */
const { normalizePhone } = require('./text');

/** GET verification handshake: hub.mode=subscribe & hub.verify_token must match. */
function verifySubscription(query, verifyToken) {
  const q = query || {};
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];
  if (mode === 'subscribe' && verifyToken && token === verifyToken && challenge) return { ok: true, challenge: String(challenge) };
  return { ok: false, challenge: null };
}

/**
 * X-Hub-Signature-256 check. `hmacHex(secret, body)` is injected so this module
 * stays free of Node built-ins (n8n Code nodes receive crypto explicitly).
 */
function verifySignature(rawBody, header, appSecret, hmacHex) {
  if (!appSecret) return { ok: false, reason: 'NO_APP_SECRET' };
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return { ok: false, reason: 'MISSING_SIGNATURE' };
  const expected = `sha256=${hmacHex(appSecret, rawBody)}`;
  if (expected.length !== header.length) return { ok: false, reason: 'BAD_SIGNATURE' };
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ header.toLowerCase().charCodeAt(i);
  return diff === 0 ? { ok: true, reason: 'VALID' } : { ok: false, reason: 'BAD_SIGNATURE' };
}

function textOf(msg) {
  switch (msg.type) {
    case 'text': return msg.text && msg.text.body;
    case 'button': return msg.button && msg.button.text;
    case 'interactive': {
      const i = msg.interactive || {};
      return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || null;
    }
    default: return null;
  }
}

/**
 * Parse a Cloud API webhook payload.
 * @returns {{ valid, messages: [], statuses: [], unsupported: [] }}
 */
function parseWebhook(body) {
  const out = { valid: false, messages: [], statuses: [], unsupported: [] };
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  out.valid = true;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      const phoneNumberId = value.metadata && value.metadata.phone_number_id;
      for (const msg of value.messages || []) {
        const contact = contacts.find((c) => c.wa_id === msg.from) || contacts[0] || {};
        const text = textOf(msg);
        const item = {
          external_message_id: msg.id,
          from: normalizePhone(msg.from),
          profile_name: contact.profile ? contact.profile.name : null,
          received_at: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString(),
          type: msg.type,
          text: text || null,
          context_message_id: msg.context ? msg.context.id : null,
          phone_number_id: phoneNumberId || null,
        };
        if (text) out.messages.push(item);
        else out.unsupported.push(item);
      }
      for (const st of value.statuses || []) {
        out.statuses.push({
          external_message_id: st.id,
          status: String(st.status || '').toUpperCase(),
          timestamp: st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : null,
          recipient: normalizePhone(st.recipient_id),
          errors: st.errors || null,
        });
      }
    }
  }
  return out;
}

function sessionOpen(lastInboundAt, now) {
  if (!lastInboundAt) return false;
  const nowMs = now ? new Date(now).getTime() : Date.now();
  return nowMs - new Date(lastInboundAt).getTime() < 24 * 3600 * 1000;
}

function buildTextMessage(to, body, replyToMessageId) {
  const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: String(body).slice(0, 4096) } };
  if (replyToMessageId) payload.context = { message_id: replyToMessageId };
  return payload;
}

/** Template message (required outside the 24h customer-service window). Template must be approved in Meta Business Manager. */
function buildTemplateMessage(to, name, language, bodyParams) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: language || 'en' },
      components: bodyParams && bodyParams.length ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t).slice(0, 1000) })) }] : [],
    },
  };
}

module.exports = { verifySubscription, verifySignature, parseWebhook, sessionOpen, buildTextMessage, buildTemplateMessage };
