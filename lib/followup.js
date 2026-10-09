'use strict';
/**
 * WF13 – Follow-up eligibility and wording. Polite, non-pushy, never presents
 * an expired fare as valid, and respects the WhatsApp 24-hour session rule.
 */
const { NO_FOLLOWUP } = require('./stateMachine');
const { CABIN_LABEL } = require('./requirements');

const ELIGIBLE = ['QUOTED', 'AWAITING_CLIENT'];
const HOUR = 3600 * 1000;

/**
 * @param {object} c candidate row from of_followup_candidates()
 * @returns {{ action: 'SEND'|'SKIP', reason, sequence?, channel?, use_template?, quote_expired?, text? }}
 */
function evaluateFollowup(c, now, cfg) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const max = cfg.MAX_FOLLOWUPS;
  const sent = Number(c.followups_sent || 0);
  const skip = (reason) => ({ action: 'SKIP', reason });

  if (NO_FOLLOWUP.includes(c.status)) return skip(`STATUS_${c.status}`);
  if (!ELIGIBLE.includes(c.status)) return skip('STATUS_NOT_ELIGIBLE');
  if (c.opted_out) return skip('CONTACT_OPTED_OUT');
  if (!c.quote_sent_at) return skip('QUOTE_NOT_SENT');
  const sentAt = new Date(c.quote_sent_at).getTime();
  if (c.last_client_message_at && new Date(c.last_client_message_at).getTime() > sentAt) return skip('CLIENT_REPLIED');
  if (sent >= max) return skip('MAX_FOLLOWUPS_REACHED');

  const sequence = sent + 1;
  const dueHours = sequence === 1 ? cfg.FOLLOWUP_1_HOURS : cfg.FOLLOWUP_2_HOURS;
  if (nowMs < sentAt + dueHours * HOUR) return skip('NOT_DUE');

  const quoteExpired = c.quote_valid_until ? new Date(c.quote_valid_until).getTime() <= nowMs : false;
  let channel = c.delivery_channel || 'email';
  let useTemplate = false;
  if (channel === 'whatsapp') {
    const lastInbound = c.whatsapp_last_inbound_at ? new Date(c.whatsapp_last_inbound_at).getTime() : 0;
    const sessionOpen = nowMs - lastInbound < 24 * HOUR;
    if (!sessionOpen) {
      if (cfg.WHATSAPP_FOLLOWUP_TEMPLATE) useTemplate = true;
      else if (c.contact_email) channel = 'email';
      else return skip('WHATSAPP_SESSION_CLOSED_NO_TEMPLATE');
    }
  }
  const name = c.contact_first_name || '';
  const cabin = CABIN_LABEL[c.cabin] ? `${CABIN_LABEL[c.cabin]} Class ` : '';
  let text;
  if (quoteExpired) {
    text = `Hi ${name}, following up on the ${cabin}options we sent for ${c.route || 'your request'} (ref ${c.rfq_number}). The quoted fares have now expired, so they are no longer guaranteed. If your client is still interested, just reply and we will recheck availability and current fares.`;
  } else if (sequence === 1) {
    text = `Hi ${name}, just following up on the ${cabin}options sent earlier for ${c.route || 'your request'} (ref ${c.rfq_number}). Please let us know if you would like us to proceed with any of them.`;
  } else {
    text = `Hi ${name}, a gentle reminder about the ${cabin}options for ${c.route || 'your request'} (ref ${c.rfq_number}). Fares remain subject to availability – happy to look at alternatives if needed.`;
  }
  return {
    action: 'SEND',
    reason: quoteExpired ? 'DUE_QUOTE_EXPIRED' : 'DUE',
    sequence,
    channel,
    use_template: useTemplate,
    quote_expired: quoteExpired,
    text: text.replace(/\s+/g, ' ').replace('Hi ,', 'Hi,').trim(),
    subject: `Re: ${c.rfq_number} | ${cabin}options ${c.route || ''}`.trim(),
  };
}

module.exports = { evaluateFollowup };
