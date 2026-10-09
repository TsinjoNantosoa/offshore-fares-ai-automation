#!/usr/bin/env node
'use strict';
/**
 * Remote database tooling (Neon / any managed PostgreSQL) driven by DATABASE_URL.
 *
 *   npm run db:init         schema → functions → migrations → demo seed (DEMO_MODE=true only) → verification
 *   npm run db:check        verifies every object the project needs (+ n8n / console SQL compatibility)
 *   npm run db:seed         loads the demo dataset once (DEMO_MODE=true only)
 *   npm run db:reset-demo   restores the demo dataset (DEMO_MODE=true AND demo-only database)
 *   npm run db:test         connection test + SQL API tests (rolled back)
 *
 * Source of truth: database/schema.sql, database/functions.sql, database/migrations/V*.sql,
 * database/seed.sql. Applied versions are recorded in `of_schema_migrations`, so re-running
 * db:init never duplicates anything – and never hides a real error (it stops at the first one).
 * Never runs CREATE DATABASE / DROP DATABASE.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, env } = require('./lib/ops');
const { describe, psql, query, firstError, connection, psqlClient } = require('./lib/pgcli');

const DB = path.join(ROOT, 'database');
const FILES = {
  schema: path.join(DB, 'schema.sql'),
  functions: path.join(DB, 'functions.sql'),
  seed: path.join(DB, 'seed.sql'),
  reset: path.join(DB, 'reset_demo.sql'),
  test: path.join(DB, 'tests', 'api_flow_test.sql'),
};
const demoMode = () => String(env().DEMO_MODE || 'true').toLowerCase() === 'true';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

class StepError extends Error {
  constructor(step, file, pgError) {
    super(`${step} failed${file ? ` (${file})` : ''}: ${pgError}`);
    this.step = step;
  }
}

// ---------------------------------------------------------------------------
// Expected objects, parsed from the repository (single source of truth)
// ---------------------------------------------------------------------------
function expected() {
  const schema = fs.readFileSync(FILES.schema, 'utf8');
  const functions = fs.readFileSync(FILES.functions, 'utf8');
  const migrations = migrationFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const all = `${schema}\n${migrations}`;
  return {
    tables: Array.from(schema.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gm)).map((m) => m[1]),
    indexes: Array.from(new Set(Array.from(all.matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+)/g)).map((m) => m[1]))),
    functions: Array.from(new Set(Array.from(functions.matchAll(/^CREATE OR REPLACE FUNCTION (\w+)/gm)).map((m) => m[1]))),
    transitions: (schema.split('INSERT INTO rfq_status_transitions')[1].split(';')[0].match(/\('[A-Z_]+', '[A-Z_]+'\)/g) || []).length,
    statuses: (schema.split('INSERT INTO rfq_statuses')[1].split(';')[0].match(/\('[A-Z_]+', '/g) || []).length,
    desks: (schema.split('INSERT INTO desks')[1].split(';')[0].match(/\('[A-Z_]+', '/g) || []).length,
  };
}

function migrationFiles() {
  const dir = path.join(DB, 'migrations');
  return fs.readdirSync(dir).filter((f) => /^V\d+__.*\.sql$/.test(f)).sort().map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
function log(text) { process.stdout.write(`${text}\n`); }

function connect() {
  log('Connecting to Neon...');
  const conn = connection();
  const client = psqlClient();
  const rows = query(conn, "SELECT current_database(), current_user, split_part(version(), ' ', 2), now()");
  log(`Connection successful. ${describe(conn)} · PostgreSQL ${rows[0][2]} · client ${client.docker ? 'docker psql' : 'local psql'}`);
  return conn;
}

function ensureMigrationTable(conn) {
  const r = psql(conn, { sql: `CREATE TABLE IF NOT EXISTS of_schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())` });
  if (!r.ok) throw new StepError('Migration registry', null, firstError(r.stderr));
}

function applied(conn) {
  return Object.fromEntries(query(conn, 'SELECT version, checksum FROM of_schema_migrations').map(([v, c]) => [v, c]));
}

function record(conn, version, checksum) {
  const r = psql(conn, { sql: `INSERT INTO of_schema_migrations (version, checksum) VALUES ('${version}', '${checksum}')
                               ON CONFLICT (version) DO UPDATE SET checksum = excluded.checksum, applied_at = now()` });
  if (!r.ok) throw new StepError('Migration registry', null, firstError(r.stderr));
}

function existingTables(conn) {
  return query(conn, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'").map((r) => r[0]);
}

function applyFile(conn, label, file, { singleTransaction = true } = {}) {
  process.stdout.write(`\n${label}...\n`);
  const r = psql(conn, { file }, { singleTransaction });
  if (!r.ok) {
    log('FAIL');
    throw new StepError(label, rel(file), firstError(r.stderr));
  }
  log('PASS');
}

function applySchema(conn, done, exp) {
  if (done.V001_baseline_schema) {
    log('\nApplying schema...\nSKIP (already applied – recorded in of_schema_migrations)');
    return;
  }
  const present = existingTables(conn).filter((t) => exp.tables.includes(t));
  if (present.length === exp.tables.length) {
    // Created earlier without the registry (e.g. by docker init): adopt it, do not re-create.
    log('\nApplying schema...\nSKIP (all tables already exist – baseline adopted)');
  } else if (present.length > 0) {
    throw new StepError('Applying schema', rel(FILES.schema), `the database already contains ${present.length}/${exp.tables.length} project tables but no migration record – partial state, refusing to continue (inspect manually)`);
  } else {
    applyFile(conn, 'Applying schema', FILES.schema);
  }
  record(conn, 'V001_baseline_schema', sha(FILES.schema));
}

function applyFunctions(conn) {
  // CREATE OR REPLACE everywhere: always re-applied so function fixes reach the database.
  applyFile(conn, 'Applying functions', FILES.functions);
  record(conn, 'functions', sha(FILES.functions));
}

function applyMigrations(conn, done) {
  process.stdout.write('\nApplying migrations...\n');
  const pending = migrationFiles().filter((f) => !done[path.basename(f, '.sql')]);
  for (const f of pending) {
    const r = psql(conn, { file: f }, { singleTransaction: !/^\s*BEGIN;/m.test(fs.readFileSync(f, 'utf8')) });
    if (!r.ok) { log('FAIL'); throw new StepError('Applying migrations', rel(f), firstError(r.stderr)); }
    record(conn, path.basename(f, '.sql'), sha(f));
    log(`  applied ${path.basename(f)}`);
  }
  log(pending.length ? 'PASS' : 'PASS (nothing pending)');
}

function applySeed(conn, done, { force = false } = {}) {
  process.stdout.write('\nApplying demo seed...\n');
  if (!demoMode()) { log('SKIP (DEMO_MODE=false – fictional data is never loaded automatically)'); return; }
  const agencies = Number(query(conn, 'SELECT count(*) FROM agencies')[0][0]);
  if (!force && (done.seed_demo || agencies > 0)) {
    log(`SKIP (demo data already present: ${agencies} agencies)`);
    if (!done.seed_demo && agencies > 0) record(conn, 'seed_demo', sha(FILES.seed));
    return;
  }
  const r = psql(conn, { file: FILES.seed }); // seed.sql has its own BEGIN/COMMIT
  if (!r.ok) { log('FAIL'); throw new StepError('Applying demo seed', rel(FILES.seed), firstError(r.stderr)); }
  record(conn, 'seed_demo', sha(FILES.seed));
  log('PASS');
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
function n8nQueries() {
  const dir = path.join(ROOT, 'n8n');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const wf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) out.push({ workflow: wf.name, node: n.name, query: n.parameters.query });
  }
  return out;
}

function consoleQueries() {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.js'), 'utf8');
  return Array.from(src.matchAll(/\b(?:q|one)\(`([\s\S]*?)`/g)).map((m) => m[1]).filter((sql) => !sql.includes('${'));
}

function verify(conn) {
  process.stdout.write('\nDatabase verification...\n');
  const exp = expected();
  const problems = [];
  const report = {};

  const tables = existingTables(conn);
  const missingTables = exp.tables.filter((t) => !tables.includes(t));
  report.tables = `${exp.tables.length - missingTables.length}/${exp.tables.length}`;
  missingTables.forEach((t) => problems.push(`missing table ${t}`));

  const fns = query(conn, `SELECT p.proname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid)
                             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'of\\_%'`);
  const fnNames = new Set(fns.map((r) => r[0]));
  const missingFns = exp.functions.filter((f) => !fnNames.has(f));
  report.functions = `${exp.functions.length - missingFns.length}/${exp.functions.length}`;
  missingFns.forEach((f) => problems.push(`missing function ${f}()`));

  const idx = new Set(query(conn, "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'").map((r) => r[0]));
  const missingIdx = exp.indexes.filter((i) => !idx.has(i));
  report.indexes = `${exp.indexes.length - missingIdx.length}/${exp.indexes.length} named (+ PK/unique-constraint indexes: ${idx.size} total)`;
  missingIdx.forEach((i) => problems.push(`missing index ${i}`));

  const cons = Object.fromEntries(query(conn, `SELECT contype, count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                                                 WHERE n.nspname = 'public' GROUP BY contype`).map(([t, c]) => [t, Number(c)]));
  report.constraints = `PK ${cons.p || 0} · FK ${cons.f || 0} · UNIQUE ${cons.u || 0} · CHECK ${cons.c || 0}`;
  if ((cons.f || 0) < 30) problems.push(`only ${cons.f || 0} foreign keys found (expected ≥ 30)`);
  if ((cons.p || 0) < exp.tables.length) problems.push(`only ${cons.p || 0} primary keys for ${exp.tables.length} tables`);

  const ext = query(conn, "SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto'")[0][0];
  if (ext !== '1') problems.push('extension pgcrypto missing');

  const ref = query(conn, 'SELECT (SELECT count(*) FROM rfq_statuses), (SELECT count(*) FROM rfq_status_transitions), (SELECT count(*) FROM desks)')[0].map(Number);
  report.reference = `${ref[0]} statuses · ${ref[1]} transitions · ${ref[2]} desks`;
  if (ref[0] !== exp.statuses || ref[1] !== exp.transitions || ref[2] !== exp.desks) problems.push(`reference data mismatch (expected ${exp.statuses}/${exp.transitions}/${exp.desks})`);

  if (demoMode()) {
    const d = query(conn, `SELECT (SELECT count(*) FROM agencies), (SELECT count(*) FROM contacts), (SELECT count(*) FROM rfqs),
                                  (SELECT count(*) FROM agencies WHERE name = 'Apex Travel' AND priority_level = 'VIP'),
                                  (SELECT count(*) FROM contacts WHERE email = 'john.carter@apex-travel.example'),
                                  (SELECT count(*) FROM rfqs WHERE booking_reference = 'K7Q2LM'),
                                  (SELECT count(*) FROM operators), (SELECT count(*) FROM knowledge_base)`)[0].map(Number);
    report.demo = `${d[0]} agencies · ${d[1]} contacts · ${d[2]} RFQs · ${d[6]} operators · ${d[7]} KB articles · Apex Travel ${d[3] ? '✔' : '✖'} · John Carter ${d[4] ? '✔' : '✖'} · booking K7Q2LM ${d[5] ? '✔' : '✖'}`;
    if (d[0] < 10 || d[1] < 20 || d[2] < 30 || !d[3] || !d[4] || !d[5] || d[6] < 7) problems.push('demo data incomplete – run npm run db:seed (or db:reset-demo)');
  } else {
    report.demo = 'not checked (DEMO_MODE=false)';
  }

  // n8n workflows: every Postgres node must call an existing of_*(jsonb) RETURNS jsonb function.
  const queries = n8nQueries();
  const sig = Object.fromEntries(fns.map((r) => [r[0], `${r[1]} -> ${r[2]}`]));
  const badN8n = queries.filter((q) => {
    const m = /^SELECT (of_\w+)\(\$1::jsonb\) AS r;$/.exec(q.query.trim());
    return !m || sig[m[1]] !== 'p jsonb -> jsonb';
  });
  report.n8n = `${queries.length - badN8n.length}/${queries.length} Postgres nodes (${new Set(queries.map((q) => q.query)).size} distinct functions) match the schema`;
  badN8n.forEach((q) => problems.push(`n8n ${q.workflow} › ${q.node}: "${q.query}" does not match an of_*(p jsonb) RETURNS jsonb function`));

  // Ops console: every static SQL statement is PREPAREd (parsed + resolved against the schema, not executed).
  const cq = consoleQueries();
  const script = ['BEGIN;'].concat(cq.map((sql, i) => `PREPARE console_q${i} AS ${sql};`), ['DEALLOCATE ALL;', 'ROLLBACK;']).join('\n');
  const prep = psql(conn, { sql: script });
  report.console = prep.ok ? `${cq.length}/${cq.length} dashboard queries valid` : `INVALID – ${firstError(prep.stderr)}`;
  if (!prep.ok) problems.push(`dashboard SQL incompatible: ${firstError(prep.stderr)}`);

  Object.entries(report).forEach(([k, v]) => log(`  ${k.padEnd(12)} ${v}`));
  if (problems.length) {
    log('FAIL');
    problems.forEach((p) => log(`  ✖ ${p}`));
    return { ok: false, report, problems };
  }
  log('PASS');
  return { ok: true, report, problems };
}

function summary(conn) {
  const [t, f, i] = query(conn, `SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'),
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'of\\_%'),
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public')`)[0];
  log(`\nTables: ${t}\nFunctions: ${f}\nIndexes: ${i}`);
}

function testConnection(conn) {
  log('\nConnection test...');
  const [db, now, rfqs] = query(conn, 'SELECT current_database(), now(), (SELECT count(*) FROM rfqs)')[0];
  log(`  current_database() = ${db}\n  now()              = ${now}\n  count(rfqs)        = ${rfqs}\nPASS`);
}

function sqlTests(conn) {
  log('\nDatabase tests (SQL API, rolled back)...');
  const r = psql(conn, { file: FILES.test });
  const notices = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => (/NOTICE:\s+(.*)$/.exec(l) || [])[1]).filter(Boolean);
  const passed = notices.some((n) => n.startsWith('ALL SQL API TESTS PASSED'));
  if (!r.ok || !passed) {
    log('FAIL');
    throw new StepError('Database tests', rel(FILES.test), firstError(r.stderr) || 'tests did not complete');
  }
  log(`  ${notices.length - 1} test groups\nPASS`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const commands = {
  init() {
    const conn = connect();
    ensureMigrationTable(conn);
    const exp = expected();
    applySchema(conn, applied(conn), exp);
    applyFunctions(conn);
    applyMigrations(conn, applied(conn));
    applySeed(conn, applied(conn));
    const v = verify(conn);
    summary(conn);
    if (!v.ok) throw new StepError('Database verification', null, `${v.problems.length} problem(s) listed above`);
    log('\nNEON DATABASE READY');
  },
  check() {
    const conn = connect();
    testConnection(conn);
    const v = verify(conn);
    summary(conn);
    if (!v.ok) throw new StepError('Database verification', null, `${v.problems.length} problem(s)`);
    log('\nNEON DATABASE READY');
  },
  seed() {
    const conn = connect();
    ensureMigrationTable(conn);
    applySeed(conn, applied(conn));
  },
  'reset-demo'() {
    if (!demoMode()) throw new StepError('db:reset-demo', null, 'refused: DEMO_MODE is not "true"');
    const conn = connect();
    const real = Number(query(conn, 'SELECT (SELECT count(*) FROM agencies WHERE NOT is_demo) + (SELECT count(*) FROM contacts WHERE NOT is_demo AND verification_status = \'VERIFIED\')')[0][0]);
    if (real > 0) throw new StepError('db:reset-demo', null, `refused: ${real} non-demo agencies/verified contacts found – this looks like a real database`);
    process.stdout.write('\nResetting demo data...\n');
    const r = psql(conn, { file: FILES.reset });
    if (!r.ok) { log('FAIL'); throw new StepError('Resetting demo data', rel(FILES.reset), firstError(r.stderr)); }
    ensureMigrationTable(conn);
    record(conn, 'seed_demo', sha(FILES.seed));
    log(`PASS – ${(r.stdout.match(/demo data restored: [^\n]+/) || [''])[0].trim()}`);
  },
  test() {
    const conn = connect();
    testConnection(conn);
    sqlTests(conn);
  },
};

const cmd = process.argv[2];
if (!commands[cmd]) {
  log('usage: node scripts/db.js init|check|seed|reset-demo|test');
  process.exitCode = 2;
} else {
  try {
    commands[cmd]();
  } catch (e) {
    log(`\n✖ ${e.message}`);
    log('Stopped. Nothing after the failing step was applied.');
    process.exitCode = 1;
  }
}
