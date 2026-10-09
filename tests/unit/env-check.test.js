'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvironment } = require('../../lib/envCheck');

const demoEnv = {
  DEMO_MODE: 'true', N8N_ENCRYPTION_KEY: 'local-test-key', POSTGRES_USER: 'offshore', POSTGRES_PASSWORD: 'pw',
  CONSOLE_DB_PASSWORD: 'pw2', OPS_API_TOKEN: 'local-test-ops-token', AI_PROVIDER: 'rules',
};

const prodEnv = {
  DEMO_MODE: 'false', LOAD_DEMO_DATA: 'false', N8N_PROTOCOL: 'https',
  N8N_ENCRYPTION_KEY: 'a'.repeat(40), POSTGRES_USER: 'offshore', POSTGRES_PASSWORD: 'Str0ng-db-password',
  CONSOLE_DB_PASSWORD: 'Str0ng-console-pw', OPS_API_TOKEN: 'b'.repeat(32), CONSOLE_USER: 'ops', CONSOLE_PASSWORD: 'Str0ng-console-login',
  AI_PROVIDER: 'openai', OPENAI_API_KEY: 'real-key-value-for-test', OPENAI_MODEL: 'gpt-4.1-mini',
  GMAIL_CLIENT_ID: 'client-id.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'gmail-secret-value',
};

test('demo mode runs with local placeholders and only warns', () => {
  const r = validateEnvironment(demoEnv, 'all');
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.mode, 'DEMO');
  assert.ok(r.warnings.some((w) => /no authentication/.test(w)));
});

test('demo mode still requires the minimum (ops token, encryption key)', () => {
  const r = validateEnvironment(Object.assign({}, demoEnv, { OPS_API_TOKEN: '', N8N_ENCRYPTION_KEY: '' }), 'all');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('OPS_API_TOKEN')));
  assert.ok(r.errors.some((e) => e.startsWith('N8N_ENCRYPTION_KEY')));
});

test('a complete production configuration is valid', () => {
  const r = validateEnvironment(prodEnv, 'all');
  assert.deepEqual(r.errors, []);
  assert.equal(r.mode, 'PRODUCTION');
});

test('production fails fast: placeholders, demo data, missing console auth, missing AI key', () => {
  const r = validateEnvironment(Object.assign({}, prodEnv, {
    N8N_ENCRYPTION_KEY: 'change-me-to-a-long-random-string', LOAD_DEMO_DATA: 'true', CONSOLE_USER: '', CONSOLE_PASSWORD: '', OPENAI_API_KEY: 'YOUR_OPENAI_API_KEY',
  }), 'all');
  assert.equal(r.ok, false);
  for (const needle of [/^N8N_ENCRYPTION_KEY/, /^LOAD_DEMO_DATA/, /^CONSOLE_USER/, /^CONSOLE_PASSWORD/, /^OPENAI_API_KEY/]) {
    assert.ok(r.errors.some((e) => needle.test(e)), String(needle));
  }
});

test('production requires a channel, a complete WhatsApp setup and HTTPS for Meta webhooks', () => {
  const none = validateEnvironment(Object.assign({}, prodEnv, { GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '' }), 'all');
  assert.ok(none.errors.some((e) => /At least one channel/.test(e)));
  const partialWa = validateEnvironment(Object.assign({}, prodEnv, { WHATSAPP_ACCESS_TOKEN: 'token-value', N8N_PROTOCOL: 'http' }), 'all');
  for (const k of ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'N8N_PROTOCOL']) assert.ok(partialWa.errors.some((e) => e.startsWith(k)), k);
});

test('console component: refuses to start publicly without authentication in production', () => {
  const r = validateEnvironment({ DEMO_MODE: 'false', OPS_API_TOKEN: 'c'.repeat(32), PGPASSWORD: 'Str0ng-console-pw' }, 'console');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /CONSOLE_USER/.test(e)));
  assert.ok(!r.errors.some((e) => /OPENAI/.test(e)), 'console does not need the OpenAI key');
});

test('messages never contain secret values', () => {
  const r = validateEnvironment(Object.assign({}, prodEnv, { OPS_API_TOKEN: 'short-secret' }), 'all');
  assert.ok(r.errors.every((e) => !e.includes('short-secret')));
});

test('remote database (Neon): DATABASE_URL replaces PG* for the console, SSL cannot be disabled', () => {
  const ok = validateEnvironment({ DEMO_MODE: 'true', OPS_API_TOKEN: 'x', DATABASE_URL: 'postgresql://u:p@host/db?sslmode=require' }, 'console');
  assert.equal(ok.ok, true, ok.errors.join('; '));
  const bad = validateEnvironment({ DEMO_MODE: 'true', OPS_API_TOKEN: 'x', DATABASE_URL: 'postgresql://u:p@host/db?sslmode=disable' }, 'console');
  assert.ok(bad.errors.some((e) => /SSL/.test(e)));
  assert.ok(bad.errors.every((e) => !e.includes('u:p@')), 'never echoes the URL');
});
