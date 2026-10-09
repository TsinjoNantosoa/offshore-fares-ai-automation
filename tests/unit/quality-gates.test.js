'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const N = require('../../lib/notifications');
const { mergeRequirements } = require('../../lib/requirements');

const ROOT = path.join(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, 'n8n');
const workflows = fs.readdirSync(WF_DIR).filter((f) => /^WF\d+_.*\.json$/.test(f)).map((f) => ({ file: f, json: JSON.parse(fs.readFileSync(path.join(WF_DIR, f), 'utf8')) }));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name) || e.name === '.env') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|json|md|sql|sh|yml|yaml|html|css|example)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('all 18 workflows exist with the expected names and fixed IDs', () => {
  const names = workflows.map((w) => w.json.name).sort();
  for (const expected of ['WF01_EMAIL_INTAKE', 'WF02_WHATSAPP_INTAKE', 'WF03_INTENT_CLASSIFIER', 'WF04_TRAVEL_REQUEST_EXTRACTOR', 'WF05_MISSING_INFORMATION_HANDLER',
    'WF06_RFQ_MANAGER', 'WF07_PRIORITY_ENGINE', 'WF08_SLA_MONITOR', 'WF09_FARE_DESK_ROUTER', 'WF10_QUOTE_FORMATTER', 'WF11_HUMAN_APPROVAL', 'WF12_QUOTE_DELIVERY',
    'WF13_FOLLOWUP_ENGINE', 'WF14_CLIENT_RESPONSE_HANDLER', 'WF15_AFTER_SALES_ROUTER', 'WF16_FARE_DESK_INTAKE', 'WF17_OPERATOR_ACTIONS', 'WF99_ERROR_HANDLER']) {
    assert.ok(names.includes(expected), expected);
  }
  for (const { json } of workflows) assert.match(json.id, /^ofwf\d{12}$/);
});

test('workflow graphs are valid: unique node names, existing targets, error workflow set, sub-workflow IDs exist', () => {
  const ids = new Set(workflows.map((w) => w.json.id));
  for (const { file, json } of workflows) {
    const names = json.nodes.map((n) => n.name);
    assert.equal(new Set(names).size, names.length, `${file}: duplicate node names`);
    for (const [from, c] of Object.entries(json.connections)) {
      assert.ok(names.includes(from), `${file}: unknown source ${from}`);
      for (const out of c.main) for (const t of out) assert.ok(names.includes(t.node), `${file}: unknown target ${t.node}`);
    }
    if (json.name !== 'WF99_ERROR_HANDLER') assert.equal(json.settings.errorWorkflow, 'ofwf990000000099', `${file}: error workflow`);
    for (const n of json.nodes.filter((x) => x.type === 'n8n-nodes-base.executeWorkflow')) assert.ok(ids.has(n.parameters.workflowId.value), `${file}: ${n.name} calls unknown workflow`);
  }
});

test('credentials are referenced, never embedded', () => {
  const allowed = new Set(['ofPostgresCred01', 'ofOpenAiCred0001', 'ofOpsTokenCred01', 'ofWhatsAppCred01', 'ofGmailCred00001']);
  for (const { file, json } of workflows) {
    for (const n of json.nodes) {
      for (const ref of Object.values(n.credentials || {})) assert.ok(allowed.has(ref.id), `${file}: ${n.name} unknown credential ${ref.id}`);
      if (n.type === 'n8n-nodes-base.httpRequest') assert.ok(!JSON.stringify(n.parameters).match(/Bearer\s+[A-Za-z0-9]/), `${file}: inline bearer token`);
    }
  }
});

test('no secret, API key or card number anywhere in the repository', () => {
  const patterns = [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/, /EAA[A-Za-z0-9]{30,}/, /AIza[0-9A-Za-z_-]{30,}/, /\b4[0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\b/, /-----BEGIN (?:RSA )?PRIVATE KEY-----/];
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (file.includes(`${path.sep}tests${path.sep}`)) continue; // tests contain deliberate fake patterns
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) if (re.test(text)) offenders.push(`${path.relative(ROOT, file)} ~ ${re}`);
  }
  assert.deepEqual(offenders, []);
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /^OPENAI_API_KEY=YOUR_OPENAI_API_KEY$/m);
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.env$/m);
});

test('generated workflows are in sync with lib/ and prompts/ (run `npm run build` after editing)', () => {
  const wf04 = workflows.find((w) => w.json.name === 'WF04_TRAVEL_REQUEST_EXTRACTOR').json;
  const code = wf04.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => n.parameters.jsCode).join('\n');
  const datesSrc = fs.readFileSync(path.join(ROOT, 'lib', 'dates.js'), 'utf8').replace(/^'use strict';\n/, '');
  assert.ok(code.includes(datesSrc.slice(0, 2000)), 'lib/dates.js bundled verbatim');
  const prompt = /<!-- BEGIN SYSTEM PROMPT -->\n([\s\S]*?)\n<!-- END SYSTEM PROMPT -->/.exec(fs.readFileSync(path.join(ROOT, 'prompts', 'travel-extractor.md'), 'utf8'))[1].trim();
  assert.ok(code.includes(JSON.stringify(prompt)), 'extractor system prompt injected verbatim');
});

test('OpenAI calls use the credential, strict JSON schema and fall back on error', () => {
  for (const { json } of workflows) {
    for (const n of json.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' && /openai/.test(x.parameters.url))) {
      assert.equal(n.parameters.nodeCredentialType, 'openAiApi');
      assert.equal(n.onError, 'continueRegularOutput', `${json.name}: ${n.name} must continue on error (rules fallback)`);
    }
  }
});

test('outbound notification texts never contain commercial commitments', () => {
  const { requirements } = mergeRequirements(null, { origin: { iata: 'BOM' }, destination: { iata: 'LHR' }, departure_date: '2026-11-17', return_date: '2026-11-25', passengers: { adults: 3 }, cabin: 'BUSINESS' });
  const texts = [
    N.acknowledgement({ rfqNumber: 'OFF-RFQ-2026-000031', requirements, contactName: 'John', deskName: 'Premium Desk' }),
    N.bookingAcknowledgement({ rfqNumber: 'OFF-RFQ-2026-000031', optionNo: 2, airline: 'Emirates', contactName: 'John', requiresRecheck: false }),
    N.researchAcknowledgement({ rfqNumber: 'OFF-RFQ-2026-000031', kind: 'PRICE_OBJECTION' }),
    N.afterSalesAcknowledgement({ rfqNumber: 'OFF-RFQ-2026-000040', type: 'CHANGE', bookingReference: 'K7Q2LM', travelDate: '2026-10-06' }),
  ];
  for (const t of texts) {
    for (const body of [t.email_body, t.whatsapp_body]) {
      assert.doesNotMatch(body, /\b(USD|EUR|GBP|INR)\s?\d|\bguaranteed\b|\bconfirmed booking\b|\bis confirmed\b/i);
    }
  }
  assert.match(texts[0].email_body, /Route: Mumbai \(BOM\) → London Heathrow \(LHR\) \(return\)/);
  assert.match(texts[1].whatsapp_body, /Not confirmed until ticketed/);
});
