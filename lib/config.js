'use strict';
/**
 * Typed runtime configuration.
 *
 * In n8n Code nodes this is called with `$env`; in tests with a plain object.
 * Only NON-SECRET settings are read here. Secrets (OpenAI key, WhatsApp token,
 * database password) live in n8n Credentials and are never visible to Code nodes.
 */

const DEFAULTS = {
  DEMO_MODE: true,
  REQUIRE_HUMAN_APPROVAL: true,
  AUTO_ACKNOWLEDGE: true,
  COMPANY_NAME: 'Offshore Fares',
  COMPANY_SIGNATURE: 'Offshore Fares – Premium Fares Desk',
  BUSINESS_TIMEZONE: 'UTC',
  AI_PROVIDER: 'openai', // 'openai' | 'rules' (offline demo – deterministic fallback only)
  OPENAI_MODEL: 'gpt-4.1-mini',
  OPENAI_TEMPERATURE: 0,
  OPENAI_FORMATTER_TEMPERATURE: 0.2,
  AI_CONFIDENCE_THRESHOLD: 0.7,
  CORRELATION_WINDOW_HOURS: 72,
  CLARIFICATION_DEBOUNCE_SECONDS_WHATSAPP: 45,
  CLARIFICATION_DEBOUNCE_SECONDS_EMAIL: 0,
  MAX_CLARIFICATIONS: 2,
  GROUP_MIN_PASSENGERS: 10,
  FOLLOWUP_1_HOURS: 4,
  FOLLOWUP_2_HOURS: 24,
  MAX_FOLLOWUPS: 2,
  SLA_NEW_MINUTES: 5,
  SLA_READY_FOR_SEARCH_MINUTES: 10,
  SLA_ASSIGNED_MINUTES: 15,
  SLA_SEARCHING_MINUTES: 45,
  SLA_FARES_FOUND_MINUTES: 10,
  SLA_PENDING_APPROVAL_MINUTES: 10,
  SLA_BOOKING_REQUEST_MINUTES: 5,
  SLA_CHANGE_REQUEST_MINUTES: 15,
  SLA_REFUND_REQUEST_MINUTES: 60,
  SLA_CRITICAL_FACTOR: 0.5,
  WHATSAPP_GRAPH_VERSION: 'v21.0',
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_FOLLOWUP_TEMPLATE: 'quote_followup',
  WHATSAPP_TEMPLATE_LANGUAGE: 'en',
  WHATSAPP_SIGNATURE_REQUIRED: false,
  DATE_ORDER: 'DMY',
  PRIORITY_RULES_JSON: '',
};

const BOOLEAN_KEYS = ['DEMO_MODE', 'REQUIRE_HUMAN_APPROVAL', 'AUTO_ACKNOWLEDGE', 'WHATSAPP_SIGNATURE_REQUIRED'];

function readEnv(env, key) {
  try {
    const value = env ? env[key] : undefined;
    return value === undefined || value === null || value === '' ? undefined : value;
  } catch (_) {
    // n8n throws when env access is blocked; fall back to defaults.
    return undefined;
  }
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getConfig(env) {
  const cfg = {};
  for (const key of Object.keys(DEFAULTS)) {
    const fallback = DEFAULTS[key];
    const raw = readEnv(env, key);
    if (BOOLEAN_KEYS.includes(key)) cfg[key] = toBool(raw, fallback);
    else if (typeof fallback === 'number') {
      const n = raw === undefined ? NaN : Number(raw);
      cfg[key] = Number.isFinite(n) ? n : fallback;
    } else cfg[key] = raw === undefined ? fallback : String(raw);
  }
  return cfg;
}

/** Reasoning-family models reject custom temperature; everything else gets a low one. */
function supportsTemperature(model) {
  return !/^(o\d|gpt-5)/i.test(String(model || ''));
}

module.exports = { DEFAULTS, getConfig, supportsTemperature, toBool };
