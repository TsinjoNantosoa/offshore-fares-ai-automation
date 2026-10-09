#!/usr/bin/env node
'use strict';
/**
 * npm run demo:reset
 * Restores the demo database to its initial state in a few seconds: RFQs, quotes, statuses,
 * assignments, follow-ups, alerts, audit/demo state. n8n workflows and credentials are untouched.
 * Refuses to run when DEMO_MODE=false (it deletes all business data).
 */
const { env, compose, psqlFile, waitStackReady, banner } = require('./lib/ops');

(async () => {
  const e = env();
  if (String(e.DEMO_MODE || 'true').toLowerCase() === 'false') {
    console.error('✖ demo:reset refused: DEMO_MODE=false (this command deletes all business data).');
    process.exit(1);
  }
  banner('Demo reset');
  const ps = compose(['ps', '--status', 'running', '--services'], { stdio: 'pipe' });
  if (!String(ps.stdout).includes('postgres')) {
    console.log('Stack not running – starting it (docker compose up -d)…');
    if (compose(['up', '-d']).status !== 0) process.exit(1);
  }
  const r = psqlFile('/offshore/database/reset_demo.sql');
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    console.error(out.split('\n').filter((l) => /ERROR|FATAL/.test(l)).join('\n') || out);
    process.exit(1);
  }
  const summary = (out.match(/demo data restored: [^\n]+/) || ['demo data restored'])[0].trim();
  console.log(`✔ ${summary}`);
  await waitStackReady(300000);
  console.log('✔ n8n and ops console ready');
})().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
