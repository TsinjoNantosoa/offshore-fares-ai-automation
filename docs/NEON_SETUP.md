# Neon setup (remote PostgreSQL)

The project's database objects are defined in the repository (single source of truth): `database/schema.sql` → `database/functions.sql` → `database/migrations/V*.sql` → `database/seed.sql` (demo only). The `npm run db:*` commands apply them to any PostgreSQL reachable through **`DATABASE_URL`**, including Neon. They never run `CREATE DATABASE` or `DROP DATABASE`.

## 1. Create a Neon project
In the Neon console: **New project**, pick the region closest to n8n / Render, and keep the default database (`neondb`). Neon runs PostgreSQL 16+; the project was verified on Neon PostgreSQL 18.

## 2. Get DATABASE_URL
**Dashboard → Connect**, then copy the connection string. It already contains `sslmode=require` (and `channel_binding=require`). Keep them: the scripts refuse `sslmode=disable` / `allow`.
- **Pooled** host (`…-pooler…`): fine for the init scripts, n8n and the console.
- **Direct** host (same string without `-pooler`): recommended for long-running admin sessions.

## 3. Local configuration
Put it in `.env`, which is git-ignored and never copied into Docker images:
```
DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require&channel_binding=require
DEMO_MODE=true
```
The value is only read from the environment. The scripts split it into libpq variables, so the password never appears in process arguments, logs or error messages (logs show `user@host…/db`).
Requirements: `psql` (PostgreSQL client 13+) on the PATH, or Docker (the `postgres:16-alpine` image is used automatically).

## 4. Initialise: `npm run db:init`
```
Connecting to Neon...
Connection successful. neondb_owner@ep-xxxx-pooler.…/neondb (sslmode=require, pooled) · PostgreSQL 18.6
Applying schema...      PASS
Applying functions...   PASS
Applying migrations...  PASS
Applying demo seed...   PASS          (only when DEMO_MODE=true)
Database verification...PASS
Tables: 25  Functions: 37  Indexes: 67
NEON DATABASE READY
```
- **Idempotent**: applied versions are recorded in `of_schema_migrations`. A re-run skips the schema and the seed, re-applies the functions (`CREATE OR REPLACE`) and only pending migrations.
- **Never masks an error**: every file runs in a transaction with `ON_ERROR_STOP`, the first failure stops everything and prints the step, the file and the PostgreSQL error. A database that contains some project tables but no migration record is reported as a partial state and left untouched.
- `DEMO_MODE=false`: fictional data is **never** loaded.

## 5. Verify: `npm run db:check`
Checks the connection (`current_database()`, `now()`, `count(rfqs)`), plus:
- the 24 project tables, 37 `of_*` functions, 31 named indexes, `pgcrypto`, PK / FK / UNIQUE / CHECK constraints;
- reference data (20 statuses, 92 transitions, 5 desks);
- demo data when `DEMO_MODE=true` (Apex Travel VIP, John Carter, 30 RFQs, booking K7Q2LM);
- **n8n compatibility**: each of the 34 Postgres nodes of the 18 workflows calls an existing `of_*(p jsonb) RETURNS jsonb` function;
- **dashboard compatibility**: each static query of the ops console is `PREPARE`d against the schema (parsed and resolved, not executed).

Other commands:

| Command | Effect |
|---|---|
| `npm run db:test` | connection test + SQL API tests (17 groups, inside a transaction that is rolled back) |
| `npm run db:seed` | loads the demo dataset once (`DEMO_MODE=true` only) |
| `npm run db:reset-demo` | restores the demo dataset. **Refused** unless `DEMO_MODE=true` **and** the database contains no non-demo agency or verified real contact |

## 6. Configure n8n
Credential **Offshore Fares DB** (type Postgres): host, database, user and password from the Neon string, port 5432, **SSL: require**. With the bundled stack, set the same values in `.env` before `npm run workflows:reimport`, or edit the credential in n8n. Ops console (Render): set `DATABASE_URL` (the console accepts it in place of `PG*`).

## 7. Production security
- **Roles** (recommended, not applied automatically). Create them in the Neon console or with SQL:
  - `offshore_app` (n8n): read/write on tables + `EXECUTE` on the functions. All business writes go through the `of_*` functions.
  - `ops_console` (dashboard): **SELECT only** (`GRANT SELECT ON ALL TABLES IN SCHEMA public` + default privileges, see `docker/postgres-init/00-offshore-fares.sh`).
  - `neondb_owner`: migrations only (`npm run db:init`), never used by the running apps.
- Rotate the password if it was ever shared outside a password manager (Neon → Roles → Reset password), then update `.env`, the n8n credential and Render.
- `DEMO_MODE=false` + `LOAD_DEMO_DATA=false` on the production branch. Use a separate Neon **branch** for demos and tests.
- Enable Neon's IP allow-list for n8n / Render egress IPs if your plan supports it.
- Backups: Neon point-in-time restore (check the retention of your plan).

## 8. Troubleshooting
| Error | Fix |
|---|---|
| `unsupported startup parameter in options` | the pooled endpoint rejects startup options (e.g. `PGOPTIONS`); unset it or use the direct host |
| `DATABASE_URL is not set` | add it to `.env` (or the environment) |
| `sslmode=disable refused` | keep `sslmode=require` |
| `password authentication failed` | the password was reset: copy a fresh string from Neon |
| `partial state, refusing to continue` | some tables exist without a migration record: inspect the database, or start from a fresh Neon branch |
| Timeout on first connection | Neon compute was suspended and is waking up: re-run |
| `psql: command not found` | install the PostgreSQL client, or start Docker (fallback image) |
