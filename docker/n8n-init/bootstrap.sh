#!/bin/sh
# One-shot n8n bootstrap: credentials from .env -> encrypted n8n credentials,
# workflows from ./n8n -> imported with fixed IDs and published.
# Skipped on later starts unless N8N_FORCE_REIMPORT=true (protects edits made in the n8n UI).
set -eu

# Validate the configuration on every start (fails fast in production with a clear message).
node /offshore-init/make-credentials.js --validate-only

MARKER=/home/node/.n8n/.offshore-fares-imported
if [ -f "$MARKER" ] && [ "${N8N_FORCE_REIMPORT:-false}" != "true" ]; then
  echo "[n8n-init] already imported ($(cat "$MARKER")) – set N8N_FORCE_REIMPORT=true to re-import"
  exit 0
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
node /offshore-init/make-credentials.js "$TMP"
n8n import:credentials --input="$TMP"
rm -f "$TMP"

echo "[n8n-init] importing workflows"
n8n import:workflow --separate --input=/offshore-workflows

# Each publish boots the n8n CLI: run them in parallel batches of 6.
n=0
for f in /offshore-workflows/WF*.json; do
  id=$(node -e "process.stdout.write(require('$f').id)")
  name=$(basename "$f" .json)
  (n8n publish:workflow --id="$id" >/dev/null 2>&1 && echo "[n8n-init] published $name ($id)" || echo "[n8n-init] ERROR publishing $name") &
  n=$((n + 1))
  if [ $((n % 6)) -eq 0 ]; then wait; fi
done
wait

date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
echo "[n8n-init] done"
