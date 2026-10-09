'use strict';
/**
 * psql runner for remote PostgreSQL (Neon) driven by DATABASE_URL.
 *
 * - The connection string is split into libpq environment variables (PGHOST, PGPASSWORD…),
 *   so the password never appears in process arguments, logs or error messages.
 * - SSL is never disabled: sslmode / channel_binding from DATABASE_URL are kept
 *   (sslmode defaults to "require" when absent).
 * - Uses the local `psql` client, or the postgres:16-alpine Docker image as a fallback.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { env, ROOT } = require('./ops');

function parseDatabaseUrl(raw) {
  if (!raw) throw new Error('DATABASE_URL is not set (put it in .env or the environment)');
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('DATABASE_URL is not a valid postgresql:// URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL must start with postgresql://');
  const sslmode = u.searchParams.get('sslmode') || 'require';
  if (sslmode === 'disable' || sslmode === 'allow') throw new Error(`sslmode=${sslmode} refused: SSL is mandatory for remote databases`);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    PGSSLMODE: sslmode,
    PGCHANNELBINDING: u.searchParams.get('channel_binding') || 'prefer',
    PGAPPNAME: 'offshore-fares-db-tools',
    PGCONNECT_TIMEOUT: '20',
  };
}

/** Safe description for logs: host / database / user, never the password. */
function describe(conn) {
  return `${conn.PGUSER}@${conn.PGHOST.replace(/^([^.]+)\..*$/, '$1.…')}/${conn.PGDATABASE} (sslmode=${conn.PGSSLMODE}${conn.PGHOST.includes('-pooler') ? ', pooled' : ''})`;
}

let client = null;
function psqlClient() {
  if (client) return client;
  const local = spawnSync('psql', ['--version'], { encoding: 'utf8', shell: false });
  if (!local.error && local.status === 0) client = { cmd: 'psql', docker: false };
  else client = { cmd: 'docker', docker: true };
  return client;
}

function redact(text, conn) {
  let out = String(text || '');
  if (conn && conn.PGPASSWORD) out = out.split(conn.PGPASSWORD).join('[REDACTED]');
  return out.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgresql://[REDACTED]');
}

/**
 * Run psql. `input` = { file } (absolute path) or { sql }.
 * Returns { ok, stdout, stderr } – outputs are redacted.
 */
function psql(conn, input, opts) {
  const o = opts || {};
  const c = psqlClient();
  const base = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off'];
  if (o.tuplesOnly) base.push('-A', '-t', '-F', '\t');
  if (o.singleTransaction) base.push('--single-transaction');
  const childEnv = Object.assign({}, process.env, conn, { LC_MESSAGES: 'C', LANG: 'C', PGCLIENTENCODING: 'UTF8' });
  delete childEnv.DATABASE_URL;
  let args;
  if (c.docker) {
    const envFlags = Object.keys(conn).concat(['PGCLIENTENCODING']).flatMap((k) => ['-e', k]);
    const mount = ['-v', `${ROOT}:/work:ro`, '-w', '/work'];
    const fileArg = input.file ? ['-f', `/work/${path.relative(ROOT, input.file).replace(/\\/g, '/')}`] : ['-c', input.sql];
    args = ['run', '--rm', '-i'].concat(envFlags, mount, ['postgres:16-alpine', 'psql'], base, fileArg);
  } else {
    args = base.concat(input.file ? ['-f', input.file] : ['-c', input.sql]);
  }
  const r = spawnSync(c.cmd, args, { cwd: ROOT, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false });
  if (r.error) return { ok: false, stdout: '', stderr: redact(r.error.message, conn) };
  return { ok: r.status === 0, stdout: redact(r.stdout, conn), stderr: redact(r.stderr, conn) };
}

/** Run a query and return rows as arrays of strings (tab separated). */
function query(conn, sql) {
  const r = psql(conn, { sql }, { tuplesOnly: true });
  if (!r.ok) throw new Error(firstError(r.stderr) || 'query failed');
  // psql on Windows ends lines with CRLF: strip it so names compare exactly.
  return r.stdout.split(/\r?\n/).filter((l) => l.length).map((l) => l.split('\t').map((c) => c.trim()));
}

function firstError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).filter((l) => l.trim() && !/NOTICE:/.test(l));
  const idx = lines.findIndex((l) => /ERROR|FATAL|could not|error:/i.test(l));
  return idx === -1 ? lines.slice(0, 3).join(' ') : lines.slice(idx, idx + 3).join(' ').replace(/\s+/g, ' ');
}

function connection() {
  const e = env();
  return parseDatabaseUrl(e.DATABASE_URL);
}

module.exports = { parseDatabaseUrl, describe, psql, query, firstError, connection, psqlClient, redact };
