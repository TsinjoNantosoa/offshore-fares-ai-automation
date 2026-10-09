'use strict';
/**
 * Prompt-injection screening and secret redaction.
 *
 * Defence in depth – the real protections are architectural:
 *  - the model never receives secrets (keys live in n8n Credentials),
 *  - the model only returns schema-constrained JSON that code validates,
 *  - the model cannot trigger sends: delivery is decided by workflow logic + human approval.
 * This module adds detection (flag + audit + human review) and output scrubbing.
 */

const INJECTION_PATTERNS = [
  { id: 'ignore_instructions', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|guidelines?)\b/i },
  { id: 'reveal_secret', re: /\b(show|reveal|print|give|send|tell|display|leak|share|output)\b[^.\n]{0,40}\b(api[\s_-]?keys?|secrets?|passwords?|tokens?|credentials?|system prompt|env(?:ironment)? variables?)\b/i },
  { id: 'role_override', re: /\b(you are now|act as|pretend to be|from now on you|developer mode|jailbreak|DAN mode)\b/i },
  { id: 'system_markup', re: /(<\/?(system|assistant|instructions?)>|\[\/?(INST|SYSTEM)\]|^#{2,}\s*(system|instruction))/im },
  { id: 'tool_abuse', re: /\b(execute|run)\b[^.\n]{0,30}\b(command|shell|sql|code)\b|\bdrop\s+table\b/i },
  { id: 'price_manipulation', re: /\b(set|change|make)\b[^.\n]{0,30}\b(price|fare)\b[^.\n]{0,20}\b(to|=)\s*(?:usd|\$|eur|0)\b/i },
];

const SECRET_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\bEAA[A-Za-z0-9]{20,}\b/g, // Meta / WhatsApp access tokens
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API keys
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g, // Google OAuth access tokens
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
  /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/gi,
  /\b(?:\d[ -]?){13,19}\b/g, // card-number-like digit runs
];

function screenInjection(text) {
  const src = String(text || '');
  const signals = INJECTION_PATTERNS.filter((p) => p.re.test(src)).map((p) => p.id);
  return { suspected: signals.length > 0, signals };
}

function redactSecrets(value) {
  let out = String(value === undefined || value === null ? '' : value);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function containsSecret(value) {
  const src = String(value || '');
  return SECRET_PATTERNS.some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(src));
}

/** Deep-redact an object (used before logging errors / payloads). */
function redactObject(value, depth) {
  const d = depth || 0;
  if (d > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactObject(v, d + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/(authorization|api[_-]?key|token|secret|password|cookie)/i.test(k)) out[k] = '[REDACTED]';
      else out[k] = redactObject(v, d + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactSecrets(value).slice(0, 4000);
  return value;
}

/**
 * Wrap untrusted content for the model. Closing tags inside the content are
 * neutralised so the message cannot "escape" its envelope.
 */
function wrapUntrusted(text, tag) {
  const name = tag || 'untrusted_message';
  const safe = String(text || '').replace(new RegExp(`</?\\s*${name}\\s*>`, 'gi'), '[tag removed]');
  return `<${name}>\n${safe}\n</${name}>`;
}

module.exports = { screenInjection, redactSecrets, redactObject, containsSecret, wrapUntrusted };
