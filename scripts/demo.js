#!/usr/bin/env node
'use strict';
/**
 * npm run demo – the client demo story in one command.
 *
 *   1. starts the stack if needed and waits until it is ready
 *   2. restores the demo data (npm run demo:reset)
 *   3. plays the Apex Travel / John Carter story through the REAL workflows
 *      (email → AI → RFQ → priority → desk → fares → quote → approval → sent →
 *       "Option 2 looks good" → booking requested → ticketing notified)
 *   4. prints every milestone and the console link to show the journey on screen
 *
 * Options: --step (pause before each step – live presentation) · --no-reset
 */
const readline = require('readline');
const { env, compose, run, urls, waitStackReady, banner } = require('./lib/ops');

const STEP = process.argv.includes('--step');
const U = urls();
const NOW = new Date();
const YEAR = NOW < new Date(Date.UTC(NOW.getUTCFullYear(), 10, 10)) ? NOW.getUTCFullYear() : NOW.getUTCFullYear() + 1;
const JOHN = 'John Carter <john.carter@apex-travel.example>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const e = env();
  const headers = { 'Content-Type': 'application/json' };
  if (e.CONSOLE_USER) headers.Authorization = `Basic ${Buffer.from(`${e.CONSOLE_USER}:${e.CONSOLE_PASSWORD || ''}`).toString('base64')}`;
  const r = await fetch(`${U.console}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → HTTP ${r.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}
async function until(label, fn, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timeout: ${label}`);
}
async function pause(next) {
  if (!STEP) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question(`\n  ⏎  ${next}`, () => { rl.close(); r(); }));
}
const ok = (label, detail) => console.log(`  ✔ ${label.padEnd(26)} ${detail || ''}`);

(async () => {
  banner('Offshore Fares – client demo (Apex Travel · John Carter)');
  if (String(env().DEMO_MODE || 'true').toLowerCase() === 'false') throw new Error('npm run demo requires DEMO_MODE=true');
  const ps = compose(['ps', '--status', 'running', '--services'], { stdio: 'pipe' });
  if (!/n8n/.test(ps.stdout || '')) {
    console.log('Starting the stack (first start imports the workflows, ~6-9 min)…');
    if (compose(['up', '-d', '--build']).status !== 0) process.exit(1);
  }
  await waitStackReady(900000);
  if (!process.argv.includes('--no-reset')) run(process.execPath, ['scripts/demo-reset.js']);

  console.log(`\n  Ops console: ${U.console}   ·   n8n: ${U.n8n}\n`);
  await pause('Send John Carter\'s email');
  const thread = `demo-story-${Date.now()}`;
  const body = `Hi team,\n\nNeed 3 business class seats from Mumbai to London.\n\nDeparture 17 November ${YEAR}, return 25 November.\n\nQatar preferred but open to Emirates.\n\nPlease send best fare urgently.\n\nBest regards,\nJohn Carter\nApex Travel`;
  const reg = await api('POST', '/api/demo/email', { from: JOHN, subject: 'Business class BOM-LHR x3 – urgent', body, thread_id: thread });
  ok('MESSAGE RECEIVED', 'email from John Carter (Apex Travel, VIP)');
  const msg = await until('processing', async () => { const m = await api('GET', `/api/message/${reg.results[0].message_id}`); return m.processing_status === 'PROCESSED' && m.rfq_number ? m : null; });
  let d = await until('assignment', async () => { const x = await api('GET', `/api/rfq/${msg.rfq_number}`); return x.rfq.status === 'ASSIGNED' ? x : null; });
  const r = d.rfq;
  ok('AI CLASSIFIED', `${msg.classification.intent} (confidence ${msg.classification.confidence}, ${msg.classification.source})`);
  ok('AI EXTRACTED', `${r.origin_iata} → ${r.destination_iata} · ${r.trip_type} · ${r.adults} adults · ${r.cabin} · ${r.requirements.departure_date} → ${r.requirements.return_date} · ${r.preferred_airlines.join(' + ')}`);
  ok('RFQ CREATED', r.rfq_number);
  ok('PRIORITY CALCULATED', `${r.priority_level} (${r.priority_score}: ${(r.priority_breakdown || []).map((b) => `${b.rule} +${b.points}`).join(', ')})`);
  ok('FARE DESK ASSIGNED', `${r.desk_name} · ${r.operator_name}`);

  await pause('Fare desk enters 3 options');
  const mock = await api('POST', '/api/fare-desk/mock', { rfq_number: r.rfq_number });
  const fares = await api('POST', '/api/fare-desk/options', { rfq_number: r.rfq_number, entered_by: 'Aisha Khan', options: mock.options });
  ok('FARES ENTERED', mock.options.map((o, i) => `${i + 1}) ${o.airline} ${o.fare.currency} ${o.fare.amount.toLocaleString('en-US')}`).join(' · '));
  ok('QUOTE GENERATED', `v${fares.quote.version} · ${fares.quote.generated_by === 'AI' ? 'formatted by AI, numbers verified' : 'template'}`);
  ok('WAITING FOR APPROVAL', 'nothing is sent before a human approves');

  await pause('Approve the quote');
  d = await api('GET', `/api/rfq/${r.rfq_number}`);
  const approval = await api('POST', '/api/quote/decision', { quote_id: d.quotes[0].id, action: 'APPROVE', reviewer: 'Aisha Khan', note: 'Checked' });
  ok('APPROVED', 'by Aisha Khan (who / when / content hash stored)');
  ok('QUOTE SENT', `${approval.delivery.channel} · ${approval.delivery.delivery_status} · same thread as John's email`);

  await pause('John replies "Option 2 looks good, please proceed."');
  const reply = await api('POST', '/api/demo/email', { from: JOHN, subject: `Re: ${r.rfq_number}`, body: 'Option 2 looks good, please proceed.\n\nJohn', thread_id: thread });
  await until('reply processed', async () => (await api('GET', `/api/message/${reply.results[0].message_id}`)).processing_status === 'PROCESSED');
  d = await until('booking', async () => { const x = await api('GET', `/api/rfq/${r.rfq_number}`); return x.rfq.status === 'BOOKING_REQUESTED' && x.rfq.assigned_team === 'TICKETING_DESK' ? x : null; });
  ok('CLIENT SELECTED OPTION 2', `${d.rfq.selected_option_code} · ${d.rfq.handoff.selected_option.airline}`);
  ok('BOOKING REQUESTED', 'no ticket is issued automatically');
  ok('TICKETING NOTIFIED', `${d.rfq.desk_name} · ${d.rfq.operator_name} (handoff summary ready)`);

  console.log(`\n  Journey: ${d.journey.filter((j) => j.done).map((j) => j.label).join(' → ')}`);
  console.log(`\n  Open the RFQ in the console: ${U.console}/#/rfq/${r.rfq_number}\n`);
})().catch((e) => {
  console.error(`\n✖ demo failed: ${e.message}\n  Check: npm run verify -- --quick, docker compose ps, docker compose logs n8n`);
  process.exitCode = 1;
});
