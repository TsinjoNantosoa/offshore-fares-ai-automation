#!/usr/bin/env node
'use strict';
/**
 * npm run smoke:openai
 *
 * Real OpenAI check, using EXACTLY the prompts (prompts/*.md), JSON schemas and code
 * validations of the n8n workflows:
 *   1. connection + model availability
 *   2. intent classification       (WF03)
 *   3. structured extraction        (WF04) + evidence verification + deterministic merge
 *   4. JSON / business validation   (route, pax, cabin, dates, airline, priority)
 *   5. quote formatting             (WF10) – the 2,450 fare must survive verbatim
 *   6. optional: full pipeline through the running stack (--stack) when AI_PROVIDER=openai
 *
 * The key is read from OPENAI_API_KEY (environment or .env) and is NEVER printed.
 * Without a key the test is SKIPPED (exit 0) so `npm run verify` stays usable offline.
 */
const fs = require('fs');
const path = require('path');
const { env, urls } = require('./lib/ops');
const { getConfig } = require('../lib/config');
const { buildChatRequest, parseChatResponse } = require('../lib/openai');
const intents = require('../lib/intents');
const extraction = require('../lib/extraction');
const { mergeRequirements } = require('../lib/requirements');
const { scorePriority } = require('../lib/priority');
const { todayIn } = require('../lib/dates');
const { MockFareProvider } = require('../lib/providers/mockFareProvider');
const { validateFareOptions } = require('../lib/fares');
const quote = require('../lib/quote');

const MESSAGE = 'Need 3 business seats BOM-LHR 17 Nov return 25 Nov, Qatar preferred, urgent.';
const e = env();
const KEY = (e.OPENAI_API_KEY || '').trim();
const cfg = getConfig(e);
const results = [];

