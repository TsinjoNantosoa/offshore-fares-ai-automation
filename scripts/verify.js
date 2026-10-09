#!/usr/bin/env node
'use strict';
/**
 * npm run verify – master verification. Prints a PASS / FAIL table at the end.
 *
 *   1. lint (syntax check of every JS file)      6. stack health (postgres, n8n, console)
 *   2. build (n8n workflows from lib/ + prompts)  7. deployed workflows == repository (18 active)
 *   3. configuration (.env rules)                 8. database tests (SQL API, rolled back)
 *   4. security scan (no exposed secrets)         9. demo reset → E2E → demo reset → E2E
 *   5. unit tests                                10. OpenAI smoke test (SKIP without a key)
 *
 * Options: --quick (steps 1-5, no Docker) · --once (single E2E round) · --no-e2e
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, run, compose, urls, waitStackReady, banner } = require('./lib/ops');

const args = new Set(process.argv.slice(2));
const QUICK = args.has('--quick');
const steps = [];

function record(name, status, detail) {
  steps.push({ name, status, detail: detail || '' });
  console.log(`\n${status === 'PASS' ? '✔' : status === 'SKIP' ? '○' : '✖'} ${name}: ${status}${detail ? ` – ${detail}` : ''}`);
  return status === 'PASS';
}

function node(script, extraArgs, opts) {
  return run(process.execPath, [script].concat(extraArgs || []), opts);
}

function jsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'n8n'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

function hashWorkflows() {
  const dir = path.join(ROOT, 'n8n');
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

/** Compare the workflows deployed in n8n with n8n/*.json (node names + parameters). */
function deployedWorkflows() {
  const sql = "SELECT json_agg(json_build_object('id', id, 'active', active, 'nodes', nodes)) FROM workflow_entity WHERE id LIKE 'ofwf%'";
  const r = compose(['exec', '-T', 'postgres', 'sh', '-c', `psql -At -U "$POSTGRES_USER" -d n8n -c "${sql}"`], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, detail: 'cannot read the n8n database' };
  const deployed = JSON.parse(r.stdout.trim() || '[]') || [];
  const sig = (nodes) => crypto.createHash('sha256').update(JSON.stringify(nodes.map((n) => [n.name, n.type, n.typeVersion, n.parameters, n.disabled || false]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
  const files = fs.readdirSync(path.join(ROOT, 'n8n')).filter((x) => /^WF\d+_.*\.json$/.test(x));
  const issues = [];
  for (const f of files) {
    const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n', f), 'utf8'));
    const d = deployed.find((x) => x.id === wf.id);
    if (!d) issues.push(`${wf.name} not imported`);
    else if (!d.active) issues.push(`${wf.name} not published`);
    else if (sig(d.nodes) !== sig(wf.nodes)) issues.push(`${wf.name} differs from the repository`);
  }
  return issues.length
    ? { ok: false, detail: `${issues.slice(0, 4).join('; ')}${issues.length > 4 ? '…' : ''} – run "npm run workflows:reimport"` }
    : { ok: true, detail: `${files.length}/${files.length} workflows active and identical to n8n/*.json` };
}

function e2eRound(label) {
  const before = new Set(fs.existsSync(path.join(ROOT, 'tests/e2e/reports')) ? fs.readdirSync(path.join(ROOT, 'tests/e2e/reports')) : []);
  const r = node('tests/e2e/run-scenarios.js');
  const after = fs.readdirSync(path.join(ROOT, 'tests/e2e/reports')).filter((f) => !before.has(f));
  const report = after.length ? JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/e2e/reports', after[0]), 'utf8')) : null;
  return record(label, r.status === 0 ? 'PASS' : 'FAIL', report ? `${report.passed}/${report.total} scenarios (${report.run})` : 'no report');
}

async function main() {
  banner(`Offshore Fares – verification${QUICK ? ' (quick)' : ''}`);

  // 1. lint
  const files = jsFiles();
  const bad = files.filter((f) => run(process.execPath, ['--check', f], { stdio: 'pipe' }).status !== 0);
  record('Lint (syntax of every JS file)', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.map((f) => path.relative(ROOT, f)).join(', ') : `${files.length} files`);

  // 2. build
  const h0 = hashWorkflows();
  const b = node('scripts/build-workflows.js', [], { stdio: 'pipe' });
  record('Build (n8n workflows from lib/ + prompts/)', b.status === 0 ? 'PASS' : 'FAIL', b.status === 0 ? (hashWorkflows() === h0 ? '18 workflows, already up to date' : '18 workflows regenerated – re-import them') : String(b.stderr).slice(0, 300));

  // 3-5
  record('Configuration (.env)', node('scripts/check-config.js', [], { stdio: 'pipe' }).status === 0 ? 'PASS' : 'FAIL', 'see npm run config:check');
  const scan = node('scripts/security-scan.js', [], { stdio: 'pipe' });
  record('Security scan', scan.status === 0 ? 'PASS' : 'FAIL', scan.status === 0 ? 'NO EXPOSED SECRETS' : String(scan.stdout).split('\n').filter((l) => l.includes('✖')).join(' | '));
  const unitFiles = fs.readdirSync(path.join(ROOT, 'tests/unit')).filter((f) => f.endsWith('.test.js')).map((f) => `tests/unit/${f}`);
  const unit = run(process.execPath, ['--test', '--test-reporter=spec'].concat(unitFiles), { stdio: 'pipe' });
  const pass = /ℹ pass (\d+)/.exec(unit.stdout);
  const fail = /ℹ fail (\d+)/.exec(unit.stdout);
  record('Unit tests', unit.status === 0 ? 'PASS' : 'FAIL', pass ? `${pass[1]} passed, ${fail ? fail[1] : 0} failed` : String(unit.stdout).slice(-400));

  if (QUICK) return;

  // 6. stack health
  const u = urls();
  try {
    await waitStackReady(180000);
    const ps = compose(['ps', '--format', '{{.Service}} {{.Health}}'], { stdio: 'pipe' }).stdout.trim().split('\n');
    const unhealthy = ['postgres', 'n8n', 'ops-console'].filter((svc) => !ps.some((l) => l.trim() === `${svc} healthy`)).map((svc) => `${svc} not healthy`);
    record('Stack health (postgres, n8n, ops console)', unhealthy.length ? 'FAIL' : 'PASS', unhealthy.length ? unhealthy.join(', ') : `${u.console}/ready = ready`);
  } catch (e) {
    record('Stack health (postgres, n8n, ops console)', 'FAIL', `${e.message} – start it with "npm run stack:up"`);
    return;
  }

  // 7. workflows deployed
  const wf = deployedWorkflows();
  record('Workflow validation (deployed = repository)', wf.ok ? 'PASS' : 'FAIL', wf.detail);

  // 8. SQL
  record('Database tests (SQL API)', node('scripts/test-sql.js', [], { stdio: 'pipe' }).status === 0 ? 'PASS' : 'FAIL');

  // 9. E2E ×2 with resets
  if (!args.has('--no-e2e')) {
    record('Demo reset #1', node('scripts/demo-reset.js').status === 0 ? 'PASS' : 'FAIL');
    e2eRound('E2E round 1');
    if (!args.has('--once')) {
      record('Demo reset #2', node('scripts/demo-reset.js').status === 0 ? 'PASS' : 'FAIL');
      e2eRound('E2E round 2 (after reset)');
    }
  }

  // 10. OpenAI
  const smoke = node('scripts/openai-smoke-test.js', [], { stdio: 'pipe' });
  const skipped = /SKIPPED/.test(smoke.stdout);
  record('OpenAI smoke test', skipped ? 'SKIP' : smoke.status === 0 ? 'PASS' : 'FAIL', skipped ? 'OPENAI_API_KEY not set – ready for a real key' : String(smoke.stdout).split('\n').filter((l) => /✔ OpenAI|✖/.test(l)).join(' | '));
}

main().catch((e) => record('verification crashed', 'FAIL', e.message)).finally(() => {
  banner('SUMMARY');
  const w = Math.max(...steps.map((s) => s.name.length));
  steps.forEach((s) => console.log(`  ${s.status.padEnd(4)}  ${s.name.padEnd(w)}  ${s.detail}`));
  const failed = steps.filter((s) => s.status === 'FAIL').length;
  console.log(`\n  ${failed ? 'FAIL' : 'PASS'} – ${steps.filter((s) => s.status === 'PASS').length} passed, ${failed} failed, ${steps.filter((s) => s.status === 'SKIP').length} skipped\n`);
  process.exitCode = failed ? 1 : 0;
});
