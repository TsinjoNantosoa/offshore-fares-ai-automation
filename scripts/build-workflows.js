#!/usr/bin/env node
'use strict';
/* eslint-disable no-undef */
/**
 * Generates n8n/*.json from the definitions below.
 *   npm run build:workflows
 *
 * Code-node logic is written as real JS functions (so this file is syntax
 * checked by Node) and their bodies are copied into the nodes together with the
 * bundled lib/ modules they use ($input, $env, $execution... are n8n globals).
 */
const fs = require('fs');
const path = require('path');
const { WF, CRED, Workflow, N, readPrompt, ROOT } = require('./lib/n8n-builder');

const body = (fn) => {
  const s = fn.toString();
  const arrow = /^\s*(?:async\s*)?\([^)]*\)\s*=>\s*/.exec(s);
  if (arrow && s[arrow[0].length] !== '{') return `return ${s.slice(arrow[0].length).trim()};\n`; // concise arrow body
  return s.slice(s.indexOf('{') + 1, s.lastIndexOf('}')).replace(/^\n/, '').replace(/^ {4}/gm, '');
};
const P = {
  classifier: readPrompt('intent-classifier.md'),
  extractor: readPrompt('travel-extractor.md'),
  formatter: readPrompt('quote-formatter.md'),
  response: readPrompt('response-classifier.md'),
};
/** Inject a constant (e.g. a system prompt) at the top of a Code node. */
const withConst = (name, value, fn) => `const ${name} = ${JSON.stringify(value)};\n${body(fn)}`;
const L = (...libs) => libs; // readability helper
const workflows = [];
const row = (y) => (x) => [x * 260, y * 200];

// ============================================================================
// WF01 — EMAIL INTAKE
// ============================================================================
{
  const w = new Workflow('WF01');
  const r0 = row(0);
  const r1 = row(1);
  w.add(N.sticky('About WF01', '## WF01 – Email intake\nGmail Trigger (enable once the Gmail credential is connected) **or** the DEMO webhook `POST /webhook/demo/email`.\n\n1. Normalise to the common message format (signatures / quoted replies removed)\n2. `of_register_inbound_message` – idempotent (unique message id), identifies contact & agency, correlates the thread\n3. Hands the conversation to **WF06_RFQ_MANAGER** (async)', { width: 520, height: 220 }), [0, -320]);
  w.add(Object.assign({
    name: 'Gmail Trigger',
    type: 'n8n-nodes-base.gmailTrigger',
    typeVersion: 1.2,
    disabled: true,
    notes: 'Enable after connecting the "Gmail (Offshore Fares)" credential (OAuth). Polls the shared inbox every minute.',
    parameters: { pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: false, filters: { q: 'in:inbox -from:me -label:sent' }, options: {} },
    credentials: CRED.gmail,
  }), r0(0));
  w.add(N.webhook('Demo Email Webhook', 'POST', 'demo/email', { responseMode: 'lastNode' }), r1(0));
  w.add(N.code('Normalize Email', body(() => {
    const cfg = OF.config.getConfig($env);
    const out = [];
    for (const item of $input.all()) {
      const isDemo = Boolean(item.json.headers && item.json.body);
      if (isDemo && !cfg.DEMO_MODE) {
        out.push({ json: { db: { channel: 'email' }, source: 'demo', rejected: 'DEMO_MODE_DISABLED' } });
        continue;
      }
      const normalized = OF.channels.normalizeEmail(isDemo ? item.json.body : item.json);
      const check = OF.channels.validateNormalized(normalized);
      out.push({ json: {
        source: isDemo ? 'demo_webhook' : 'gmail',
        validation: check,
        db: Object.assign({}, normalized, { workflow: $workflow.name, execution_id: $execution.id, started_at: new Date().toISOString() }),
      } });
    }
    return out;
  }), L('channels', 'config')), [520, 100]);
  w.add(N.pg('Register Message (idempotent)', 'of_register_inbound_message'), [780, 100]);
  w.add(N.code('Dispatch', body(() => {
    const src = $('Normalize Email').all();
    return $input.all().map((item, i) => {
      const rejected = src[i] && src[i].json.rejected;
      const registration = rejected ? { ok: false, status: 'REJECTED', error: rejected } : item.json.r;
      return { json: { conversation_id: registration.status === 'REGISTERED' ? registration.conversation_id : null, registration } };
    });
  })), [1040, 100]);
  w.add(N.exec('Process Conversation (WF06)', 'WF06', { wait: false, each: true }), [1300, 100]);
  w.add(N.code('Intake Result', body(() => {
    const regs = $('Dispatch').all().map((i) => i.json.registration);
    return [{ json: { received: regs.length, results: regs.map((r) => ({ status: r.status, message_id: r.message_id || null, error: r.error || null })) } }];
  })), [1560, 100]);
  w.chain('Gmail Trigger', 'Normalize Email');
  w.chain('Demo Email Webhook', 'Normalize Email', 'Register Message (idempotent)', 'Dispatch', 'Process Conversation (WF06)', 'Intake Result');
  workflows.push(w);
}

// ============================================================================
// WF02 — WHATSAPP INTAKE (WhatsApp Business Cloud API webhook)
// ============================================================================
{
  const w = new Workflow('WF02');
  w.add(N.sticky('About WF02', '## WF02 – WhatsApp Business Cloud API\n`GET /webhook/whatsapp` – Meta verification handshake (hub.verify_token)\n`POST /webhook/whatsapp` – messages + delivery statuses. `X-Hub-Signature-256` is verified when `WHATSAPP_APP_SECRET` is set (mandatory when DEMO_MODE=false).\n\nOfficial Cloud API only – no WhatsApp Web automation.', { width: 560, height: 220 }), [0, -340]);
  w.add(N.webhook('WhatsApp Verify (GET)', 'GET', 'whatsapp', { auth: false }), [0, -80]);
  w.add(N.code('Check Verify Token', body(() => {
    const res = OF.whatsapp.verifySubscription($input.first().json.query || {}, $env.WHATSAPP_VERIFY_TOKEN || '');
    return [{ json: { http_status: res.ok ? 200 : 403, challenge: res.ok ? res.challenge : 'Forbidden' } }];
  }), L('whatsapp')), [260, -80]);
  w.add(N.respond('Return Challenge', { text: true, body: '={{ $json.challenge }}' }), [520, -80]);
  w.chain('WhatsApp Verify (GET)', 'Check Verify Token', 'Return Challenge');

  w.add(N.webhook('WhatsApp Events (POST)', 'POST', 'whatsapp', { auth: false, rawBody: true }), [0, 160]);
  w.add(N.code('Verify Signature & Parse', body(() => {
    const item = $input.first();
    const cfg = OF.config.getConfig($env);
    const headers = item.json.headers || {};
    const secret = $env.WHATSAPP_APP_SECRET || '';
    let signature = 'NOT_CONFIGURED_DEMO';
    if (secret) {
      const crypto = require('crypto');
      const raw = item.binary && item.binary.data ? Buffer.from(item.binary.data.data, 'base64').toString('utf8') : JSON.stringify(item.json.body);
      const check = OF.whatsapp.verifySignature(raw, headers['x-hub-signature-256'], secret, (s, b) => crypto.createHmac('sha256', s).update(b, 'utf8').digest('hex'));
      if (!check.ok) return [{ json: { accepted: false, http_status: 401, response: { error: check.reason } } }];
      signature = 'VALID';
    } else if (!cfg.DEMO_MODE || cfg.WHATSAPP_SIGNATURE_REQUIRED) {
      return [{ json: { accepted: false, http_status: 401, response: { error: 'WHATSAPP_APP_SECRET_NOT_CONFIGURED' } } }];
    }
    const parsed = OF.whatsapp.parseWebhook(item.json.body);
    if (!parsed.valid) return [{ json: { accepted: false, http_status: 400, response: { error: 'MALFORMED_WEBHOOK' } } }];
    return [{ json: { accepted: true, http_status: 200, signature, parsed, response: { received: true, messages: parsed.messages.length, statuses: parsed.statuses.length } } }];
  }), L('whatsapp', 'config')), [260, 160]);
  w.add(N.respond('Acknowledge (200 fast)'), [520, 160]);
  w.add(N.code('Split Events', body(() => {
    const j = $input.first().json;
    if (!j.accepted) return [];
    const meta = { workflow: $workflow.name, execution_id: $execution.id, started_at: new Date().toISOString() };
    const out = j.parsed.messages.map((m) => ({ json: { kind: 'message', db: Object.assign(OF.channels.normalizeWhatsApp(m), meta, { recipient: m.phone_number_id }) } }));
    if (j.parsed.statuses.length) out.push({ json: { kind: 'statuses', db: Object.assign({ statuses: j.parsed.statuses }, meta) } });
    return out;
  }), L('channels')), [780, 160]);
  w.add(N.switch('Event Type', '={{ $json.kind }}', ['message', 'statuses']), [1040, 160]);
  w.add(N.pg('Register Message (idempotent)', 'of_register_inbound_message'), [1300, 60]);
  w.add(N.code('Dispatch', body(() => {
    return $input.all().map((i) => ({ json: { conversation_id: i.json.r.status === 'REGISTERED' ? i.json.r.conversation_id : null, registration: i.json.r } }));
  })), [1560, 60]);
  w.add(N.exec('Process Conversation (WF06)', 'WF06', { wait: false, each: true }), [1820, 60]);
  w.add(N.pg('Update Delivery Status', 'of_update_delivery_status'), [1300, 260]);
  w.chain('WhatsApp Events (POST)', 'Verify Signature & Parse', 'Acknowledge (200 fast)', 'Split Events', 'Event Type');
  w.connect('Event Type', 'Register Message (idempotent)', 0).connect('Event Type', 'Update Delivery Status', 1);
  w.chain('Register Message (idempotent)', 'Dispatch', 'Process Conversation (WF06)');
  workflows.push(w);
}

// ============================================================================
// Shared AI sub-workflow shape: Build request -> (openai | rules) -> Validate
// ============================================================================
function aiWorkflow(key, { sticky, buildLogic, buildLibs, validateLogic, validateLibs }) {
  const w = new Workflow(key);
  w.add(N.sticky(`About ${WF[key].name}`, sticky, { width: 560, height: 240 }), [0, -320]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.code('Build OpenAI Request', buildLogic, buildLibs), [260, 0]);
  w.add(N.switch('AI Provider', '={{ $json.ai_mode }}', ['openai', 'rules']), [520, 0]);
  w.add(N.openai('OpenAI Chat Completion'), [780, -100]);
  w.add(N.code('Validate Output', validateLogic, validateLibs), [1040, 0]);
  w.chain('When Called By Another Workflow', 'Build OpenAI Request', 'AI Provider');
  w.connect('AI Provider', 'OpenAI Chat Completion', 0).connect('AI Provider', 'Validate Output', 1);
  w.connect('OpenAI Chat Completion', 'Validate Output');
  return w;
}

