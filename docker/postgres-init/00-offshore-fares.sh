#!/bin/sh
# Runs once, on the first start of an empty PostgreSQL volume.
set -eu

psql_app() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"; }

echo "[offshore-fares] creating n8n database"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE DATABASE n8n;"

echo "[offshore-fares] applying schema and API functions"
psql_app -f /offshore/database/schema.sql
psql_app -f /offshore/database/functions.sql

if [ "${LOAD_DEMO_DATA:-true}" = "true" ]; then
  echo "[offshore-fares] loading DEMO data (fictional agencies, contacts and RFQs)"
  psql_app -f /offshore/database/seed.sql
fi

echo "[offshore-fares] creating read-only role for the ops console"
psql_app -v console_password="$CONSOLE_DB_PASSWORD" -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE ops_console LOGIN PASSWORD :'console_password';
GRANT CONNECT ON DATABASE :"dbname" TO ops_console;
GRANT USAGE ON SCHEMA public TO ops_console;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ops_console;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ops_console;
SQL
echo "[offshore-fares] database ready"
