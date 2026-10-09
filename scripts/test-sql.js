#!/usr/bin/env node
'use strict';
/**
 * npm run test:sql – runs database/tests/api_flow_test.sql inside the postgres container.
 * Everything runs in a transaction that is rolled back: no side effects on demo data.
 */
const { psqlFile } = require('./lib/ops');

const r = psqlFile('/offshore/database/tests/api_flow_test.sql');
const out = `${r.stdout || ''}${r.stderr || ''}`;
const notices = out.split(/\r?\n/).map((l) => (/NOTICE:\s+(.*)$/.exec(l) || [])[1]).filter(Boolean);
notices.forEach((n) => console.log(`  ${n.startsWith('ALL') ? '✔' : '·'} ${n}`));
const errors = out.split('\n').filter((l) => /ERROR:/.test(l));
if (r.status !== 0 || errors.length || !notices.some((n) => n.startsWith('ALL SQL API TESTS PASSED'))) {
  console.error(errors.join('\n') || out.slice(-1500));
  console.error('✖ SQL API tests FAILED');
  process.exit(1);
}
console.log(`✔ SQL API tests passed (${notices.length - 1} groups)`);
