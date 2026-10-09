#!/usr/bin/env node
'use strict';
/**
 * npm run config:check – validates .env (+ process env) with the same rules the containers
 * apply at start-up (lib/envCheck.js). Prints variable names only, never values.
 */
const { env } = require('./lib/ops');
const { validateEnvironment, formatReport } = require('../lib/envCheck');

const effective = env();
let ok = true;
for (const component of ['n8n-init', 'console']) {
  const e = component === 'console' ? Object.assign({ PGPASSWORD: effective.CONSOLE_DB_PASSWORD }, effective) : effective;
  const r = validateEnvironment(e, component);
  console.log(formatReport(r, component));
  ok = ok && r.ok;
}
console.log(ok ? '✔ configuration valid' : '✖ configuration invalid – fix the variables above');
process.exit(ok ? 0 : 1);