// ============================================================================
// WF03 — INTENT CLASSIFIER
// ============================================================================
workflows.push(aiWorkflow('WF03', {
  sticky: '## WF03 – Intent classifier\nInput: normalised message + active RFQ context.\nOpenAI Structured Output (strict JSON schema, temperature 0). The message is wrapped as **untrusted data**.\n\nValidation: enum check, confidence clamp, `requires_human` when confidence < `AI_CONFIDENCE_THRESHOLD`.\nOpenAI error / invalid JSON / `AI_PROVIDER=rules` → deterministic rules classifier (`source = rules`).',
  buildLogic: withConst('SYSTEM_PROMPT', P.classifier, () => {
    const input = $input.first().json;
    const cfg = OF.config.getConfig($env);
    const user = OF.intents.buildClassifierUserContent({ message: input.message, channel: input.channel, today: input.today, timezone: cfg.BUSINESS_TIMEZONE, context: input.context });
    const request = OF.openai.buildChatRequest({ model: cfg.OPENAI_MODEL, system: SYSTEM_PROMPT, user, schema: OF.intents.CLASSIFICATION_SCHEMA, schemaName: 'intent_classification', temperature: cfg.OPENAI_TEMPERATURE, maxTokens: 300 });
    return [{ json: Object.assign({}, input, { ai_mode: cfg.AI_PROVIDER === 'rules' ? 'rules' : 'openai', openai_request: request }) }];
  }),
  buildLibs: L('intents', 'openai', 'config'),
  validateLogic: body(() => {
    const input = $('Build OpenAI Request').first().json;
    const cfg = OF.config.getConfig($env);
    let ai = { ok: false, error: 'AI_PROVIDER_RULES' };
    if (input.ai_mode === 'openai') ai = OF.openai.parseChatResponse($input.first().json);
    const raw = ai.ok ? Object.assign({ source: 'openai' }, ai.data) : OF.intents.rulesClassify({ message: input.message, context: input.context, today: input.today });
    const classification = OF.intents.validateClassification(raw, cfg.AI_CONFIDENCE_THRESHOLD);
    if (!ai.ok) classification.ai_error = ai.error;
    if (ai.ok) classification.model = ai.model;
    return [{ json: { classification } }];
  }),
  validateLibs: L('intents', 'openai', 'config'),
}));

// ============================================================================
// WF04 — TRAVEL REQUEST EXTRACTOR
// ============================================================================
workflows.push(aiWorkflow('WF04', {
  sticky: '## WF04 – Travel request extractor\nExtracts a **delta** of what the current message states (context = active RFQ requirements).\n\nEvery AI value is re-verified: date evidence spans re-parsed deterministically, locations / airlines / cabin / pax must appear in the text. Ambiguous dates ("next week") are never converted.\nCompleteness (`missing_fields`, `ready_for_processing`) is decided by code in WF06, not by the model.',
  buildLogic: withConst('SYSTEM_PROMPT', P.extractor, () => {
    const input = $input.first().json;
    const cfg = OF.config.getConfig($env);
    const user = OF.extraction.buildExtractorUserContent({ message: input.message, channel: input.channel, today: input.today, timezone: cfg.BUSINESS_TIMEZONE, context: input.context });
    const request = OF.openai.buildChatRequest({ model: cfg.OPENAI_MODEL, system: SYSTEM_PROMPT, user, schema: OF.extraction.EXTRACTION_SCHEMA, schemaName: 'travel_request', temperature: cfg.OPENAI_TEMPERATURE, maxTokens: 900 });
    return [{ json: Object.assign({}, input, { ai_mode: cfg.AI_PROVIDER === 'rules' ? 'rules' : 'openai', openai_request: request }) }];
  }),
  buildLibs: L('extraction', 'openai', 'config'),
  validateLogic: body(() => {
    const input = $('Build OpenAI Request').first().json;
    const text = `${input.message.subject ? `${input.message.subject}\n` : ''}${input.message.text}`;
    let ai = { ok: false, error: 'AI_PROVIDER_RULES' };
    if (input.ai_mode === 'openai') ai = OF.openai.parseChatResponse($input.first().json);
    let result;
    if (ai.ok) result = Object.assign(OF.extraction.validateExtraction(ai.data, { text, today: input.today, context: input.context }), { source: 'openai', model: ai.model });
    else result = Object.assign(OF.extraction.rulesExtract({ text, today: input.today, context: input.context, intent: input.intent }), { source: 'rules', ai_error: ai.error });
    return [{ json: { extraction: result } }];
  }),
  validateLibs: L('extraction', 'openai'),
}));

// ============================================================================
// WF05 — MISSING INFORMATION HANDLER
// ============================================================================
{
  const w = new Workflow('WF05');
  w.add(N.sticky('About WF05', '## WF05 – Missing information handler\nAsks ONLY for the missing mandatory fields, in one short message (deterministic template).\n\n* Debounced: WhatsApp bursts ("3 pax", "17 Nov"...) are merged before asking (`CLARIFICATION_DEBOUNCE_SECONDS_*`).\n* Never asks the same question twice; escalates to a human after `MAX_CLARIFICATIONS`.\n* Triggered by WF06 (immediate check) and every minute.', { width: 560, height: 240 }), [0, -340]);
  w.add(N.trigger(), [0, -40]);
  w.add(N.schedule('Every Minute', 1), [0, 140]);
  w.add(N.code('Prepare', body(() => {
    const cfg = OF.config.getConfig($env);
    const first = $input.first().json || {};
    return [{ json: { db: { rfq_id: first.rfq_id || null, limit: 20, max_clarifications: cfg.MAX_CLARIFICATIONS } } }];
  }), L('config')), [260, 50]);
  w.add(N.pg('Claim Due Clarifications', 'of_due_clarifications'), [520, 50]);
  w.add(N.code('Build Clarifications', body(() => {
    const cfg = OF.config.getConfig($env);
    const items = ($input.first().json.r.items || []).filter((i) => i.action !== 'SKIP_ALREADY_ASKED');
    return items.map((i) => {
      const c = OF.clarification.buildClarification({
        missing: i.missing_fields, requirements: i.requirements, contactName: i.contact_first_name, rfqNumber: i.rfq_number,
        companySignature: cfg.COMPANY_SIGNATURE, originalSubject: i.conversation_subject,
      });
      return { json: {
        action: i.action, rfq_id: i.rfq_id, rfq_number: i.rfq_number, clarification_key: i.clarification_key, question: c.question,
        kind: 'CLARIFICATION', email: { subject: c.subject, body: c.email_body }, whatsapp: { body: c.whatsapp_body },
      } };
    });
  }), L('clarification', 'config')), [780, 50]);
  w.add(N.switch('Send or Escalate', '={{ $json.action }}', ['SEND', 'ESCALATE']), [1040, 50]);
  w.add(N.exec('Deliver Clarification (WF12)', 'WF12', { wait: true, each: true }), [1300, -40]);
  w.add(N.code('Mark Payload', body(() => {
    const sent = $('Send or Escalate').all();
    return $input.all().map((res, idx) => {
      const src = (sent[idx] || sent[0]).json;
      return { json: { delivered: Boolean(res.json.delivered), db: { rfq_id: src.rfq_id, action: res.json.delivered ? 'SENT' : 'FAILED', clarification_key: res.json.delivered ? src.clarification_key : null, question: src.question, channel: res.json.channel } } };
    }).filter((i) => i.json.delivered);
  })), [1560, -40]);
  w.add(N.code('Escalation Payload', body(() => {
    return $input.all().map((i) => ({ json: { db: { rfq_id: i.json.rfq_id, action: 'ESCALATE', clarification_key: i.json.clarification_key } } }));
  })), [1300, 160]);
  w.add(N.pg('Record Clarification', 'of_mark_clarification'), [1820, 50]);
  w.chain('When Called By Another Workflow', 'Prepare');
  w.chain('Every Minute', 'Prepare', 'Claim Due Clarifications', 'Build Clarifications', 'Send or Escalate');
  w.connect('Send or Escalate', 'Deliver Clarification (WF12)', 0).connect('Send or Escalate', 'Escalation Payload', 1);
  w.chain('Deliver Clarification (WF12)', 'Mark Payload', 'Record Clarification');
  w.chain('Escalation Payload', 'Record Clarification');
  workflows.push(w);
}

