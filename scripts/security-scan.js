#!/usr/bin/env node
'use strict';
/**
 * npm run security:scan
 * Scans every distributable file for secrets. Never prints a secret value – only the
 * file, line and type, followed by "SECRET DETECTED — ROTATION REQUIRED".
 * Also verifies that .env is excluded from git and Docker build contexts.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./lib/ops');

const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['.env']); // local, git-ignored – checked separately below
const TEXT = /\.(js|json|md|sql|sh|yml|yaml|html|css|example|txt|env\.example|gitignore|dockerignore|gitattributes)$|^(Dockerfile|\.gitignore|\.dockerignore|\.env\.example)$/;

const RULES = [
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['Meta / WhatsApp access token', /\bEAA[A-Za-z0-9]{30,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Google OAuth access token', /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g],
  ['Credentials in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@/'"$]{6,}@[^\s'"]+/gi],
  ['Hard-coded password', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\s$]{8,}['"]/gi],
  ['Card number', /\b(?:\d[ -]?){13,19}\b/g],
  ['Tunnel / private URL', /\bhttps?:\/\/[a-z0-9-]+\.(?:ngrok(?:-free)?\.(?:io|app)|trycloudflare\.com|loca\.lt)\b/gi],
];

// Obvious fixtures used by the unit tests to prove redaction works (never real credentials).
const FIXTURE = /abcdefghij|xxxxxxxx|4111[ -]?1111[ -]?1111[ -]?1111|YOUR_|change-me|local-test|example\.com|\.example\b|not-configured|<[a-z-]+>/i;

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!SKIP_FILES.has(e.name) && (TEXT.test(e.name))) out.push(p);
  }
  return out;
}

const findings = [];
let scanned = 0;
for (const file of walk(ROOT, [])) {
  scanned += 1;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [type, re] of RULES) {
      for (const m of line.matchAll(re)) {
        const value = m[0];
        if (FIXTURE.test(value) || FIXTURE.test(line)) continue;
        // variable references (psql :'name', ${NAME}, process.env.X) are not values
        if (type === 'Hard-coded password' && /[:=]\s*['"][a-z_]+['"]$/.test(value)) continue;
        if (type === 'Card number') {
          const digits = value.replace(/\D/g, '');
          if (digits.length < 13 || !luhn(digits) || /^(\d)\1+$/.test(digits) || /^1555|^4477|^44 ?20/.test(digits)) continue;
          if (/uuid|[0-9a-f]{8}-|phone|whatsapp|wa_id|timestamp|digest|hash/i.test(line)) continue;
        }
        findings.push({ file: rel, line: i + 1, type });
      }
    }
  });
}

// .env must never be distributed
const checks = [];
const gi = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
checks.push(['.env listed in .gitignore', /^\.env$/m.test(gi)]);
const di = fs.existsSync(path.join(ROOT, '.dockerignore')) ? fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8') : '';
checks.push(['.env listed in .dockerignore', /^\.env$/m.test(di)]);
checks.push(['.env.example present', fs.existsSync(path.join(ROOT, '.env.example'))]);
const git = spawnSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: ROOT, encoding: 'utf8' });
if (!git.error && git.status === 0) checks.push(['.env NOT tracked by git', false]);

console.log(`Security scan – ${scanned} files`);
checks.forEach(([label, ok]) => console.log(`  ${ok ? '✔' : '✖'} ${label}`));
if (findings.length) {
  findings.forEach((f) => console.log(`  ✖ ${f.file}:${f.line} – ${f.type}: SECRET DETECTED — ROTATION REQUIRED`));
}
const ok = !findings.length && checks.every(([, v]) => v);
console.log(ok ? '✔ NO EXPOSED SECRETS' : '✖ SECURITY SCAN FAILED');
process.exit(ok ? 0 : 1);
