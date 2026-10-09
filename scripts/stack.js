#!/usr/bin/env node
'use strict';
/**
 * Stack lifecycle (cross-platform replacement of the former shell scripts).
 *
 *   node scripts/stack.js up        docker compose up -d --build + wait until ready   (npm run stack:up)
 *   node scripts/stack.js rebuild   wipe ALL volumes, rebuild, reimport, reload demo   (npm run demo:rebuild)
 *   node scripts/stack.js reimport  rebuild n8n/*.json, re-import + publish, restart n8n (npm run workflows:reimport)
 */
const { env, run, compose, waitStackReady, urls, banner } = require('./lib/ops');

async function main() {
  const cmd = process.argv[2];
  const u = urls();
  if (cmd === 'up') {
    banner('Starting the stack');
    if (compose(['up', '-d', '--build']).status !== 0) process.exit(1);
  } else if (cmd === 'rebuild') {
    if (String(env().DEMO_MODE || 'true').toLowerCase() === 'false') {
      console.error('✖ rebuild refused: DEMO_MODE=false (it deletes every volume).');
      process.exit(1);
    }
    banner('Full rebuild (volumes wiped) – first start takes ~6-9 min');
    if (run('node', ['scripts/build-workflows.js']).status !== 0) process.exit(1);
    compose(['down', '-v']);
    if (compose(['up', '-d', '--build']).status !== 0) process.exit(1);
  } else if (cmd === 'reimport') {
    banner('Re-import workflows (overwrites edits made in the n8n editor)');
    if (run('node', ['scripts/build-workflows.js']).status !== 0) process.exit(1);
    if (compose(['run', '--rm', '-e', 'N8N_FORCE_REIMPORT=true', 'n8n-init']).status !== 0) process.exit(1);
    compose(['restart', 'n8n']);
  } else {
    console.log('usage: node scripts/stack.js up|rebuild|reimport');
    process.exit(2);
  }
  console.log('Waiting until n8n and the ops console are ready…');
  await waitStackReady(900000);
  console.log(`✔ Ready\n  Ops console : ${u.console}\n  n8n         : ${u.n8n}`);
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
