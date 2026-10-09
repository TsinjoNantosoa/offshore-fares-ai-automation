'use strict';
/**
 * Start-up configuration validation (fail fast).
 *
 *   validateEnvironment(env, component) -> { ok, mode, errors: [], warnings: [] }
 *   component: 'console' | 'n8n-init' | 'all'
 *
 * DEMO_MODE=true  -> only what is needed to run the demo is mandatory; the rest are warnings.
 * DEMO_MODE=false -> production rules: real secrets, console authentication, no demo data,
 *                    an AI key when AI_PROVIDER=openai, and complete channel configurations.
 * Values are never echoed back – only variable names appear in messages.
 */

const PLACEHOLDER = /^(your_|change-me|changeme|local-test|example|xxx|todo|placeholder)/i;

function val(env, key) {
  const v = env[key];
  return v === undefined || v === null ? '' : String(v).trim();
}
function isSet(env, key) {
  const v = val(env, key);
  return v !== '' && !PLACEHOLDER.test(v);
}
function bool(env, key, fallback) {
  const v = val(env, key);
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function validateEnvironment(env, component) {
  const scope = component || 'all';
  const inScope = (...c) => scope === 'all' || c.includes(scope);
  const demo = bool(env, 'DEMO_MODE', true);
  const errors = [];
  const warnings = [];
  const need = (key, why) => { if (!val(env, key)) errors.push(`${key} is required (${why})`); };
  const prodSecret = (key, minLength, why) => {
    if (!isSet(env, key)) errors.push(`${key} must be set to a real secret in production (${why})`);
    else if (val(env, key).length < minLength) errors.push(`${key} must be at least ${minLength} characters in production`);
  };

  // --- always required -------------------------------------------------------
  if (inScope('n8n-init')) {
    need('N8N_ENCRYPTION_KEY', 'encrypts n8n credentials');
    need('POSTGRES_USER', 'database');
    need('POSTGRES_PASSWORD', 'database');
  }
  if (inScope('console')) {
    if (scope === 'console') need('PGPASSWORD', 'read-only database role of the console');
    else need('CONSOLE_DB_PASSWORD', 'read-only database role of the console');
  }
  if (inScope('n8n-init', 'console')) need('OPS_API_TOKEN', 'protects the operator webhooks');

  const ai = (val(env, 'AI_PROVIDER') || 'openai').toLowerCase();
  if (!['openai', 'rules'].includes(ai)) errors.push('AI_PROVIDER must be "openai" or "rules"');

  const waKeys = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'];
  const waAny = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET'].some((k) => isSet(env, k));
  const gmailAny = isSet(env, 'GMAIL_CLIENT_ID') || isSet(env, 'GMAIL_CLIENT_SECRET');

  if (demo) {
    if (inScope('n8n-init') && ai === 'openai' && !isSet(env, 'OPENAI_API_KEY')) {
      warnings.push('OPENAI_API_KEY not set – AI calls will fall back to deterministic rules (set AI_PROVIDER=rules to skip them).');
    }
    if (inScope('console') && !val(env, 'CONSOLE_USER')) warnings.push('CONSOLE_USER/CONSOLE_PASSWORD not set – console has no authentication (acceptable on localhost only).');
    if (inScope('n8n-init') && !waAny) warnings.push('WhatsApp Cloud API not configured – WhatsApp delivery is simulated (DEMO_MODE).');
    if (inScope('n8n-init') && !gmailAny) warnings.push('Gmail OAuth not configured – email delivery is simulated (DEMO_MODE).');
    return { ok: errors.length === 0, mode: 'DEMO', errors, warnings };
  }

  // --- production rules (DEMO_MODE=false) -------------------------------------
  if (inScope('n8n-init')) {
    prodSecret('N8N_ENCRYPTION_KEY', 32, 'encrypts all n8n credentials – keep a backup');
    prodSecret('POSTGRES_PASSWORD', 12, 'database owner');
    if (bool(env, 'LOAD_DEMO_DATA', true)) errors.push('LOAD_DEMO_DATA must be false in production (no fictional data in the normal workflow)');
    if (ai === 'openai' && !isSet(env, 'OPENAI_API_KEY')) errors.push('OPENAI_API_KEY is required when AI_PROVIDER=openai in production');
    if (!val(env, 'OPENAI_MODEL')) warnings.push('OPENAI_MODEL not set – the default from lib/config.js is used');
    if (!waAny && !gmailAny) errors.push('At least one channel must be configured in production (Gmail OAuth and/or WhatsApp Cloud API)');
    if (waAny) {
      for (const k of waKeys) if (!isSet(env, k)) errors.push(`${k} is required when WhatsApp is enabled (signature verification and sending)`);
      if ((val(env, 'N8N_PROTOCOL') || 'http') !== 'https') errors.push('N8N_PROTOCOL must be https – Meta only calls HTTPS webhooks');
    }
    if (gmailAny && !(isSet(env, 'GMAIL_CLIENT_ID') && isSet(env, 'GMAIL_CLIENT_SECRET'))) errors.push('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must both be set');
    if (!bool(env, 'REQUIRE_HUMAN_APPROVAL', true)) warnings.push('REQUIRE_HUMAN_APPROVAL=false – quotes will be sent without a human decision');
  }
  if (inScope('n8n-init', 'console')) prodSecret('OPS_API_TOKEN', 24, 'operator webhooks');
  if (inScope('console')) {
    prodSecret(scope === 'console' ? 'PGPASSWORD' : 'CONSOLE_DB_PASSWORD', 12, 'console database role');
    if (!val(env, 'CONSOLE_USER')) errors.push('CONSOLE_USER is required in production – the console must never be public without authentication');
    prodSecret('CONSOLE_PASSWORD', 12, 'console authentication');
  }
  return { ok: errors.length === 0, mode: 'PRODUCTION', errors, warnings };
}

function formatReport(result, component) {
  const lines = [`[config] ${component || 'all'} · ${result.mode} mode · ${result.ok ? 'OK' : 'INVALID'}`];
  result.errors.forEach((e) => lines.push(`  ✖ ${e}`));
  result.warnings.forEach((w) => lines.push(`  ! ${w}`));
  return lines.join('\n');
}

module.exports = { validateEnvironment, formatReport, isSet };
