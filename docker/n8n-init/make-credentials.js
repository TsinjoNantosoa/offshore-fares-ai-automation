'use strict';
/**
 * Builds the n8n credentials import file from environment variables.
 * Runs inside the one-shot n8n-init container; the output file is written to
 * a temp path, imported (n8n encrypts it with N8N_ENCRYPTION_KEY) and deleted.
 * Credential IDs match the references in n8n/*.json.
 */
const fs = require('fs');

// Fail fast on an invalid configuration (production rules when DEMO_MODE=false). Values are never printed.
try {
  const { validateEnvironment, formatReport } = require('/offshore-lib/envCheck');
  const check = validateEnvironment(process.env, 'n8n-init');
  console.log(formatReport(check, 'n8n-init'));
  if (!check.ok) process.exit(1);
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  console.log('[n8n-init] lib/envCheck.js not mounted – configuration validation skipped');
}
if (process.argv[2] === '--validate-only') process.exit(0);

const env = (k) => (process.env[k] || '').trim();
const missing = (v) => !v || /^YOUR_|^change-me/i.test(v);

const creds = [
  {
    id: 'ofPostgresCred01',
    name: 'Offshore Fares DB',
    type: 'postgres',
    data: { host: 'postgres', port: 5432, database: env('POSTGRES_DB') || 'offshore_fares', user: env('POSTGRES_USER'), password: env('POSTGRES_PASSWORD'), ssl: 'disable', allowUnauthorizedCerts: false, sshTunnel: false },
  },
  {
    id: 'ofOpsTokenCred01',
    name: 'Ops Console Token',
    type: 'httpHeaderAuth',
    data: { name: 'X-Ops-Token', value: env('OPS_API_TOKEN') },
  },
  {
    id: 'ofOpenAiCred0001',
    name: 'OpenAI (Offshore Fares)',
    type: 'openAiApi',
    data: { apiKey: missing(env('OPENAI_API_KEY')) ? 'not-configured' : env('OPENAI_API_KEY'), url: 'https://api.openai.com/v1' },
  },
  {
    id: 'ofWhatsAppCred01',
    name: 'WhatsApp Cloud API',
    type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: `Bearer ${missing(env('WHATSAPP_ACCESS_TOKEN')) ? 'not-configured' : env('WHATSAPP_ACCESS_TOKEN')}` },
  },
];

if (!missing(env('GMAIL_CLIENT_ID')) && !missing(env('GMAIL_CLIENT_SECRET'))) {
  creds.push({
    id: 'ofGmailCred00001',
    name: 'Gmail (Offshore Fares)',
    type: 'gmailOAuth2',
    data: { clientId: env('GMAIL_CLIENT_ID'), clientSecret: env('GMAIL_CLIENT_SECRET') },
  });
}

const warnings = [];
if (missing(env('OPS_API_TOKEN'))) throw new Error('OPS_API_TOKEN must be set to a random value in .env');
if (missing(env('OPENAI_API_KEY'))) warnings.push('OPENAI_API_KEY not set – AI calls will fall back to deterministic rules (set AI_PROVIDER=rules to skip the calls).');
if (missing(env('WHATSAPP_ACCESS_TOKEN'))) warnings.push('WHATSAPP_ACCESS_TOKEN not set – WhatsApp delivery only works in DEMO_MODE (simulated).');
if (!creds.find((c) => c.type === 'gmailOAuth2')) warnings.push('GMAIL_CLIENT_ID/SECRET not set – Gmail credential not created (email delivery simulated in DEMO_MODE).');

fs.writeFileSync(process.argv[2], JSON.stringify(creds), { mode: 0o600 });
warnings.forEach((w) => console.log(`[n8n-init] WARNING: ${w}`));
console.log(`[n8n-init] prepared ${creds.length} credentials: ${creds.map((c) => c.name).join(', ')}`);
