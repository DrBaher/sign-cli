#!/usr/bin/env bash
set -euo pipefail

# Live SignWell smoke test. Skipped when SIGNWELL_API_KEY is not set,
# so it can be wired into CI safely with no real credentials present.

if [[ -z "${SIGNWELL_API_KEY:-}" ]]; then
  echo "[smoke-signwell] SIGNWELL_API_KEY not set; skipping." >&2
  exit 0
fi

DOCUMENT_PATH="${1:-${SIGNWELL_SMOKE_DOCUMENT:-./fixtures/sample-contract.txt}}"

if [[ ! -f "$DOCUMENT_PATH" ]]; then
  echo "[smoke-signwell] document not found at $DOCUMENT_PATH" >&2
  exit 1
fi

echo "[smoke-signwell] building project"
npm run build --silent

echo "[smoke-signwell] doctor account-check --provider signwell"
node dist/cli.js doctor account-check --provider signwell

echo "[smoke-signwell] smoke signwell --document $DOCUMENT_PATH"
node dist/cli.js smoke signwell --document "$DOCUMENT_PATH"
