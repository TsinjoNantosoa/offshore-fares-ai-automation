# Migrations

`schema.sql` + `functions.sql` are the **baseline (V001)** and are applied automatically on the first start of an empty database (`docker/postgres-init`).

Changes after go-live are **forward-only** files in this folder:

```
V002__add_agency_language.sql
V003__...
```

Rules:
- one transaction per file (`BEGIN; … COMMIT;`), idempotent where possible (`IF NOT EXISTS`);
- `functions.sql` uses `CREATE OR REPLACE`, so it can be re-applied after any function change:
  `docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /offshore/database/functions.sql'`;
- a new RFQ status or transition must be added to **both** `schema.sql` (seed rows) and `lib/stateMachine.js`. `tests/unit/router-and-schema.test.js` fails if they differ;
- in production, use a migration runner (Flyway, sqitch or dbmate) with these files.
