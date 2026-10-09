'use strict';
/**
 * Offshore Fares – Ops Console
 *
 * - READ: PostgreSQL through the read-only `ops_console` role (dashboards, queue, RFQ journey).
 * - WRITE: never directly. Every action (fare entry, approval, operator actions, demo
 *   messages) is forwarded to the n8n webhooks, so all business changes go through the
 *   orchestrator, the DB state machine and the audit trail.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const LIB = fs.existsSync(path.join(__dirname, 'lib')) ? path.join(__dirname, 'lib') : path.join(__dirname, '..', 'lib');
const { getConfig } = require(path.join(LIB, 'config'));
const { evaluateSla } = require(path.join(LIB, 'sla'));
const { LABELS } = require(path.join(LIB, 'stateMachine'));
const { MockFareProvider } = require(path.join(LIB, 'providers', 'mockFareProvider'));
const { validateEnvironment, formatReport } = require(path.join(LIB, 'envCheck'));

/** Structured JSON logs (one line per event). Never logs headers, bodies, passwords or tokens. */
function log(level, event, fields) {
  process.stdout.write(`${JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, service: 'ops-console', event }, fields || {}))}\n`);
}

// Fail fast: in production (DEMO_MODE=false) the console refuses to start without authentication and real secrets.
const startupCheck = validateEnvironment(process.env, 'console');
console.log(formatReport(startupCheck, 'console'));
if (!startupCheck.ok) {
  log('fatal', 'config_invalid', { mode: startupCheck.mode, errors: startupCheck.errors.length });
  process.exit(1);
}

const cfg = getConfig(process.env);
const PORT = Number(process.env.PORT || 3000);
const N8N = (process.env.N8N_WEBHOOK_BASE || 'http://localhost:5678/webhook').replace(/\/$/, '');
const N8N_BASE = N8N.replace(/\/webhook$/, '');
const OPS_TOKEN = process.env.OPS_API_TOKEN || '';
// Node tries every resolved address (IPv6 + IPv4) with only 250 ms per attempt by default; remote databases
// (Neon) behind a high-latency link then fail with ETIMEDOUT. Give each attempt a realistic budget.
require('net').setDefaultAutoSelectFamilyAttemptTimeout(2500);
// DATABASE_URL (Neon / Render) or PG* environment variables (local docker stack). SSL comes from sslmode in the URL.
const pool = new Pool(Object.assign({ max: 5, statement_timeout: 10000, connectionTimeoutMillis: 15000 }, process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}));
pool.on('error', (e) => log('error', 'db_pool_error', { message: e.message }));
const PUBLIC = path.join(__dirname, 'public');
const DEMO_DIR = fs.existsSync(path.join(__dirname, 'demo')) ? path.join(__dirname, 'demo') : path.join(__dirname, '..', 'demo');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const q = async (sql, params) => (await pool.query(sql, params || [])).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;

// Same-origin only: no CORS headers are ever sent, so browsers block cross-site API calls.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
};
if (!cfg.DEMO_MODE) SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

/**
 * CSRF protection for write endpoints (Basic auth is sent automatically by browsers):
 * a JSON content type is required (a cross-site form cannot send it without a CORS preflight, which is never allowed)
 * and, when the browser sends an Origin header, it must be this host.
 */
function sameOriginWrite(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // server-to-server clients (tests, scripts)
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('INVALID_JSON')); }
    });
  });
}