function prompt(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'prompts', file), 'utf8');
  return /<!-- BEGIN SYSTEM PROMPT -->\n([\s\S]*?)\n<!-- END SYSTEM PROMPT -->/.exec(src)[1].trim();
}
function step(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` – ${detail}` : ''}`);
  return ok;
}
async function chat(body) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const json = await r.json().catch(() => ({ error: { message: `HTTP ${r.status} (non-JSON body)` } }));
  return r.ok ? json : { error: { message: `HTTP ${r.status}: ${(json.error && json.error.code) || (json.error && json.error.type) || 'error'}` } };
}

(async () => {
  console.log(`OpenAI smoke test · model=${cfg.OPENAI_MODEL} · key=${KEY && !/^YOUR_/i.test(KEY) ? 'configured (hidden)' : 'missing'}`);
  if (!KEY || /^YOUR_|^change-me/i.test(KEY)) {
    console.log('SKIPPED – set OPENAI_API_KEY in .env (or the environment) to run the real OpenAI checks.');
    process.exit(0);
  }
  const today = todayIn(cfg.BUSINESS_TIMEZONE);

  // 1. connection
  const m = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(cfg.OPENAI_MODEL)}`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(20000) }).catch((err) => ({ ok: false, status: err.name }));
  if (!step('1. connection + model available', m.ok, m.ok ? cfg.OPENAI_MODEL : `HTTP ${m.status} (invalid key, no access to model, or network)`)) return finish();

  // 2. classification
  const clsBody = buildChatRequest({ model: cfg.OPENAI_MODEL, system: prompt('intent-classifier.md'), schemaName: 'intent_classification', schema: intents.CLASSIFICATION_SCHEMA, temperature: cfg.OPENAI_TEMPERATURE, maxTokens: 300,
    user: intents.buildClassifierUserContent({ message: { text: MESSAGE }, channel: 'email', today, timezone: cfg.BUSINESS_TIMEZONE, context: {} }) });
  const clsRaw = parseChatResponse(await chat(clsBody));
  const cls = clsRaw.ok ? intents.validateClassification(clsRaw.data, cfg.AI_CONFIDENCE_THRESHOLD) : null;
  step('2. classification (strict JSON)', Boolean(cls) && cls.intent === 'NEW_QUOTE' && !cls.requires_human, cls ? `${cls.intent} (confidence ${cls.confidence})` : clsRaw.error);

  // 3. extraction
  const exBody = buildChatRequest({ model: cfg.OPENAI_MODEL, system: prompt('travel-extractor.md'), schemaName: 'travel_request', schema: extraction.EXTRACTION_SCHEMA, temperature: cfg.OPENAI_TEMPERATURE, maxTokens: 900,
    user: extraction.buildExtractorUserContent({ message: { text: MESSAGE }, channel: 'email', today, timezone: cfg.BUSINESS_TIMEZONE, context: {} }) });
  const exRaw = parseChatResponse(await chat(exBody));
  if (!step('3. structured extraction (strict JSON schema)', exRaw.ok, exRaw.ok ? 'valid JSON' : exRaw.error)) return finish();
  const { delta, report } = extraction.validateExtraction(exRaw.data, { text: MESSAGE, today, context: {} });
  const dropped = report.filter((x) => x.action === 'dropped').map((x) => x.field);
  const req = mergeRequirements(null, delta).requirements;

  // 4. business validation
  const yr = (iso) => String(iso || '').slice(5);
  step('4a. route BOM → LHR', req.origin && req.origin.iata === 'BOM' && req.destination && req.destination.iata === 'LHR');
  step('4b. 3 adults · BUSINESS', req.passengers.adults === 3 && req.cabin === 'BUSINESS');
  step('4c. dates 17 Nov → 25 Nov (verified against the text)', yr(req.departure_date) === '11-17' && yr(req.return_date) === '11-25', `${req.departure_date} → ${req.return_date}`);
  step('4d. Qatar Airways preferred', req.preferred_airlines.includes('Qatar Airways'));
  step('4e. ready for processing (no missing field)', req.ready_for_processing, req.missing_fields.join(', ') || 'complete');
  step('4f. no hallucinated value dropped by the guards', dropped.length === 0, dropped.length ? `dropped: ${dropped.join(', ')}` : 'all values backed by the message');
  const prio = scorePriority({ requirements: req, agency: { priority_level: 'VIP' }, now: new Date() }, cfg);
  step('4g. priority (Apex Travel = VIP agency)', prio.level === 'HIGH', `${prio.score} ${prio.level}`);

  // 5. quote formatting – numbers must be preserved
  const options = validateFareOptions(MockFareProvider.sampleOptions(req, new Date()), { rfq: { trip_type: req.trip_type, cabin: req.cabin }, now: new Date() }).options;
  const model = quote.buildQuoteModel({ rfq: { rfq_number: 'OFF-RFQ-2026-999999' }, requirements: req, contact: { first_name: 'John' }, options, timeZone: cfg.BUSINESS_TIMEZONE, now: new Date() });
  const qBody = buildChatRequest({ model: cfg.OPENAI_MODEL, system: prompt('quote-formatter.md'), schemaName: 'quote_texts', schema: quote.QUOTE_SCHEMA, temperature: cfg.OPENAI_FORMATTER_TEMPERATURE, maxTokens: 2500,
    user: quote.buildFormatterUserContent(model, 'email') });
  const qRaw = parseChatResponse(await chat(qBody));
  if (qRaw.ok) {
    const v = quote.validateFormattedQuote(qRaw.data, model);
    step('5. AI quote keeps USD 2,450 and every number verbatim', v.ok && qRaw.data.email_body.includes('USD 2,450'), v.ok ? 'accepted' : `rejected → template fallback would be used (${v.errors.slice(0, 2).join('; ')})`);
  } else step('5. AI quote formatting', false, qRaw.error);

  // 6. optional: through the running stack
  if (process.argv.includes('--stack')) {
    const u = urls();
    const c = await fetch(`${u.console}/api/config`).then((r) => r.json()).catch(() => null);
    if (!c || c.ai_provider !== 'openai') step('6. stack pipeline', false, 'stack not running or AI_PROVIDER is not "openai"');
    else {
      const reg = await fetch(`${u.console}/api/demo/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'John Carter <john.carter@apex-travel.example>', subject: 'smoke test', body: MESSAGE }) }).then((r) => r.json());
      let msg = null;
      for (let i = 0; i < 40 && !(msg && msg.processing_status === 'PROCESSED'); i += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        msg = await fetch(`${u.console}/api/message/${reg.results[0].message_id}`).then((r) => r.json());
      }
      const d = msg && msg.rfq_number ? await fetch(`${u.console}/api/rfq/${msg.rfq_number}`).then((r) => r.json()) : null;
      step('6. stack pipeline uses OpenAI (n8n credential)', Boolean(d) && d.rfq.extraction_meta && d.rfq.extraction_meta.source === 'openai', d ? `${d.rfq.rfq_number} · source=${d.rfq.extraction_meta && d.rfq.extraction_meta.source} · ${d.rfq.priority_level}` : 'not processed');
    }
  }
  return finish();
})().catch((err) => {
  console.error(`✖ smoke test crashed: ${String(err.message).split(KEY || ' ').join('[REDACTED]')}`);
  process.exitCode = 1;
});

function finish() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `✖ OpenAI smoke test FAILED (${failed}/${results.length})` : `✔ OpenAI smoke test PASSED (${results.length}/${results.length})`);
  process.exitCode = failed ? 1 : 0; // let pending sockets close (process.exit() crashes libuv on Windows)
}