// ============================================================================
// WF06 — RFQ MANAGER (core orchestrator)
// ============================================================================
{
  const w = new Workflow('WF06');
  w.add(N.sticky('About WF06', '## WF06 – RFQ manager (core)\nProcesses one conversation at a time (DB lock → strict ordering, no duplicate RFQs when WhatsApp messages arrive in bursts).\n\n**Route**: reply to a sent quote → WF14 · otherwise classify (WF03) →\n* quote intents → extract (WF04) → deterministic merge → create/update RFQ → priority (WF07) → ready? route to desk (WF09) + acknowledgement : ask missing info (WF05)\n* change / cancel / refund → WF15\n* anything else → human review (+ KB suggestions, security flag)\n\nEvery minute a sweeper requeues failed messages (backoff) and picks up orphans.', { width: 640, height: 300 }), [0, -560]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.schedule('Sweeper (every minute)', 1), [0, -200]);
  w.add(N.code('Sweep Payload', body(() => [{ json: { db: { workflow: $workflow.name, execution_id: $execution.id } } }])), [260, -200]);
  w.add(N.pg('Sweep Queue', 'of_sweep'), [520, -200]);
  w.add(N.code('Fan Out Conversations', body(() => {
    const ids = $input.first().json.r.conversations || [];
    return ids.map((id) => ({ json: { conversation_id: id } }));
  })), [780, -200]);
  w.add(N.exec('Process Conversation (self)', 'WF06', { wait: false, each: true }), [1040, -200]);
  w.chain('Sweeper (every minute)', 'Sweep Payload', 'Sweep Queue', 'Fan Out Conversations', 'Process Conversation (self)');

  w.add(N.code('Claim Payload', body(() => {
    const cfg = OF.config.getConfig($env);
    const j = $input.first().json;
    return [{ json: { db: { conversation_id: j.conversation_id || null, execution_id: $execution.id, workflow: $workflow.name, correlation_hours: cfg.CORRELATION_WINDOW_HOURS, started_at: new Date().toISOString() } } }];
  }), L('config')), [260, 0]);
  w.add(N.pg('Claim Next Message', 'of_claim_next_message'), [520, 0]);
  w.add(N.code('Route Message', body(() => {
    const claim = $input.first().json.r;
    if (!claim || !claim.claimed) return [];
    const cfg = OF.config.getConfig($env);
    const today = OF.dates.todayIn(cfg.BUSINESS_TIMEZONE);
    const decision = OF.router.decideRoute(claim, today);
    const active = decision.active_rfq;
    return [{ json: {
      route: decision.route,
      route_reasons: decision.reasons,
      today,
      channel: claim.message.channel,
      message: { id: claim.message.id, subject: claim.message.subject, text: claim.message.text },
      security: { injection_suspected: (claim.message.security_flags || []).length > 0, signals: claim.message.security_flags || [] },
      claim,
      active_rfq: active,
      context: {
        rfq: active ? { rfq_number: active.rfq_number, status: active.status, summary: OF.requirements.summarize(active.requirements || {}), missing_fields: active.missing_fields || [] } : null,
        requirements: active && OF.stateMachine.MERGEABLE.includes(active.status) ? active.requirements : null,
        history: (claim.history || []).slice(-4),
      },
    } }];
  }), L('router', 'dates', 'requirements', 'stateMachine', 'config')), [780, 0]);
  w.add(N.switch('Route', '={{ $json.route }}', ['REPLY', 'INTAKE', 'OPT_OUT', 'IGNORE']), [1040, 0]);

  // REPLY -> WF14
  w.add(N.exec('Handle Client Reply (WF14)', 'WF14', { wait: true }), [1300, -320]);
  // INTAKE -> classify
  w.add(N.exec('Classify Intent (WF03)', 'WF03', { wait: true }), [1300, 0]);
  w.add(N.code('Decide Intake Path', body(() => {
    const ctx = $('Route Message').first().json;
    const classification = $input.first().json.classification;
    const decision = OF.router.decideIntake(classification, ctx.active_rfq, ctx.security);
    return [{ json: Object.assign({}, ctx, { classification, intake: decision, path: decision.path, intent: classification.intent }) }];
  }), L('router')), [1560, 0]);
  w.add(N.switch('Intake Path', '={{ $json.path }}', ['EXTRACT', 'AFTER_SALES', 'HUMAN']), [1820, 0]);

  // EXTRACT
  w.add(N.exec('Extract Requirements (WF04)', 'WF04', { wait: true }), [2080, -160]);
  w.add(N.code('Merge Requirements', body(() => {
    const cfg = OF.config.getConfig($env);
    const ctx = $('Decide Intake Path').first().json;
    const extraction = $input.first().json.extraction;
    const claim = ctx.claim;
    const decision = OF.router.shouldStartNewRfq(ctx.active_rfq, extraction.delta, false);
    const base = decision.new_rfq ? null : ctx.active_rfq.requirements;
    const merged = OF.requirements.mergeRequirements(base, Object.assign({}, extraction.delta, { intent: decision.new_rfq ? ctx.intent : extraction.delta.intent }));
    const reasons = [];
    if (ctx.intake.human_reason) reasons.push(ctx.intake.human_reason);
    if (claim.contact && claim.contact.verification_status !== 'VERIFIED') reasons.push('Unknown sender – verify the agency before quoting');
    return [{ json: {
      new_rfq: decision.new_rfq,
      merge_reason: decision.reason,
      requirements: merged.requirements,
      db: {
        workflow: $workflow.name, execution_id: $execution.id,
        rfq_id: decision.new_rfq ? null : ctx.active_rfq.id,
        message_id: ctx.message.id, conversation_id: claim.conversation.id,
        contact_id: claim.contact ? claim.contact.id : null, agency_id: claim.agency ? claim.agency.id : null,
        channel: ctx.channel, intent: ctx.intent,
        requirements: merged.requirements, ready: merged.requirements.ready_for_processing, changes: merged.changes,
        summary: OF.requirements.summarize(merged.requirements),
        classification: ctx.classification,
        extraction_meta: { source: extraction.source, model: extraction.model || null, ai_error: extraction.ai_error || null, report: extraction.report.slice(0, 30) },
        requires_human: reasons.length > 0, human_review_reason: reasons.join(' | ') || null,
        security_flags: ctx.security.signals,
        debounce_seconds: ctx.channel === 'whatsapp' ? cfg.CLARIFICATION_DEBOUNCE_SECONDS_WHATSAPP : cfg.CLARIFICATION_DEBOUNCE_SECONDS_EMAIL,
      },
    } }];
  }), L('router', 'requirements', 'config')), [2340, -160]);
  w.add(N.pg('Create / Update RFQ', 'of_upsert_rfq_from_message'), [2600, -160]);
  w.add(N.code('RFQ Result', body(() => {
    const r = $input.first().json.r;
    if (!r.ok) throw new Error(`RFQ upsert refused: ${r.error} (${r.status || ''})`);
    return [{ json: { rfq_id: r.rfq_id, rfq_number: r.rfq_number, status: r.status, became_ready: r.became_ready, created: r.created, intent: $('Decide Intake Path').first().json.intent } }];
  })), [2860, -160]);
  w.add(N.exec('Calculate Priority (WF07)', 'WF07', { wait: true }), [3120, -160]);
  w.add(N.code('Next Step', body(() => {
    const r = $('RFQ Result').first().json;
    const step = r.status === 'NEEDS_INFORMATION' ? 'ASK_MISSING' : r.became_ready ? 'ROUTE' : 'NONE';
    return [{ json: Object.assign({}, r, { step }) }];
  })), [3380, -160]);
  w.add(N.switch('Ready?', '={{ $json.step }}', ['ROUTE', 'ASK_MISSING']), [3640, -160]);
  w.add(N.exec('Route to Fare Desk (WF09)', 'WF09', { wait: true }), [3900, -260]);
  w.add(N.code('Acknowledgement', body(() => {
    const cfg = OF.config.getConfig($env);
    const route = $input.first().json;
    const ctx = $('Decide Intake Path').first().json;
    const rfq = $('RFQ Result').first().json;
    if (!cfg.AUTO_ACKNOWLEDGE) return [];
    const ack = OF.notifications.acknowledgement({
      rfqNumber: rfq.rfq_number, requirements: $('Merge Requirements').first().json.requirements,
      contactName: ctx.claim.contact ? ctx.claim.contact.first_name : null, deskName: route.desk_name,
      originalSubject: ctx.message.subject, signature: cfg.COMPANY_SIGNATURE,
    });
    return [{ json: { rfq_id: rfq.rfq_id, kind: 'ACK', email: { subject: ack.subject, body: ack.email_body }, whatsapp: { body: ack.whatsapp_body } } }];
  }), L('notifications', 'config')), [4160, -260]);
  w.add(N.exec('Send Acknowledgement (WF12)', 'WF12', { wait: true }), [4420, -260]);
  w.add(N.exec('Ask Missing Information (WF05)', 'WF05', { wait: false }), [3900, -60]);

  // AFTER SALES / HUMAN / OPT-OUT
  w.add(N.exec('After-Sales Router (WF15)', 'WF15', { wait: true }), [2080, 40]);
  w.add(N.code('Human Review Payload', body(() => {
    const ctx = $input.first().json;
    const security = ctx.intake.flag_security;
    return [{ json: { db: {
      workflow: $workflow.name, message_id: ctx.message.id, rfq_id: ctx.active_rfq ? ctx.active_rfq.id : null,
      kind: security ? 'SECURITY' : 'REVIEW', severity: security ? 'WARNING' : 'INFO',
      desk_code: ctx.active_rfq && ctx.active_rfq.assigned_team ? ctx.active_rfq.assigned_team : 'GENERAL_DESK',
      title: security ? 'Suspicious message (prompt-injection / secret request) – not actioned' : `${ctx.intent.replace(/_/g, ' ').toLowerCase()}: ${ctx.intake.human_reason}`,
      details: { intent: ctx.intent, confidence: ctx.classification.confidence, reason: ctx.classification.reason, signals: ctx.security.signals },
    } } }];
  })), [2080, 220]);
  w.add(N.pg('Create Human Task', 'of_flag_message'), [2340, 220]);
  w.add(N.code('Opt-out Payload', body(() => {
    const ctx = $input.first().json;
    return [{ json: { db: { message_id: ctx.message.id, kind: 'OPT_OUT', rfq_id: ctx.active_rfq ? ctx.active_rfq.id : null } } }];
  })), [1300, 360]);
  w.add(N.pg('Record Opt-out', 'of_flag_message'), [1560, 360]);

  // Finalize
  w.add(N.code('Finalize Payload', body(() => {
    const ctx = $('Route Message').first().json;
    let rfqId = ctx.active_rfq ? ctx.active_rfq.id : null;
    if ($('RFQ Result').isExecuted) rfqId = $('RFQ Result').first().json.rfq_id;
    const classification = $('Decide Intake Path').isExecuted ? $('Decide Intake Path').first().json.classification : null;
    return [{ json: { db: {
      workflow: $workflow.name, execution_id: $execution.id, message_id: ctx.message.id, rfq_id: rfqId,
      status: ctx.route === 'IGNORE' ? 'IGNORED' : 'PROCESSED', route: ctx.route, classification,
      notes: { route_reasons: ctx.route_reasons, path: $('Decide Intake Path').isExecuted ? $('Decide Intake Path').first().json.path : null },
    } } }];
  })), [4680, 0]);
  w.add(N.pg('Complete Message', 'of_complete_message'), [4940, 0]);
  w.add(N.code('More Pending?', body(() => {
    const r = $input.first().json.r;
    return r.has_more ? [{ json: { conversation_id: r.conversation_id } }] : [];
  })), [5200, 0]);
  w.add(N.exec('Process Next Message (self)', 'WF06', { wait: false }), [5460, 0]);

  w.chain('When Called By Another Workflow', 'Claim Payload', 'Claim Next Message', 'Route Message', 'Route');
  w.connect('Route', 'Handle Client Reply (WF14)', 0).connect('Route', 'Classify Intent (WF03)', 1).connect('Route', 'Opt-out Payload', 2).connect('Route', 'Finalize Payload', 3);
  w.chain('Classify Intent (WF03)', 'Decide Intake Path', 'Intake Path');
  w.connect('Intake Path', 'Extract Requirements (WF04)', 0).connect('Intake Path', 'After-Sales Router (WF15)', 1).connect('Intake Path', 'Human Review Payload', 2);
  w.chain('Extract Requirements (WF04)', 'Merge Requirements', 'Create / Update RFQ', 'RFQ Result', 'Calculate Priority (WF07)', 'Next Step', 'Ready?');
  w.connect('Ready?', 'Route to Fare Desk (WF09)', 0).connect('Ready?', 'Ask Missing Information (WF05)', 1).connect('Ready?', 'Finalize Payload', 2);
  w.chain('Route to Fare Desk (WF09)', 'Acknowledgement', 'Send Acknowledgement (WF12)', 'Finalize Payload');
  w.chain('Ask Missing Information (WF05)', 'Finalize Payload');
  w.chain('Handle Client Reply (WF14)', 'Finalize Payload');
  w.chain('After-Sales Router (WF15)', 'Finalize Payload');
  w.chain('Human Review Payload', 'Create Human Task', 'Finalize Payload');
  w.chain('Opt-out Payload', 'Record Opt-out', 'Finalize Payload');
  w.chain('Finalize Payload', 'Complete Message', 'More Pending?', 'Process Next Message (self)');
  workflows.push(w);
}

// Switch nodes need a fallback output for "Ready?" (step NONE): add it.
{
  const wf06 = workflows.find((x) => x.meta.name === 'WF06_RFQ_MANAGER');
  const ready = wf06.nodes.find((n) => n.name === 'Ready?');
  ready.parameters.options = { fallbackOutput: 'extra', renameFallbackOutput: 'NONE' };
}

