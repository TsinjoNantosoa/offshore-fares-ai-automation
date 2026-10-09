'use strict';
/**
 * Cross-platform helpers for the npm scripts (Windows / macOS / Linux – no bash required).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** Minimal .env parser (KEY=VALUE, # comments). Values are never printed by these scripts. */
function readDotEnv(file) {
  const target = file || path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(target)) return out;
  for (const line of fs.readFileSync(target, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}

/** Effective configuration: process env overrides .env (like docker compose). */
function env() {
  return Object.assign({}, readDotEnv(), process.env);
}

function run(cmd, args, opts) {
  const o = Object.assign({ cwd: ROOT, stdio: 'inherit', encoding: 'utf8', shell: false }, opts || {});
  const r = spawnSync(cmd, args, o);
  if (r.error) throw r.error;
  return r;
}

function compose(args, opts) {
  return run('docker', ['compose'].concat(args), opts);
}

/** Run a SQL file inside the postgres container (paths are container paths under /offshore/database). */
function psqlFile(containerPath, opts) {
  return compose(['exec', '-T', 'postgres', 'sh', '-c', `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f ${containerPath}`],
    Object.assign({ stdio: 'pipe' }, opts || {}));
}

function urls() {
  const e = env();
  return {
    n8n: process.env.N8N_URL || `http://localhost:${e.N8N_PORT || 5678}`,
    console: process.env.CONSOLE_URL || `http://localhost:${e.CONSOLE_PORT || 3000}`,
  };
}

async function waitFor(label, check, { timeoutMs = 300000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await check()) return true; } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Waits until the console reports db + n8n ready (n8n readiness = DB connected and workflows loaded). */
async function waitStackReady(timeoutMs) {
  const u = urls();
  await waitFor('n8n readiness', async () => (await fetch(`${u.n8n}/healthz/readiness`)).ok, { timeoutMs });
  await waitFor('ops console readiness', async () => (await fetch(`${u.console}/ready`)).ok, { timeoutMs });
  // n8n reports ready slightly before every webhook is registered: probe a real webhook.
  await waitFor('n8n webhooks registered', async () => {
    const r = await fetch(`${u.n8n}/webhook/ops/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return r.status === 403; // registered and protected by the ops token (404 = not registered yet)
  }, { timeoutMs });
}

function banner(text) {
  const line = '─'.repeat(Math.max(20, text.length + 4));
  console.log(`\n${line}\n  ${text}\n${line}`);
}

module.exports = { ROOT, readDotEnv, env, run, compose, psqlFile, urls, waitFor, waitStackReady, banner };