function authorized(req) {
  if (!process.env.CONSOLE_USER) return true;
  const header = req.headers.authorization || '';
  const [user, pass] = Buffer.from(header.replace(/^Basic /, ''), 'base64').toString().split(':');
  const a = Buffer.from(`${user}:${pass}`);
  const b = Buffer.from(`${process.env.CONSOLE_USER}:${process.env.CONSOLE_PASSWORD || ''}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function n8n(pathName, payload, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['X-Ops-Token'] = OPS_TOKEN;
  const r = await fetch(`${N8N}/${pathName}`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 500) }; }
  return { status: r.status, body };
}

// ---------------------------------------------------------------------------
// read models
// ---------------------------------------------------------------------------
async function summary() {
  const [today, open, sla, timing, conversion, channels, cabins, routes, agencies, priority, ai, automation] = await Promise.all([
    q(`SELECT status, count(*)::int AS n FROM rfqs WHERE created_at >= date_trunc('day', now()) GROUP BY status`),
    q(`SELECT status, count(*)::int AS n FROM rfqs GROUP BY status`),
    one(`SELECT count(*) FILTER (WHERE sla_breached AND status NOT IN ('CLOSED','CANCELLED','LOST','TICKETED'))::int AS open_breached,
                count(*) FILTER (WHERE sla_breached)::int AS total_breached FROM rfqs`),
    one(`SELECT round(avg(extract(epoch FROM first_response_at - created_at)) FILTER (WHERE first_response_at IS NOT NULL) / 60.0, 1) AS avg_first_response_min,
                round(avg(extract(epoch FROM quoted_at - created_at)) FILTER (WHERE quoted_at IS NOT NULL) / 60.0, 1) AS avg_quote_min
           FROM rfqs WHERE created_at > now() - interval '30 days'`),
    one(`SELECT count(*) FILTER (WHERE quoted_at IS NOT NULL)::int AS quoted,
                count(*) FILTER (WHERE quoted_at IS NOT NULL AND (booking_requested_at IS NOT NULL OR status IN ('BOOKING_REQUESTED','TICKETING','TICKETED')))::int AS booked
           FROM rfqs WHERE created_at > now() - interval '30 days'`),
    q(`SELECT coalesce(source_channel,'unknown') AS k, count(*)::int AS n FROM rfqs GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT coalesce(cabin,'UNKNOWN') AS k, count(*)::int AS n FROM rfqs GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT origin_iata || ' → ' || destination_iata AS k, count(*)::int AS n FROM rfqs WHERE origin_iata IS NOT NULL AND destination_iata IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`),
    q(`SELECT a.name AS k, count(*)::int AS n FROM rfqs r JOIN agencies a ON a.id = r.agency_id GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`),
    q(`SELECT priority_level AS k, count(*)::int AS n FROM rfqs WHERE status NOT IN ('CLOSED','CANCELLED','LOST') GROUP BY 1`),
    q(`SELECT coalesce(extraction_meta->>'source', 'seed') AS k, count(*)::int AS n FROM rfqs GROUP BY 1`),
    one(`SELECT count(*) FILTER (WHERE direction = 'INBOUND' AND created_at > now() - interval '24 hours')::int AS inbound_24h,
                count(*) FILTER (WHERE direction = 'OUTBOUND' AND created_at > now() - interval '24 hours')::int AS outbound_24h,
                count(*) FILTER (WHERE processing_status = 'DEAD_LETTER')::int AS dead_letters
           FROM messages`),
  ]);
  const byStatus = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    generated_at: new Date().toISOString(),
    demo_mode: cfg.DEMO_MODE,
    require_human_approval: cfg.REQUIRE_HUMAN_APPROVAL,
    ai_provider: cfg.AI_PROVIDER,
    model: cfg.OPENAI_MODEL,
    today_total: today.reduce((s, r) => s + r.n, 0),
    today_by_status: byStatus(today),
    current_by_status: byStatus(open),
    sla,
    timing,
    conversion: Object.assign({}, conversion, { rate: conversion.quoted ? Math.round((conversion.booked / conversion.quoted) * 1000) / 10 : null }),
    by_channel: channels,
    by_cabin: cabins,
    by_route: routes,
    by_agency: agencies,
    by_priority: priority,
    extraction_sources: ai,
    automation,
  };
}

async function queue() {
  const rows = await q(`
    SELECT r.id, r.rfq_number, a.name AS agency, trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS agent,
           r.origin_iata, r.destination_iata, r.departure_date, r.return_date, r.cabin,
           coalesce(r.adults,0) + r.children + r.infants AS pax, r.priority_level, r.priority_score, r.status, r.status_changed_at,
           d.name AS desk, o.full_name AS operator, r.sla_breached, r.source_channel, r.requires_human, r.intent, r.created_at,
           (SELECT count(*) FROM alerts al WHERE al.rfq_id = r.id AND al.status = 'OPEN')::int AS open_alerts
      FROM rfqs r
      LEFT JOIN agencies a ON a.id = r.agency_id
      LEFT JOIN contacts c ON c.id = r.contact_id
      LEFT JOIN desks d ON d.code = r.assigned_team
      LEFT JOIN operators o ON o.id = r.assigned_user
     WHERE r.status NOT IN ('CLOSED','CANCELLED','LOST')
     ORDER BY CASE r.priority_level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, r.status_changed_at`);
  const now = new Date();
  return rows.map((r) => {
    const s = evaluateSla(r, now, cfg);
    return Object.assign(r, {
      status_label: LABELS[r.status] || r.status,
      waiting_seconds: Math.max(0, Math.round((now - new Date(r.status_changed_at)) / 1000)),
      sla: s.tracked ? (s.breached ? 'BREACHED' : s.minutes_in_status >= s.threshold_minutes * 0.75 ? 'AT_RISK' : 'OK') : 'N/A',
      sla_threshold_minutes: s.threshold_minutes || null,
    });
  });
}

// Client-facing journey (labels of the demo story). A label can be computed from the matching audit row.
const JOURNEY = [
  ['MESSAGE RECEIVED', (a) => a.action === 'MESSAGE_RECEIVED' || a.action === 'RFQ_CREATED'],
  ['AI CLASSIFIED', (a) => a.action === 'AI_CLASSIFIED'],
  ['AI EXTRACTED', (a) => a.action === 'REQUIREMENTS_EXTRACTED'],
  ['RFQ CREATED', (a) => a.action === 'RFQ_CREATED'],
  ['PRIORITY CALCULATED', (a) => a.action === 'PRIORITY_CALCULATED'],
  ['FARE DESK ASSIGNED', (a) => a.action === 'ASSIGNED' && a.metadata && a.metadata.desk !== 'TICKETING_DESK'],
  ['FARES ENTERED', (a) => a.action === 'FARES_ADDED'],
  ['QUOTE GENERATED', (a) => a.action === 'QUOTE_GENERATED'],
  ['WAITING FOR APPROVAL', (a) => a.action === 'STATUS_CHANGED' && a.metadata && a.metadata.to === 'PENDING_APPROVAL'],
  ['APPROVED', (a) => a.action === 'QUOTE_APPROVED'],
  ['QUOTE SENT', (a) => a.action === 'QUOTE_SENT'],
  [(a) => (a && a.metadata.selected_option ? `CLIENT SELECTED OPTION ${Number(String(a.metadata.selected_option).replace('OPT-', ''))}` : 'CLIENT SELECTED OPTION'), (a) => a.action === 'BOOKING_REQUESTED'],
  ['BOOKING REQUESTED', (a) => a.action === 'BOOKING_REQUESTED'],
  ['TICKETING NOTIFIED', (a) => a.action === 'ASSIGNED' && a.metadata && a.metadata.desk === 'TICKETING_DESK'],
];

async function rfqDetail(number) {
  const rfq = await one(`
    SELECT r.*, a.name AS agency_name, a.priority_level AS agency_priority, c.first_name, c.last_name, c.email AS contact_email,
           c.whatsapp_phone AS contact_whatsapp, c.verification_status, d.name AS desk_name, o.full_name AS operator_name,
           so.option_code AS selected_option_code, cv.channel AS conversation_channel, cv.external_thread_id AS conversation_thread
      FROM rfqs r LEFT JOIN agencies a ON a.id = r.agency_id LEFT JOIN contacts c ON c.id = r.contact_id
      LEFT JOIN conversations cv ON cv.id = r.conversation_id
      LEFT JOIN desks d ON d.code = r.assigned_team LEFT JOIN operators o ON o.id = r.assigned_user
      LEFT JOIN fare_options so ON so.id = r.selected_option_id
     WHERE r.rfq_number = $1`, [number]);
  if (!rfq) return null;
  const [messages, options, quotes, approvals, history, audit, alerts, followups] = await Promise.all([
    q(`SELECT id, channel, direction, kind, sender, recipient, subject, content, processing_status, delivery_status, security_flags, classification,
              coalesce(received_at, sent_at, created_at) AS at FROM messages WHERE rfq_id = $1 ORDER BY coalesce(received_at, sent_at, created_at)`, [rfq.id]),
    q(`SELECT * FROM fare_options WHERE rfq_id = $1 ORDER BY batch_no DESC, option_no`, [rfq.id]),
    q(`SELECT id, version, status, email_subject, email_body, whatsapp_body, generated_by, ai_model, validation, valid_until, approved_by, approved_at, sent_at, delivery_channel, content_hash, created_at
         FROM quotes WHERE rfq_id = $1 ORDER BY version DESC`, [rfq.id]),
    q(`SELECT quote_version, action, approval_status, approved_by, approved_at, approval_note, content_hash FROM approvals WHERE rfq_id = $1 ORDER BY approved_at`, [rfq.id]),
    q(`SELECT from_status, to_status, actor_type, actor_id, reason, created_at FROM rfq_status_history WHERE rfq_id = $1 ORDER BY id`, [rfq.id]),
    q(`SELECT action, actor_type, actor_id, metadata, created_at FROM audit_logs
        WHERE rfq_id = $1 OR (entity_type = 'message' AND entity_id IN (SELECT id::text FROM messages WHERE rfq_id = $1))
        ORDER BY created_at, id`, [rfq.id]),
    q(`SELECT id, alert_type, severity, desk_code, title, details, status, created_at FROM alerts WHERE rfq_id = $1 ORDER BY created_at DESC`, [rfq.id]),
    q(`SELECT sequence_no, status, channel, quote_expired, sent_at FROM followups WHERE rfq_id = $1 ORDER BY sent_at`, [rfq.id]),
  ]);
  const journey = JOURNEY.map(([label, match]) => {
    const hit = audit.find(match);
    return { label: typeof label === 'function' ? label(hit) : label, done: Boolean(hit), at: hit ? hit.created_at : null };
  });
  const sla = evaluateSla(rfq, new Date(), cfg);
  return { rfq: Object.assign(rfq, { status_label: LABELS[rfq.status] }), sla, journey, messages, options, quotes, approvals, history, audit, alerts, followups };
}

const alerts = () => q(`
  SELECT al.id, al.alert_type, al.severity, al.desk_code, d.name AS desk, al.title, al.details, al.status, al.created_at, r.rfq_number
    FROM alerts al LEFT JOIN rfqs r ON r.id = al.rfq_id LEFT JOIN desks d ON d.code = al.desk_code
   WHERE al.status <> 'RESOLVED' ORDER BY CASE al.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, al.created_at DESC LIMIT 100`);

const outbox = () => q(`
  SELECT m.id, m.channel, m.kind, m.recipient, m.subject, m.content, m.delivery_status, m.sent_at, r.rfq_number
    FROM messages m LEFT JOIN rfqs r ON r.id = m.rfq_id WHERE m.direction = 'OUTBOUND' ORDER BY m.created_at DESC LIMIT 40`);

const events = () => q(`
  SELECT e.workflow, e.event, e.status, e.duration_ms, e.details, e.created_at, r.rfq_number
    FROM workflow_events e LEFT JOIN rfqs r ON r.id = e.rfq_id ORDER BY e.id DESC LIMIT 60`);

const deadLetters = () => q(`
  SELECT m.id, m.channel, m.sender, left(m.content, 200) AS content, m.processing_status, m.retry_count, m.processing_notes, m.created_at
    FROM messages m WHERE m.processing_status IN ('FAILED','DEAD_LETTER') ORDER BY m.created_at DESC LIMIT 50`);

const contacts = () => q(`
  SELECT c.first_name, c.last_name, c.email, c.whatsapp_phone, a.name AS agency, a.priority_level
    FROM contacts c LEFT JOIN agencies a ON a.id = c.agency_id WHERE c.is_demo ORDER BY a.name, c.first_name`);

// ---------------------------------------------------------------------------
// demo simulator payload builders
// ---------------------------------------------------------------------------
function demoEmail(body) {
  return {
    message_id: body.message_id || `demo-${crypto.randomUUID()}`,
    thread_id: body.thread_id || `demo-thread-${crypto.randomUUID()}`,
    from: body.from,
    subject: body.subject || '',
    body: body.body || '',
    received_at: new Date().toISOString(),
  };
}

function demoWhatsApp(body) {
  const phone = String(body.from || '').replace(/\D/g, '');
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'DEMO_WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: 'DEMO_PHONE_NUMBER_ID' },
      contacts: [{ profile: { name: body.name || 'Demo Agent' }, wa_id: phone }],
      messages: [{ from: phone, id: body.message_id || `wamid.DEMO.${crypto.randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: body.text || '' } }],
    } }] }],
  };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // Liveness: process up + database reachable. OpenAI is deliberately NOT part of health checks.
  if (p === '/health' || p === '/api/health') {
    try { return send(res, 200, { status: 'ok', db: (await one('SELECT 1 AS ok')).ok === 1, mode: cfg.DEMO_MODE ? 'demo' : 'production' }); } catch (e) { return send(res, 503, { status: 'down', db: false }); }
  }
  // Readiness: database + n8n reachable (the console cannot perform actions without n8n).
  if (p === '/ready') {
    const checks = { db: false, n8n: false };
    try { checks.db = (await one('SELECT 1 AS ok')).ok === 1; } catch (_) { /* not ready */ }
    try { checks.n8n = (await fetch(`${N8N_BASE}/healthz/readiness`, { signal: AbortSignal.timeout(3000) })).ok; } catch (_) { /* not ready */ }
    const ready = checks.db && checks.n8n;
    return send(res, ready ? 200 : 503, Object.assign({ status: ready ? 'ready' : 'not_ready' }, checks));
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Offshore Fares Ops"' });
    return res.end('Authentication required');
  }
  try {
    if (req.method === 'GET') {
      if (p === '/api/summary') return send(res, 200, await summary());
      if (p === '/api/queue') return send(res, 200, await queue());
      if (p === '/api/alerts') return send(res, 200, await alerts());
      if (p === '/api/outbox') return send(res, 200, await outbox());
      if (p === '/api/events') return send(res, 200, await events());
      if (p === '/api/dead-letters') return send(res, 200, await deadLetters());
      if (p === '/api/contacts') return send(res, 200, await contacts());
      if (p === '/api/config') return send(res, 200, { demo_mode: cfg.DEMO_MODE, require_human_approval: cfg.REQUIRE_HUMAN_APPROVAL, ai_provider: cfg.AI_PROVIDER, model: cfg.OPENAI_MODEL, timezone: cfg.BUSINESS_TIMEZONE });
      if (p === '/api/demo/scenarios') {
        const read = (f) => JSON.parse(fs.readFileSync(path.join(DEMO_DIR, f), 'utf8'));
        return send(res, 200, { emails: read('sample-emails.json'), whatsapp: read('sample-whatsapp.json'), fares: read('sample-fares.json') });
      }
      const mm = /^\/api\/message\/([0-9a-f-]{36})$/.exec(p);
      if (mm || (p === '/api/message' && url.searchParams.get('external_id'))) {
        const msg = await one(`SELECT m.id, m.processing_status, m.processing_notes, m.classification, r.rfq_number, r.status AS rfq_status
                                 FROM messages m LEFT JOIN rfqs r ON r.id = m.rfq_id
                                WHERE ${mm ? 'm.id = $1' : "m.external_message_id = $1 AND m.direction = 'INBOUND'"}`, [mm ? mm[1] : url.searchParams.get('external_id')]);
        return msg ? send(res, 200, msg) : send(res, 404, { error: 'MESSAGE_NOT_FOUND' });
      }
      const m = /^\/api\/rfq\/(OFF-RFQ-\d{4}-\d{6})$/.exec(p);
      if (m) {
        const d = await rfqDetail(m[1]);
        return d ? send(res, 200, d) : send(res, 404, { error: 'RFQ_NOT_FOUND' });
      }
      const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    }
    if (req.method === 'POST') {
      if (!sameOriginWrite(req)) return send(res, 403, { error: 'CROSS_ORIGIN_OR_NON_JSON_WRITE_REJECTED' });
      const body = await readBody(req);
      if (p === '/api/demo/email') {
        if (!cfg.DEMO_MODE) return send(res, 403, { error: 'DEMO_MODE_DISABLED' });
        const r = await n8n('demo/email', demoEmail(body));
        return send(res, r.status, r.body);
      }
      if (p === '/api/demo/whatsapp') {
        if (!cfg.DEMO_MODE) return send(res, 403, { error: 'DEMO_MODE_DISABLED' });
        const payload = demoWhatsApp(body);
        const r = await n8n('whatsapp', payload, { auth: false });
        return send(res, r.status, Object.assign({}, r.body, { external_message_id: payload.entry[0].changes[0].value.messages[0].id }));
      }
      if (p === '/api/fare-desk/mock') {
        if (!cfg.DEMO_MODE) return send(res, 403, { error: 'MOCK_PROVIDER_DISABLED (DEMO_MODE=false)' });
        // Same MockFareProvider as WF16 (pre-fills the form; the operator still submits).
        const rfq = await one('SELECT requirements FROM rfqs WHERE rfq_number = $1', [body.rfq_number]);
        if (!rfq) return send(res, 404, { error: 'RFQ_NOT_FOUND' });
        return send(res, 200, { provider: 'MockFareProvider', disclaimer: 'DEMO sample data – not real fares', options: MockFareProvider.sampleOptions(rfq.requirements, new Date()) });
      }
      const forward = { '/api/fare-desk/options': 'fare-desk/options', '/api/quote/decision': 'quote/decision', '/api/ops/action': 'ops/action', '/api/ops/run-followups': 'ops/run-followups', '/api/ops/run-sla': 'ops/run-sla' };
      if (forward[p]) {
        const r = await n8n(forward[p], body);
        return send(res, r.status, r.body);
      }
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    const clientError = ['INVALID_JSON', 'BODY_TOO_LARGE'].includes(e.message);
    log('error', 'request_failed', { method: req.method, path: p, message: e.message });
    return send(res, clientError ? 400 : 500, { error: clientError ? e.message : 'INTERNAL_ERROR' });
  }
}

http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    const p = req.url.split('?')[0];
    if ((p.startsWith('/api/') && req.method === 'GET' && res.statusCode < 400) || p === '/health' || p === '/ready') return; // polling noise
    log(res.statusCode >= 500 ? 'error' : 'info', 'http_request', { method: req.method, path: p.replace(/OFF-RFQ-\d{4}-\d{6}/, ':rfq'), status: res.statusCode, duration_ms: Date.now() - started });
  });
  handle(req, res);
}).listen(PORT, () => log('info', 'listening', { port: PORT, n8n: N8N, mode: cfg.DEMO_MODE ? 'demo' : 'production', auth: Boolean(process.env.CONSOLE_USER) }));