// ============================================================================
// WF07 — PRIORITY ENGINE
// ============================================================================
{
  const w = new Workflow('WF07');
  w.add(N.sticky('About WF07', '## WF07 – Priority engine (deterministic)\nTravel < 24h +40 · < 72h +25 · First +25 · Business +20 · Group +20 · VIP agency +15 · explicit urgent +10 · change/cancel < 24h +30 · 3+ premium pax +10\n\n0-29 LOW · 30-49 NORMAL · 50-69 HIGH · 70-100 CRITICAL. Weights: `PRIORITY_RULES_JSON`.', { width: 560, height: 200 }), [0, -280]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.code('Load Payload', body(() => [{ json: { input: $input.first().json, db: { rfq_id: $input.first().json.rfq_id } } }])), [260, 0]);
  w.add(N.pg('Load RFQ', 'of_get_quote_context'), [520, 0]);
  w.add(N.code('Score Priority', body(() => {
    const cfg = OF.config.getConfig($env);
    const rfq = $input.first().json.r;
    const input = $('Load Payload').first().json.input;
    const result = OF.priority.scorePriority({
      intent: input.intent || rfq.intent, requirements: rfq.requirements || {}, agency: rfq.agency,
      travel_date: input.travel_date || rfq.departure_date || null, now: new Date(),
    }, cfg);
    return [{ json: Object.assign({}, result, { db: { rfq_id: rfq.id, score: result.score, level: result.level, breakdown: result.breakdown, hours_to_departure: result.hours_to_departure } }) }];
  }), L('priority', 'config')), [780, 0]);
  w.add(N.pg('Save Priority', 'of_save_priority'), [1040, 0]);
  w.add(N.code('Output', body(() => [{ json: Object.assign({ breakdown: $('Score Priority').first().json.breakdown }, $input.first().json.r) }])), [1300, 0]);
  w.chain('When Called By Another Workflow', 'Load Payload', 'Load RFQ', 'Score Priority', 'Save Priority', 'Output');
  workflows.push(w);
}

// ============================================================================
// WF08 — SLA MONITOR
// ============================================================================
{
  const w = new Workflow('WF08');
  w.add(N.sticky('About WF08', '## WF08 – SLA monitor\nEvery minute: time spent in the current status vs `SLA_*_MINUTES` (CRITICAL × `SLA_CRITICAL_FACTOR`).\nOne alert per RFQ per status episode (`alerts.dedupe_key`) – never repeated. `rfqs.sla_breached = true` is kept for reporting.\nManual run: `POST /webhook/ops/run-sla`.', { width: 560, height: 200 }), [0, -280]);
  w.add(N.schedule('Every Minute', 1), [0, -60]);
  w.add(N.webhook('Run Now (ops)', 'POST', 'ops/run-sla', { responseMode: 'lastNode' }), [0, 120]);
  w.add(N.code('Payload', body(() => [{ json: { db: {} } }])), [260, 0]);
  w.add(N.pg('Open RFQs', 'of_sla_candidates'), [520, 0]);
  w.add(N.code('Evaluate SLA', body(() => {
    const cfg = OF.config.getConfig($env);
    const now = new Date();
    const breaches = ($input.first().json.r || []).map((r) => Object.assign({ rfq_id: r.id, status: r.status }, OF.sla.evaluateSla(r, now, cfg))).filter((e) => e.breached);
    return [{ json: { evaluated: ($input.first().json.r || []).length, db: { breaches } } }];
  }), L('sla', 'config')), [780, 0]);
  w.add(N.pg('Record Breaches (dedup)', 'of_record_sla_breaches'), [1040, 0]);
  w.add(N.code('Summary', body(() => {
    const r = $input.first().json.r;
    return [{ json: { evaluated: $('Evaluate SLA').first().json.evaluated, new_alerts: r.new_alerts } }];
  })), [1300, 0]);
  w.chain('Every Minute', 'Payload');
  w.chain('Run Now (ops)', 'Payload', 'Open RFQs', 'Evaluate SLA', 'Record Breaches (dedup)', 'Summary');
  workflows.push(w);
}

// ============================================================================
// WF09 — FARE DESK ROUTER
// ============================================================================
{
  const w = new Workflow('WF09');
  w.add(N.sticky('About WF09', '## WF09 – Fare desk router\nRules (first match): booking/change/cancel → Ticketing · refund → Refund · group → Group · Business/First/PE → Premium · else General.\nOperator = least open assignments in the desk. READY_FOR_SEARCH → ASSIGNED and a desk notification is raised.', { width: 560, height: 200 }), [0, -280]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.code('Load Payload', body(() => [{ json: { input: $input.first().json, db: { rfq_id: $input.first().json.rfq_id } } }])), [260, 0]);
  w.add(N.pg('Load RFQ', 'of_get_quote_context'), [520, 0]);
  w.add(N.code('Apply Routing Rules', body(() => {
    const cfg = OF.config.getConfig($env);
    const rfq = $input.first().json.r;
    const input = $('Load Payload').first().json.input;
    const route = input.desk_override ? { desk_code: input.desk_override, rule: 'OVERRIDE' } : OF.routing.routeToDesk({ intent: rfq.intent, status: rfq.status, requirements: rfq.requirements, priority_level: rfq.priority_level }, cfg);
    return [{ json: { db: { rfq_id: rfq.id, desk_code: route.desk_code, rule: route.rule, title: input.title || null, note: input.note || null, handoff: input.handoff || null, reason_key: input.reason_key || null } } }];
  }), L('routing', 'config')), [780, 0]);
  w.add(N.pg('Assign', 'of_assign_rfq'), [1040, 0]);
  w.add(N.code('Output', body(() => [{ json: $input.first().json.r }])), [1300, 0]);
  w.chain('When Called By Another Workflow', 'Load Payload', 'Load RFQ', 'Apply Routing Rules', 'Assign', 'Output');
  workflows.push(w);
}

// ============================================================================
// WF10 — QUOTE FORMATTER
// ============================================================================
{
  const w = new Workflow('WF10');
  w.add(N.sticky('About WF10', '## WF10 – AI quote formatter\nInput = **validated** fare options only. All commercial strings are formatted by code.\nThe model writes email + compact WhatsApp texts; `validateFormattedQuote` rejects any altered / invented number, missing disclaimer or commitment wording → deterministic template used instead (reason stored in `quotes.validation`).\nThen: REQUIRE_HUMAN_APPROVAL=true → PENDING_APPROVAL (WF11) · false → auto-approved and delivered (WF12).', { width: 620, height: 240 }), [0, -320]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.code('Load Payload', body(() => [{ json: { db: { rfq_id: $input.first().json.rfq_id } } }])), [260, 0]);
  w.add(N.pg('Load Quote Context', 'of_get_quote_context'), [520, 0]);
  w.add(N.code('Build Quote + OpenAI Request', withConst('SYSTEM_PROMPT', P.formatter, () => {
    const cfg = OF.config.getConfig($env);
    const ctx = $input.first().json.r;
    const now = new Date();
    const check = OF.fares.validateFareOptions(ctx.options, { rfq: { trip_type: ctx.trip_type, cabin: ctx.cabin }, now });
    if (!check.ok) throw new Error(`Fare options are not quotable: ${check.errors.join('; ')}`);
    const options = check.options.map((o, i) => Object.assign(o, { option_code: ctx.options[i].option_code }));
    const model = OF.quote.buildQuoteModel({ rfq: ctx, requirements: ctx.requirements, contact: ctx.contact, options, timeZone: cfg.BUSINESS_TIMEZONE, now });
    const email = OF.quote.renderEmail(model, cfg.COMPANY_SIGNATURE);
    const whatsapp = OF.quote.renderWhatsApp(model);
    const request = OF.openai.buildChatRequest({
      model: cfg.OPENAI_MODEL, system: SYSTEM_PROMPT, user: OF.quote.buildFormatterUserContent(model, ctx.last_inbound_channel || ctx.source_channel),
      schema: OF.quote.QUOTE_SCHEMA, schemaName: 'quote_texts', temperature: cfg.OPENAI_FORMATTER_TEMPERATURE, maxTokens: 2500,
    });
    return [{ json: {
      ai_mode: cfg.AI_PROVIDER === 'rules' ? 'rules' : 'openai', openai_request: request,
      rfq_id: ctx.id, model, template: { email_subject: email.subject, email_body: email.body, whatsapp_body: whatsapp },
      valid_until: OF.fares.quoteValidUntil(options), require_approval: cfg.REQUIRE_HUMAN_APPROVAL,
    } }];
  }), L('quote', 'fares', 'openai', 'config')), [780, 0]);
  w.add(N.switch('AI Provider', '={{ $json.ai_mode }}', ['openai', 'rules']), [1040, 0]);
  w.add(N.openai('OpenAI Format Quote'), [1300, -100]);
  w.add(N.code('Validate & Choose Text', body(() => {
    const ctx = $('Build Quote + OpenAI Request').first().json;
    let ai = { ok: false, error: 'AI_PROVIDER_RULES' };
    if (ctx.ai_mode === 'openai') ai = OF.openai.parseChatResponse($input.first().json);
    let texts = ctx.template;
    let generatedBy = 'TEMPLATE';
    let validation = { ok: true, errors: [], ai_error: ai.ok ? null : ai.error };
    if (ai.ok) {
      const v = OF.quote.validateFormattedQuote(ai.data, ctx.model);
      validation = { ok: v.ok, errors: v.errors, ai_error: null, fallback_to_template: !v.ok };
      if (v.ok) { texts = ai.data; generatedBy = 'AI'; }
    }
    return [{ json: { db: {
      rfq_id: ctx.rfq_id, email_subject: texts.email_subject, email_body: texts.email_body, whatsapp_body: texts.whatsapp_body,
      quote_model: ctx.model, generated_by: generatedBy, ai_model: ai.ok ? ai.model : null, validation,
      valid_until: ctx.valid_until, require_approval: ctx.require_approval,
    } } }];
  }), L('quote', 'openai')), [1560, 0]);
  w.add(N.pg('Create Quote Version', 'of_create_quote'), [1820, 0]);
  w.add(N.code('Quote Result', body(() => {
    const r = $input.first().json.r;
    if (!r.ok) throw new Error(`Quote creation refused: ${r.error}`);
    return [{ json: Object.assign({}, r, { kind: 'QUOTE', generated_by: $('Validate & Choose Text').first().json.db.generated_by, step: r.send_now ? 'SEND' : 'WAIT_APPROVAL' }) }];
  })), [2080, 0]);
  w.add(N.switch('Auto-send?', '={{ $json.step }}', ['SEND']), [2340, 0]);
  w.add(N.exec('Deliver Quote (WF12)', 'WF12', { wait: true }), [2600, -80]);
  w.add(N.code('Output', body(() => {
    const q = $('Quote Result').first().json;
    const delivery = $('Deliver Quote (WF12)').isExecuted ? $('Deliver Quote (WF12)').first().json : null;
    return [{ json: Object.assign({}, q, { delivery, rfq_status: delivery ? delivery.rfq_status : q.rfq_status }) }];
  })), [2860, 0]);
  w.chain('When Called By Another Workflow', 'Load Payload', 'Load Quote Context', 'Build Quote + OpenAI Request', 'AI Provider');
  w.connect('AI Provider', 'OpenAI Format Quote', 0).connect('AI Provider', 'Validate & Choose Text', 1);
  w.chain('OpenAI Format Quote', 'Validate & Choose Text', 'Create Quote Version', 'Quote Result', 'Auto-send?');
  w.connect('Auto-send?', 'Deliver Quote (WF12)', 0).connect('Auto-send?', 'Output', 1);
  w.chain('Deliver Quote (WF12)', 'Output');
  w.nodes.find((n) => n.name === 'Auto-send?').parameters.options = { fallbackOutput: 'extra', renameFallbackOutput: 'WAIT_APPROVAL' };
  workflows.push(w);
}

// ============================================================================
// WF11 — HUMAN APPROVAL
// ============================================================================
{
  const w = new Workflow('WF11');
  w.add(N.sticky('About WF11', '## WF11 – Human approval\n`POST /webhook/quote/decision` `{ quote_id, action: APPROVE|EDIT|REJECT, reviewer, note, edited?, acknowledge_warnings? }`\n\n* APPROVE → stores who/when/what (SHA-256 of the exact texts) → WF12 delivery\n* EDIT → new quote version; edited text is re-checked against the fare data (warnings must be acknowledged)\n* REJECT → nothing is sent, RFQ back to the fare desk\nOnly the latest pending version can be approved; expired fares cannot be approved.', { width: 600, height: 260 }), [0, -340]);
  w.add(N.webhook('Quote Decision', 'POST', 'quote/decision'), [0, 0]);
  w.add(N.code('Payload', body(() => [{ json: { request: $input.first().json.body || {}, db: { quote_id: ($input.first().json.body || {}).quote_id || null } } }])), [260, 0]);
  w.add(N.pg('Load Quote', 'of_get_quote'), [520, 0]);
  w.add(N.code('Review Decision', body(() => {
    const req = $('Payload').first().json.request;
    const q = $input.first().json.r;
    if (!q) return [{ json: { skip: true, http_status: 404, response: { ok: false, error: 'QUOTE_NOT_FOUND' }, db: {} } }];
    let review = null;
    if (String(req.action).toUpperCase() === 'EDIT' && req.edited) {
      const edited = { email_subject: req.edited.email_subject || q.quote.email_subject, email_body: req.edited.email_body, whatsapp_body: req.edited.whatsapp_body };
      review = OF.quote.reviewEditedQuote(edited, q.quote_model);
    }
    return [{ json: { db: {
      quote_id: req.quote_id, action: req.action, reviewer: req.reviewer, note: req.note || null,
      edited: req.edited || null, edit_review: review, acknowledge_warnings: Boolean(req.acknowledge_warnings),
    } } }];
  }), L('quote')), [780, 0]);
  w.add(N.pg('Apply Decision', 'of_quote_decision'), [1040, 0]);
  w.add(N.code('Decision Result', body(() => {
    const r = $input.first().json.r || {};
    return [{ json: { step: r.ok && r.send ? 'SEND' : 'DONE', rfq_id: r.rfq_id, quote_id: r.quote_id, kind: 'QUOTE', http_status: r.ok ? 200 : 409, response: r } }];
  })), [1300, 0]);
  w.add(N.switch('Send?', '={{ $json.step }}', ['SEND', 'DONE']), [1560, 0]);
  w.add(N.exec('Deliver Quote (WF12)', 'WF12', { wait: true }), [1820, -100]);
  w.add(N.code('Delivery Response', body(() => {
    const d = $input.first().json;
    return [{ json: { http_status: 200, response: Object.assign({}, $('Decision Result').first().json.response, { delivery: { channel: d.channel, delivery_status: d.delivery_status, rfq_status: d.rfq_status, delivered: d.delivered } }) } }];
  })), [2080, -100]);
  w.add(N.respond('Respond'), [2340, 0]);
  w.chain('Quote Decision', 'Payload', 'Load Quote', 'Review Decision', 'Apply Decision', 'Decision Result', 'Send?');
  w.connect('Send?', 'Deliver Quote (WF12)', 0).connect('Send?', 'Respond', 1);
  w.chain('Deliver Quote (WF12)', 'Delivery Response', 'Respond');
  workflows.push(w);
}

// ============================================================================
// WF12 — QUOTE & MESSAGE DELIVERY (outbound channel gateway)
// ============================================================================
{
  const w = new Workflow('WF12');
  w.add(N.sticky('About WF12', '## WF12 – Delivery (quotes and all outbound messages)\nChannel = override › channel of the agent\'s latest message › contact preference. **One channel only** (no double-sending).\nEmail: reply in the same Gmail thread when known. WhatsApp: Cloud API; outside the 24 h session only an approved template may be sent.\nDEMO_MODE=true → delivery is **simulated** and recorded (`delivery_status = SIMULATED`).\nRecords the outbound message, quote `SENT`, RFQ `APPROVED → QUOTED → AWAITING_CLIENT`.', { width: 640, height: 260 }), [0, -380]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.code('Load Payload', body(() => [{ json: { input: $input.first().json, db: { rfq_id: $input.first().json.rfq_id, quote_id: $input.first().json.quote_id || null } } }])), [260, 0]);
  w.add(N.pg('Load Delivery Context', 'of_get_delivery_context'), [520, 0]);
  w.add(N.code('Plan Delivery', body(() => {
    const cfg = OF.config.getConfig($env);
    const ctx = $input.first().json.r;
    const input = Object.assign({}, $('Load Payload').first().json.input);
    if (input.kind === 'QUOTE' && ctx.quote) {
      // Quote texts always come from the approved quote version stored in the DB.
      input.email = { subject: ctx.quote.email_subject, body: ctx.quote.email_body };
      input.whatsapp = { body: ctx.quote.whatsapp_body };
    }
    // Human-approval gate: a quote is only delivered when its version is APPROVED (also enforced in of_record_outbound).
    const quoteBlocked = input.kind === 'QUOTE' && (!ctx.quote || ctx.quote.status !== 'APPROVED');
    const contact = (ctx && ctx.rfq && ctx.rfq.contact) || {};
    const wa = ctx.whatsapp;
    const email = ctx.email;
    const preferred = input.channel_override || ctx.last_inbound_channel || contact.preferred_channel || ctx.rfq.source_channel || 'email';
    const canEmail = Boolean(contact.email);
    const canWa = Boolean(contact.whatsapp_phone || (wa && wa.phone));
    let channel = preferred === 'whatsapp' && canWa ? 'whatsapp' : canEmail ? 'email' : canWa ? 'whatsapp' : null;
    let text = channel === 'whatsapp' ? (input.whatsapp && input.whatsapp.body) : (input.email && input.email.body);
    const subject = (input.email && input.email.subject) || `${ctx.rfq.rfq_number}`;
    let template = null;
    if (channel === 'whatsapp' && !OF.whatsapp.sessionOpen(wa && wa.last_inbound_at, new Date())) {
      if (input.kind === 'FOLLOWUP' && cfg.WHATSAPP_FOLLOWUP_TEMPLATE) template = { name: cfg.WHATSAPP_FOLLOWUP_TEMPLATE, language: cfg.WHATSAPP_TEMPLATE_LANGUAGE, params: [contact.first_name || 'there', ctx.rfq.rfq_number] };
      else if (canEmail) { channel = 'email'; text = input.email && input.email.body; }
      else channel = null;
    }
    const to = channel === 'whatsapp' ? (contact.whatsapp_phone || wa.phone) : contact.email;
    let mode = quoteBlocked || !channel || !text ? 'NONE' : cfg.DEMO_MODE ? 'SIMULATE' : channel === 'whatsapp' ? 'WHATSAPP' : email && email.last_inbound_external_id && !String(email.thread_id || '').startsWith('demo') ? 'EMAIL_REPLY' : 'EMAIL_NEW';
    const waPayload = channel === 'whatsapp' ? (template ? OF.whatsapp.buildTemplateMessage(to, template.name, template.language, template.params) : OF.whatsapp.buildTextMessage(to, text)) : null;
    return [{ json: {
      mode, channel, to, subject, text, template, wa_payload: waPayload,
      wa_url: `https://graph.facebook.com/${cfg.WHATSAPP_GRAPH_VERSION}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      reply_to_message_id: email ? email.last_inbound_external_id : null,
      conversation_id: channel === 'whatsapp' ? (wa && wa.conversation_id) : (email && email.conversation_id),
      reason: quoteBlocked ? 'QUOTE_NOT_APPROVED' : !channel ? 'NO_USABLE_CHANNEL' : null,
    } }];
  }), L('whatsapp', 'config')), [780, 0]);
  w.add(N.switch('Delivery Mode', '={{ $json.mode }}', ['SIMULATE', 'EMAIL_REPLY', 'EMAIL_NEW', 'WHATSAPP', 'NONE']), [1040, 0]);
  w.add(N.code('Simulate Delivery', body(() => [{ json: { delivery_status: 'SIMULATED', external_message_id: `sim-${$execution.id}-${Date.now()}` } }])), [1300, -300]);
  w.add({
    name: 'Gmail Reply In Thread',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    parameters: { resource: 'message', operation: 'reply', messageId: '={{ $json.reply_to_message_id }}', emailType: 'text', message: '={{ $json.text }}', options: { appendAttribution: false, replyToSenderOnly: true } },
    credentials: CRED.gmail,
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
  }, [1300, -150]);
  w.add({
    name: 'Gmail Send',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    parameters: { resource: 'message', operation: 'send', sendTo: '={{ $json.to }}', subject: '={{ $json.subject }}', emailType: 'text', message: '={{ $json.text }}', options: { appendAttribution: false } },
    credentials: CRED.gmail,
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
  }, [1300, 0]);
  w.add({
    name: 'WhatsApp Cloud API Send',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    parameters: {
      method: 'POST', url: '={{ $json.wa_url }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.wa_payload) }}', options: { timeout: 20000 },
    },
    credentials: CRED.whatsapp,
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
  }, [1300, 150]);
  w.add(N.code('No Channel', body(() => [{ json: { delivery_status: 'FAILED', error: { message: $('Plan Delivery').first().json.reason || 'NO_TEXT' } } }])), [1300, 300]);
  w.add(N.code('Record Payload', body(() => {
    const plan = $('Plan Delivery').first().json;
    const input = $('Load Payload').first().json.input;
    const res = $input.first().json;
    let status = res.delivery_status;
    let externalId = res.external_message_id || null;
    let error = null;
    if (!status) {
      if (res.error) { status = 'FAILED'; error = typeof res.error === 'string' ? res.error : (res.error.message || JSON.stringify(res.error)); }
      else { status = 'SENT'; externalId = res.id || (res.messages && res.messages[0] && res.messages[0].id) || null; }
    } else if (res.error) error = res.error.message;
    return [{ json: { db: {
      rfq_id: input.rfq_id, quote_id: input.quote_id || null, kind: input.kind, channel: plan.channel || 'email', conversation_id: plan.conversation_id || null,
      recipient: plan.to, subject: plan.channel === 'email' ? plan.subject : null, content: plan.text || '', external_message_id: externalId,
      delivery_status: status, delivery_error: error ? String(error).slice(0, 1000) : null, template: plan.template,
    } } }];
  })), [1560, 0]);
  w.add(N.pg('Record Outbound', 'of_record_outbound'), [1820, 0]);
  w.add(N.code('Output', body(() => {
    const r = $input.first().json.r;
    const plan = $('Record Payload').first().json.db;
    return [{ json: { delivered: Boolean(r.ok), delivery_status: r.ok ? plan.delivery_status : 'BLOCKED_OR_FAILED', channel: plan.channel, message_id: r.message_id || null, rfq_status: r.rfq_status, error: r.error || plan.delivery_error } }];
  })), [2080, 0]);
  w.chain('When Called By Another Workflow', 'Load Payload', 'Load Delivery Context', 'Plan Delivery', 'Delivery Mode');
  ['Simulate Delivery', 'Gmail Reply In Thread', 'Gmail Send', 'WhatsApp Cloud API Send', 'No Channel'].forEach((n, i) => { w.connect('Delivery Mode', n, i); w.connect(n, 'Record Payload'); });
  w.chain('Record Payload', 'Record Outbound', 'Output');
  workflows.push(w);
}

// ============================================================================
// WF13 — FOLLOW-UP ENGINE
// ============================================================================
{
  const w = new Workflow('WF13');
  w.add(N.sticky('About WF13', '## WF13 – Follow-up engine\nEvery 5 min: quotes in QUOTED / AWAITING_CLIENT without a reply.\nChecks status, last agent reply, opt-out, max follow-ups, quote expiry (expired fares are never presented as valid → RECHECK_FARE task), WhatsApp 24 h session (template outside the window).\nEach follow-up is claimed in the DB first (unique rfq/quote/sequence) → never sent twice.\nDemo: `POST /webhook/ops/run-followups {"simulate_hours_ahead": 5}` (DEMO_MODE only).', { width: 620, height: 260 }), [0, -360]);
  w.add(N.schedule('Every 5 Minutes', 5), [0, -60]);
  w.add(N.webhook('Run Now (ops)', 'POST', 'ops/run-followups', { responseMode: 'lastNode' }), [0, 120]);
  w.add(N.code('Payload', body(() => {
    const cfg = OF.config.getConfig($env);
    const req = ($input.first().json && $input.first().json.body) || {};
    const ahead = cfg.DEMO_MODE ? Math.max(0, Math.min(72, Number(req.simulate_hours_ahead) || 0)) : 0;
    return [{ json: { hours_ahead: ahead, db: {} } }];
  }), L('config')), [260, 0]);
  w.add(N.pg('Quotes Awaiting Reply', 'of_followup_candidates'), [520, 0]);
  w.add(N.code('Evaluate Follow-ups', body(() => {
    const cfg = OF.config.getConfig($env);
    const ahead = $('Payload').first().json.hours_ahead;
    const now = new Date(Date.now() + ahead * 3600 * 1000);
    const candidates = $input.first().json.r || [];
    const results = candidates.map((c) => Object.assign({ candidate: c }, OF.followup.evaluateFollowup(c, now, cfg)));
    const skipped = results.filter((r) => r.action === 'SKIP').map((r) => ({ rfq: r.candidate.rfq_number, reason: r.reason }));
    const due = results.filter((r) => r.action === 'SEND');
    if (!due.length) return [{ json: { step: 'NONE', evaluated: candidates.length, skipped } }];
    return due.map((r) => ({ json: { step: 'SEND', evaluated: candidates.length, skipped, plan: r, db: { rfq_id: r.candidate.rfq_id, quote_id: r.candidate.quote_id, sequence: r.sequence, channel: r.channel, quote_expired: r.quote_expired } } }));
  }), L('followup', 'config')), [780, 0]);
  w.add(N.switch('Any Due?', '={{ $json.step }}', ['SEND', 'NONE']), [1040, 0]);
  w.add(N.pg('Claim Follow-up (unique)', 'of_claim_followup'), [1300, -100]);
  w.add(N.code('Build Messages', body(() => {
    const plans = $('Any Due?').all();
    return $input.all().map((i, idx) => ({ i, plan: plans[idx].json.plan })).filter((x) => x.i.json.r.claimed).map(({ i, plan }) => ({ json: {
      followup_id: i.json.r.followup_id, rfq_id: plan.candidate.rfq_id, kind: 'FOLLOWUP', channel_override: plan.channel,
      email: { subject: plan.subject, body: plan.text }, whatsapp: { body: plan.text }, sequence: plan.sequence,
    } }));
  })), [1560, -100]);
  w.add(N.exec('Deliver Follow-up (WF12)', 'WF12', { wait: true, each: true }), [1820, -100]);
  w.add(N.code('Record Payload', body(() => {
    const built = $('Build Messages').all();
    return $input.all().map((res, idx) => ({ json: { db: { followup_id: built[idx].json.followup_id, delivered: Boolean(res.json.delivered), message_id: res.json.message_id || null } } }));
  })), [2080, -100]);
  w.add(N.pg('Record Follow-up', 'of_record_followup'), [2340, -100]);
  w.add(N.code('Summary', body(() => {
    const ev = $('Evaluate Follow-ups').first().json;
    const sent = $('Record Follow-up').isExecuted ? $('Record Follow-up').all().map((i) => i.json.r.status) : [];
    return [{ json: { evaluated: ev.evaluated, sent: sent.filter((s) => s === 'SENT').length, failed: sent.filter((s) => s === 'FAILED').length, skipped: ev.skipped } }];
  })), [2600, 0]);
  w.chain('Every 5 Minutes', 'Payload');
  w.chain('Run Now (ops)', 'Payload', 'Quotes Awaiting Reply', 'Evaluate Follow-ups', 'Any Due?');
  w.connect('Any Due?', 'Claim Follow-up (unique)', 0).connect('Any Due?', 'Summary', 1);
  w.chain('Claim Follow-up (unique)', 'Build Messages', 'Deliver Follow-up (WF12)', 'Record Payload', 'Record Follow-up', 'Summary');
  workflows.push(w);
}

// ============================================================================
// WF14 — CLIENT RESPONSE HANDLER
// ============================================================================
{
  const w = new Workflow('WF14');
  w.add(N.sticky('About WF14', '## WF14 – Client response handler\nInterprets replies to a sent quote: option selection ("option 2", "second one", "book Qatar"), hold, price objection, alternatives, requirement changes, decline.\nA booking is only requested when the message identifies exactly ONE option (model + deterministic evidence must agree); otherwise the agent is asked to confirm.\n**BOOKING_REQUESTED** → Ticketing Desk handoff summary. No ticket is ever issued automatically.', { width: 620, height: 240 }), [0, -380]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.code('Build OpenAI Request', withConst('SYSTEM_PROMPT', P.response, () => {
    const cfg = OF.config.getConfig($env);
    const ctx = $input.first().json;
    const options = ctx.claim.quote_options || [];
    const request = OF.openai.buildChatRequest({
      model: cfg.OPENAI_MODEL, system: SYSTEM_PROMPT, user: OF.responses.buildResponseUserContent({ message: ctx.message, options, rfq: ctx.active_rfq }),
      schema: OF.responses.RESPONSE_SCHEMA, schemaName: 'client_response', temperature: cfg.OPENAI_TEMPERATURE, maxTokens: 300,
    });
    return [{ json: Object.assign({}, ctx, { ai_mode: cfg.AI_PROVIDER === 'rules' ? 'rules' : 'openai', openai_request: request }) }];
  }), L('responses', 'openai', 'config')), [260, 0]);
  w.add(N.switch('AI Provider', '={{ $json.ai_mode }}', ['openai', 'rules']), [520, 0]);
  w.add(N.openai('OpenAI Classify Reply'), [780, -100]);
  w.add(N.code('Reconcile Decision', body(() => {
    const cfg = OF.config.getConfig($env);
    const ctx = $('Build OpenAI Request').first().json;
    let ai = { ok: false, error: 'AI_PROVIDER_RULES' };
    if (ctx.ai_mode === 'openai') ai = OF.openai.parseChatResponse($input.first().json);
    const options = ctx.claim.quote_options || [];
    const decision = OF.responses.reconcileResponse(ai.ok ? ai.data : null, ctx.message.text, options, cfg.AI_CONFIDENCE_THRESHOLD);
    if (!ai.ok) decision.ai_error = ai.error;
    const path = decision.action === 'CHANGE_REQUIREMENTS' ? 'REQUOTE' : 'DECISION';
    return [{ json: { path, decision, rfq_id: ctx.active_rfq.id, db: {
      rfq_id: ctx.active_rfq.id, message_id: ctx.message.id, action: decision.action, selected_option_code: decision.selected_option_code,
      needs_confirmation: decision.needs_confirmation, confidence: decision.confidence, requested_airlines: decision.requested_airlines,
      reason: decision.reason, source: decision.source, client_message: ctx.message.text,
    } } }];
  }), L('responses', 'openai', 'config')), [1040, 0]);
  w.add(N.switch('Requote or Decision', '={{ $json.path }}', ['DECISION', 'REQUOTE']), [1300, 0]);

  // DECISION path
  w.add(N.pg('Record Client Decision', 'of_record_client_decision'), [1560, -160]);
  w.add(N.code('Decision Outcome', body(() => {
    const r = $input.first().json.r;
    if (!r.ok) throw new Error(`Client decision refused: ${r.error}`);
    return [{ json: Object.assign({}, r, { decision: $('Reconcile Decision').first().json.decision }) }];
  })), [1820, -160]);
  w.add(N.switch('Outcome', '={{ $json.result }}', ['BOOKING_REQUESTED', 'CONFIRMATION_REQUIRED', 'BACK_TO_FARE_DESK']), [2080, -160]);
  w.add(N.code('Ticketing Handoff', body(() => {
    const r = $input.first().json;
    return [{ json: { rfq_id: r.rfq_id, desk_override: 'TICKETING_DESK', title: `${r.rfq_number}: BOOKING REQUESTED – ${r.handoff.selected_option.code} ${r.handoff.selected_option.airline}`, handoff: r.handoff, reason_key: 'BOOKING' } }];
  })), [2340, -360]);
  w.add(N.exec('Notify Ticketing Desk (WF09)', 'WF09', { wait: true }), [2600, -360]);
  w.add(N.code('Booking Acknowledgement', body(() => {
    const cfg = OF.config.getConfig($env);
    const ctx = $('Build OpenAI Request').first().json;
    const r = $('Ticketing Handoff').first().json;
    const d = $('Reconcile Decision').first().json.decision;
    const t = OF.notifications.bookingAcknowledgement({ rfqNumber: ctx.active_rfq.rfq_number, optionNo: d.selected_option_number, airline: r.handoff.selected_option.airline,
      contactName: ctx.claim.contact ? ctx.claim.contact.first_name : null, requiresRecheck: r.handoff.requires_fare_recheck, originalSubject: ctx.message.subject, signature: cfg.COMPANY_SIGNATURE });
    return [{ json: { rfq_id: r.rfq_id, kind: 'BOOKING_ACK', channel_override: ctx.channel, email: { subject: t.subject, body: t.email_body }, whatsapp: { body: t.whatsapp_body } } }];
  }), L('notifications', 'config')), [2860, -360]);
  w.add(N.exec('Send Booking Acknowledgement (WF12)', 'WF12', { wait: true }), [3120, -360]);
  w.add(N.code('Confirmation Question', body(() => {
    const cfg = OF.config.getConfig($env);
    const ctx = $('Build OpenAI Request').first().json;
    const q = OF.responses.confirmationQuestion(ctx.claim.quote_options || [], ctx.claim.contact ? ctx.claim.contact.first_name : null);
    const t = OF.notifications.confirmationRequest({ question: q, rfqNumber: ctx.active_rfq.rfq_number, originalSubject: ctx.message.subject, contactName: ctx.claim.contact ? ctx.claim.contact.first_name : null, signature: cfg.COMPANY_SIGNATURE });
    return [{ json: { rfq_id: ctx.active_rfq.id, kind: 'CONFIRMATION_QUESTION', channel_override: ctx.channel, email: { subject: t.subject, body: t.email_body }, whatsapp: { body: t.whatsapp_body } } }];
  }), L('responses', 'notifications', 'config')), [2340, -160]);
  w.add(N.exec('Ask Which Option (WF12)', 'WF12', { wait: true }), [2600, -160]);
  w.add(N.code('Back To Desk Payload', body(() => {
    const r = $input.first().json;
    return [{ json: { rfq_id: r.rfq_id, intent: 'PRICE_CHECK' } }];
  })), [2340, 20]);
  w.add(N.exec('Recalculate Priority (WF07)', 'WF07', { wait: true }), [2600, 20]);
  w.add(N.code('Desk Note', body(() => {
    const r = $('Decision Outcome').first().json;
    return [{ json: { rfq_id: r.rfq_id, note: r.desk_note, title: `${r.rfq_number}: agent asks for ${r.decision.action === 'PRICE_OBJECTION' ? 'a cheaper fare' : 'alternatives'}`, reason_key: `RECHECK-${Date.now()}` } }];
  })), [2860, 20]);
  w.add(N.exec('Back To Fare Desk (WF09)', 'WF09', { wait: true }), [3120, 20]);
  w.add(N.code('Holding Reply', body(() => {
    const cfg = OF.config.getConfig($env);
    const ctx = $('Build OpenAI Request').first().json;
    const d = $('Reconcile Decision').first().json.decision;
    const t = OF.notifications.researchAcknowledgement({ rfqNumber: ctx.active_rfq.rfq_number, contactName: ctx.claim.contact ? ctx.claim.contact.first_name : null, kind: d.action, airlines: d.requested_airlines, originalSubject: ctx.message.subject, signature: cfg.COMPANY_SIGNATURE });
    return [{ json: { rfq_id: ctx.active_rfq.id, kind: 'ACK', channel_override: ctx.channel, email: { subject: t.subject, body: t.email_body }, whatsapp: { body: t.whatsapp_body } } }];
  }), L('notifications', 'config')), [3380, 20]);
  w.add(N.exec('Send Holding Reply (WF12)', 'WF12', { wait: true }), [3640, 20]);

  // REQUOTE path (dates / pax changed before booking)
  w.add(N.code('Extraction Input', body(() => {
    const ctx = $('Build OpenAI Request').first().json;
    return [{ json: { message: ctx.message, channel: ctx.channel, today: ctx.today, intent: 'NEW_QUOTE', context: { requirements: ctx.active_rfq.requirements } } }];
  })), [1560, 200]);
  w.add(N.exec('Extract Changes (WF04)', 'WF04', { wait: true }), [1820, 200]);
  w.add(N.code('Merge Changes', body(() => {
    const ctx = $('Build OpenAI Request').first().json;
    const ex = $input.first().json.extraction;
    const merged = OF.requirements.mergeRequirements(ctx.active_rfq.requirements, Object.assign({}, ex.delta, { is_update_to_existing: true }));
    return [{ json: { db: {
      workflow: $workflow.name, execution_id: $execution.id, rfq_id: ctx.active_rfq.id, message_id: ctx.message.id, conversation_id: ctx.claim.conversation.id,
      channel: ctx.channel, intent: 'NEW_QUOTE', requirements: merged.requirements, ready: merged.requirements.ready_for_processing, changes: merged.changes,
      summary: OF.requirements.summarize(merged.requirements), allow_requote: true, debounce_seconds: 0,
      classification: { intent: 'QUOTE_FOLLOWUP', action: 'CHANGE_REQUIREMENTS', source: $('Reconcile Decision').first().json.decision.source },
      extraction_meta: { source: ex.source, report: ex.report.slice(0, 30) },
    } } }];
  }), L('requirements')), [2080, 200]);
  w.add(N.pg('Update RFQ (requote)', 'of_upsert_rfq_from_message'), [2340, 200]);
  w.add(N.code('Requote Result', body(() => {
    const r = $input.first().json.r;
    if (!r.ok) throw new Error(`Requote refused: ${r.error}`);
    return [{ json: { rfq_id: r.rfq_id, status: r.status, step: r.status === 'READY_FOR_SEARCH' ? 'ROUTE' : 'ASK_MISSING', note: 'Agent changed requirements after the quote – new search needed', title: `${r.rfq_number}: requirements changed – requote`, reason_key: `REQUOTE-${Date.now()}` } }];
  })), [2600, 200]);
  w.add(N.switch('Requote Next', '={{ $json.step }}', ['ROUTE', 'ASK_MISSING']), [2860, 200]);
  w.add(N.exec('Route Requote (WF09)', 'WF09', { wait: true }), [3120, 160]);
  w.add(N.exec('Ask Missing (WF05)', 'WF05', { wait: false }), [3120, 320]);
  w.add(N.code('Output', body(() => [{ json: { handled: true, decision: $('Reconcile Decision').first().json.decision } }])), [3900, 0]);

  w.chain('When Called By Another Workflow', 'Build OpenAI Request', 'AI Provider');
  w.connect('AI Provider', 'OpenAI Classify Reply', 0).connect('AI Provider', 'Reconcile Decision', 1);
  w.chain('OpenAI Classify Reply', 'Reconcile Decision', 'Requote or Decision');
  w.connect('Requote or Decision', 'Record Client Decision', 0).connect('Requote or Decision', 'Extraction Input', 1);
  w.chain('Record Client Decision', 'Decision Outcome', 'Outcome');
  w.connect('Outcome', 'Ticketing Handoff', 0).connect('Outcome', 'Confirmation Question', 1).connect('Outcome', 'Back To Desk Payload', 2).connect('Outcome', 'Output', 3);
  w.chain('Ticketing Handoff', 'Notify Ticketing Desk (WF09)', 'Booking Acknowledgement', 'Send Booking Acknowledgement (WF12)', 'Output');
  w.chain('Confirmation Question', 'Ask Which Option (WF12)', 'Output');
  w.chain('Back To Desk Payload', 'Recalculate Priority (WF07)', 'Desk Note', 'Back To Fare Desk (WF09)', 'Holding Reply', 'Send Holding Reply (WF12)', 'Output');
  w.chain('Extraction Input', 'Extract Changes (WF04)', 'Merge Changes', 'Update RFQ (requote)', 'Requote Result', 'Requote Next');
  w.connect('Requote Next', 'Route Requote (WF09)', 0).connect('Requote Next', 'Ask Missing (WF05)', 1);
  w.chain('Route Requote (WF09)', 'Output');
  w.chain('Ask Missing (WF05)', 'Output');
  const outcome = w.nodes.find((n) => n.name === 'Outcome');
  outcome.parameters.options = { fallbackOutput: 'extra', renameFallbackOutput: 'OTHER' };
  workflows.push(w);
}

// ============================================================================
// WF15 — AFTER-SALES ROUTER (change / cancellation / refund)
// ============================================================================
{
  const w = new Workflow('WF15');
  w.add(N.sticky('About WF15', '## WF15 – After-sales router\nChange / cancellation / refund requests become **human tasks** – the system never states penalties or refund amounts.\nFinds the booking (PNR or the agent\'s ticketed booking for the mentioned date) → CHANGE_REQUESTED / REFUND_REQUESTED → priority (travel < 24 h → CRITICAL) → Ticketing / Refund desk → neutral acknowledgement.', { width: 600, height: 220 }), [0, -320]);
  w.add(N.trigger(), [0, 0]);
  w.add(N.code('After-Sales Details', body(() => {
    const ctx = $input.first().json;
    const text = `${ctx.message.subject || ''}\n${ctx.message.text}`;
    const dates = OF.dates.findDates(text, { today: ctx.today }).filter((d) => d.iso);
    return [{ json: { ctx, db: {
      workflow: $workflow.name, intent: ctx.intent, message_id: ctx.message.id, conversation_id: ctx.claim.conversation.id,
      contact_id: ctx.claim.contact ? ctx.claim.contact.id : null, agency_id: ctx.claim.agency ? ctx.claim.agency.id : null,
      booking_reference: OF.text.findBookingReference(text), travel_date: dates.length ? dates[0].iso : null,
      summary: ctx.message.text.slice(0, 200), channel: ctx.channel,
    } } }];
  }), L('dates', 'text')), [260, 0]);
  w.add(N.pg('Open After-Sales Case', 'of_create_after_sales_case'), [520, 0]);
  w.add(N.code('Priority Input', body(() => {
    const r = $input.first().json.r;
    const d = $('After-Sales Details').first().json.db;
    return [{ json: { rfq_id: r.rfq_id, intent: d.intent, travel_date: d.travel_date || r.travel_date } }];
  })), [780, 0]);
  w.add(N.exec('Calculate Priority (WF07)', 'WF07', { wait: true }), [1040, 0]);
  w.add(N.code('Routing Input', body(() => {
    const r = $('Open After-Sales Case').first().json.r;
    const p = $input.first().json;
    return [{ json: { rfq_id: r.rfq_id, desk_override: r.status === 'CHANGE_REQUESTED' ? 'TICKETING_DESK' : 'REFUND_DESK', title: `${r.rfq_number}: ${r.status.replace('_', ' ').toLowerCase()} (${p.level})`, note: $('After-Sales Details').first().json.db.summary, reason_key: r.status } }];
  })), [1300, 0]);
  w.add(N.exec('Route To Desk (WF09)', 'WF09', { wait: true }), [1560, 0]);
  w.add(N.code('Acknowledgement', body(() => {
    const cfg = OF.config.getConfig($env);
    const ctx = $('After-Sales Details').first().json.ctx;
    const r = $('Open After-Sales Case').first().json.r;
    const route = $input.first().json;
    const t = OF.notifications.afterSalesAcknowledgement({ rfqNumber: r.rfq_number, contactName: ctx.claim.contact ? ctx.claim.contact.first_name : null,
      type: ctx.intent === 'CHANGE_REQUEST' ? 'CHANGE' : ctx.intent === 'CANCELLATION' ? 'CANCELLATION' : 'REFUND', bookingReference: r.booking_reference,
      travelDate: r.travel_date, deskName: route.desk_name, originalSubject: ctx.message.subject, signature: cfg.COMPANY_SIGNATURE });
    return [{ json: { rfq_id: r.rfq_id, kind: 'AFTER_SALES_ACK', channel_override: ctx.channel, email: { subject: t.subject, body: t.email_body }, whatsapp: { body: t.whatsapp_body } } }];
  }), L('notifications', 'config')), [1820, 0]);
  w.add(N.exec('Send Acknowledgement (WF12)', 'WF12', { wait: true }), [2080, 0]);
  w.add(N.code('Output', body(() => [{ json: Object.assign({ rfq_id: $('Open After-Sales Case').first().json.r.rfq_id }, $('Open After-Sales Case').first().json.r) }])), [2340, 0]);
  w.chain('When Called By Another Workflow', 'After-Sales Details', 'Open After-Sales Case', 'Priority Input', 'Calculate Priority (WF07)', 'Routing Input', 'Route To Desk (WF09)', 'Acknowledgement', 'Send Acknowledgement (WF12)', 'Output');
  workflows.push(w);
}

// ============================================================================
// WF16 — MOCK FARE DESK / FARE PROVIDER INTAKE
// ============================================================================
{
  const w = new Workflow('WF16');
  w.add(N.sticky('About WF16', '## WF16 – Fare desk intake (Mock Fare Desk / ManualFareProvider)\n`POST /webhook/fare-desk/options` `{ rfq_number, entered_by, options: [...] }` – the ONLY way fares enter the system (validated: amount, currency, penalties, baggage, validity, verified flag).\n`POST /webhook/fare-desk/mock-options` `{ rfq_number }` – DEMO_MODE sample options (MockFareProvider) to pre-fill the form.\nReplace with an Amadeus / Sabre / NDC adapter later – see docs/future-integrations.md.', { width: 640, height: 240 }), [0, -340]);
  w.add(N.webhook('Submit Fare Options', 'POST', 'fare-desk/options'), [0, 0]);
  w.add(N.code('Payload', body(() => {
    const b = $input.first().json.body || {};
    return [{ json: { request: b, db: { rfq_number: b.rfq_number || null, rfq_id: b.rfq_id || null } } }];
  })), [260, 0]);
  w.add(N.pg('Load RFQ', 'of_get_quote_context'), [520, 0]);
  w.add(N.code('Validate Fare Options', body(() => {
    const req = $('Payload').first().json.request;
    const rfq = $input.first().json.r;
    if (!rfq) return [{ json: { valid: 'NO', http_status: 404, response: { ok: false, error: 'RFQ_NOT_FOUND' } } }];
    if (!req.entered_by) return [{ json: { valid: 'NO', http_status: 422, response: { ok: false, error: 'entered_by is required' } } }];
    const check = OF.fares.validateFareOptions(req.options, { rfq: { trip_type: rfq.trip_type, cabin: rfq.cabin }, now: new Date() });
    if (!check.ok) return [{ json: { valid: 'NO', http_status: 422, response: { ok: false, error: 'VALIDATION_FAILED', errors: check.errors } } }];
    return [{ json: { valid: 'YES', db: { rfq_id: rfq.id, entered_by: req.entered_by, options: check.options } } }];
  }), L('fares')), [780, 0]);
  w.add(N.switch('Valid?', '={{ $json.valid }}', ['YES', 'NO']), [1040, 0]);
  w.add(N.pg('Save Fare Options', 'of_save_fare_options'), [1300, -100]);
  w.add(N.code('Saved?', body(() => {
    const r = $input.first().json.r;
    return [{ json: { saved: r.ok ? 'YES' : 'NO', rfq_id: r.rfq_id, http_status: r.ok ? 200 : 409, response: r } }];
  })), [1560, -100]);
  w.add(N.switch('Generate Quote?', '={{ $json.saved }}', ['YES', 'NO']), [1820, -100]);
  w.add(N.exec('Format Quote (WF10)', 'WF10', { wait: true }), [2080, -180]);
  w.add(N.code('Success Response', body(() => {
    const q = $input.first().json;
    return [{ json: { http_status: 200, response: { ok: true, fares: $('Saved?').first().json.response, quote: { quote_id: q.quote_id, version: q.version, status: q.quote_status, rfq_status: q.rfq_status, generated_by: q.generated_by } } } }];
  })), [2340, -180]);
  w.add(N.respond('Respond'), [2600, 0]);
  w.chain('Submit Fare Options', 'Payload', 'Load RFQ', 'Validate Fare Options', 'Valid?');
  w.connect('Valid?', 'Save Fare Options', 0).connect('Valid?', 'Respond', 1);
  w.chain('Save Fare Options', 'Saved?', 'Generate Quote?');
  w.connect('Generate Quote?', 'Format Quote (WF10)', 0).connect('Generate Quote?', 'Respond', 1);
  w.chain('Format Quote (WF10)', 'Success Response', 'Respond');

  w.add(N.webhook('Mock Options (demo)', 'POST', 'fare-desk/mock-options'), [0, 300]);
  w.add(N.code('Mock Payload', body(() => {
    const b = $input.first().json.body || {};
    return [{ json: { db: { rfq_number: b.rfq_number || null, rfq_id: b.rfq_id || null } } }];
  })), [260, 300]);
  w.add(N.pg('Load RFQ (mock)', 'of_get_quote_context'), [520, 300]);
  w.add(N.code('MockFareProvider.searchFlights', body(() => {
    const cfg = OF.config.getConfig($env);
    const rfq = $input.first().json.r;
    if (!cfg.DEMO_MODE) return [{ json: { http_status: 403, response: { ok: false, error: 'MOCK_PROVIDER_DISABLED (DEMO_MODE=false)' } } }];
    if (!rfq) return [{ json: { http_status: 404, response: { ok: false, error: 'RFQ_NOT_FOUND' } } }];
    const options = OF.mockFareProvider.MockFareProvider.sampleOptions(rfq.requirements, new Date());
    return [{ json: { http_status: 200, response: { ok: true, provider: 'MockFareProvider', disclaimer: 'DEMO sample data – not real fares or availability', options } } }];
  }), L('providers/mockFareProvider', 'config')), [780, 300]);
  w.add(N.respond('Respond (mock)'), [1040, 300]);
  w.chain('Mock Options (demo)', 'Mock Payload', 'Load RFQ (mock)', 'MockFareProvider.searchFlights', 'Respond (mock)');
  workflows.push(w);
}

// ============================================================================
// WF17 — OPERATOR ACTIONS (ops console)
// ============================================================================
{
  const w = new Workflow('WF17');
  w.add(N.sticky('About WF17', '## WF17 – Operator actions\n`POST /webhook/ops/action` `{ action, rfq_number, operator, ... }`\nSTART_SEARCH · START_TICKETING · MARK_TICKETED (PNR) · RESOLVE_AFTER_SALES · MARK_LOST · CANCEL · CLOSE · REOPEN · CLEAR_HUMAN_FLAG · RESOLVE_ALERT · ACK_ALERT · RETRY_MESSAGE (dead letter) · RESEND_QUOTE (failed delivery)\nAll transitions go through the DB state machine and are audited with the operator name.', { width: 620, height: 220 }), [0, -320]);
  w.add(N.webhook('Operator Action', 'POST', 'ops/action'), [0, 0]);
  w.add(N.code('Payload', body(() => [{ json: { db: $input.first().json.body || {} } }])), [260, 0]);
  w.add(N.pg('Apply Action', 'of_operator_action'), [520, 0]);
  w.add(N.code('Follow-on', body(() => {
    const r = $input.first().json.r;
    const req = $('Payload').first().json.db;
    let next = 'NONE';
    if (r.ok && String(req.action).toUpperCase() === 'REOPEN') next = 'ROUTE';
    if (r.ok && String(req.action).toUpperCase() === 'RETRY_MESSAGE' && r.conversation_id) next = 'REPROCESS';
    if (r.ok && String(req.action).toUpperCase() === 'RESEND_QUOTE' && r.quote_id) next = 'DELIVER';
    return [{ json: { next, rfq_id: r.rfq_id, quote_id: r.quote_id || null, kind: 'QUOTE', conversation_id: r.conversation_id, http_status: r.ok ? 200 : 409, response: r } }];
  })), [780, 0]);
  w.add(N.switch('Next', '={{ $json.next }}', ['ROUTE', 'REPROCESS', 'DELIVER', 'NONE']), [1040, 0]);
  w.add(N.exec('Route (WF09)', 'WF09', { wait: true }), [1300, -120]);
  w.add(N.exec('Reprocess (WF06)', 'WF06', { wait: false }), [1300, 40]);
  w.add(N.exec('Resend Quote (WF12)', 'WF12', { wait: true }), [1300, 200]);
  w.add(N.code('Response', body(() => [{ json: { http_status: $('Follow-on').first().json.http_status, response: $('Follow-on').first().json.response } }])), [1560, 0]);
  w.add(N.respond('Respond'), [1820, 0]);
  w.chain('Operator Action', 'Payload', 'Apply Action', 'Follow-on', 'Next');
  w.connect('Next', 'Route (WF09)', 0).connect('Next', 'Reprocess (WF06)', 1).connect('Next', 'Resend Quote (WF12)', 2).connect('Next', 'Response', 3);
  w.chain('Route (WF09)', 'Response');
  w.chain('Resend Quote (WF12)', 'Response');
  w.chain('Reprocess (WF06)', 'Response', 'Respond');
  workflows.push(w);
}

// ============================================================================
// WF99 — ERROR HANDLER
// ============================================================================
{
  const w = new Workflow('WF99', { errorWorkflow: false });
  w.add(N.sticky('About WF99', '## WF99 – Error handler (error workflow of every WF)\nLogs the failure (secrets redacted) in `workflow_errors`, raises a deduplicated alert, and – if an inbound message was being processed – marks it FAILED with exponential backoff (1 / 5 / 15 min). After 3 failures it goes to the **dead letter** state (visible in the console, `RETRY_MESSAGE` action).\nNode-level: OpenAI errors fall back to rules; Postgres / Gmail / WhatsApp nodes retry before failing.', { width: 640, height: 240 }), [0, -320]);
  w.add({ name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {} }, [0, 0]);
  w.add(N.code('Build Error Record', body(() => {
    const e = $input.first().json;
    const exec = e.execution || {};
    const err = exec.error || e.trigger && e.trigger.error || {};
    const safe = OF.security.redactObject({ message: err.message, description: err.description, node: exec.lastNodeExecuted, mode: exec.mode });
    return [{ json: { db: {
      workflow: 'WF99_ERROR_HANDLER', workflow_id: e.workflow ? e.workflow.id : null, workflow_name: e.workflow ? e.workflow.name : null,
      execution_id: exec.id ? String(exec.id) : null, node: exec.lastNodeExecuted || null,
      error_message: OF.security.redactSecrets(err.message || 'Unknown error'), details: safe,
    } } }];
  }), L('security')), [260, 0]);
  w.add(N.pg('Record Error / Retry / Dead Letter', 'of_record_workflow_error'), [520, 0]);
  w.chain('Error Trigger', 'Build Error Record', 'Record Error / Retry / Dead Letter');
  workflows.push(w);
}

// ============================================================================
// Write files
// ============================================================================
const outDir = path.join(ROOT, 'n8n');
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/^WF\d+_.*\.json$/.test(f)) fs.unlinkSync(path.join(outDir, f));
for (const w of workflows) {
  const json = w.toJSON();
  // sanity: every connection target exists
  const names = new Set(json.nodes.map((n) => n.name));
  for (const [from, conn] of Object.entries(json.connections)) {
    if (!names.has(from)) throw new Error(`${json.name}: connection from unknown node ${from}`);
    for (const out of conn.main) for (const c of out) if (!names.has(c.node)) throw new Error(`${json.name}: connection to unknown node ${c.node}`);
  }
  fs.writeFileSync(path.join(outDir, `${json.name}.json`), `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`Generated ${workflows.length} workflows in n8n/`);
