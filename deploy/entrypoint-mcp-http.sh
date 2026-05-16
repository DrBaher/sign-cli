#!/bin/sh
# Hosted MCP-over-HTTP entrypoint: wipe → seed → serve → exit-after-TTL.
#
# Same reset-loop mechanism as entrypoint.sh: clean exit after
# $DEMO_TTL_SECONDS so the platform restarts us with fresh seeded state.
# Read-only + bearer-auth: safe to expose to remote MCP clients (Smithery,
# mcp.run, Claude Desktop via fetch).

set -eu

PORT="${PORT:-4000}"
DEMO_TTL_SECONDS="${DEMO_TTL_SECONDS:-14400}"  # 4h
DATA_DIR="$(dirname "${SIGN_DB_PATH:-/app/data/sign.db}")"

# Auth token is optional. Unset = open server (safe for the hosted demo:
# read-only + DB wiped every 4h + only seeded demo data). Set to a strong
# secret if you ever expose a writable MCP HTTP endpoint.
if [ -z "${SIGN_MCP_HTTP_AUTH_TOKEN:-}" ]; then
  echo "[entrypoint-mcp-http] WARN: no SIGN_MCP_HTTP_AUTH_TOKEN — server is OPEN (no auth)" >&2
  AUTH_FLAGS=""
else
  AUTH_FLAGS="--http-auth-token ${SIGN_MCP_HTTP_AUTH_TOKEN}"
fi

echo "[entrypoint-mcp-http] wiping ${DATA_DIR}"
rm -rf "${DATA_DIR}"
mkdir -p "${DATA_DIR}"

echo "[entrypoint-mcp-http] seeding demo data"
node ./deploy/seed-demo.mjs || echo "[entrypoint-mcp-http] seed failed (continuing with empty DB)"

echo "[entrypoint-mcp-http] starting sign mcp serve --http on 0.0.0.0:${PORT} (TTL ${DEMO_TTL_SECONDS}s)"
# shellcheck disable=SC2086
node ./dist/cli.js mcp serve \
  --http true \
  --http-port "${PORT}" \
  --http-bind 0.0.0.0 \
  --http-path /mcp \
  --read-only true ${AUTH_FLAGS} &

SERVE_PID=$!
trap 'kill -TERM "${SERVE_PID}" 2>/dev/null || true' INT TERM

# Background TTL killer: after DEMO_TTL_SECONDS, send TERM so the platform
# restarts us with a fresh seed.
(
  sleep "${DEMO_TTL_SECONDS}"
  echo "[entrypoint-mcp-http] TTL elapsed (${DEMO_TTL_SECONDS}s); shutting down for fresh restart"
  kill -TERM "${SERVE_PID}" 2>/dev/null || true
) &

wait "${SERVE_PID}"
EXIT=$?
echo "[entrypoint-mcp-http] sign mcp serve exited with ${EXIT}"
exit "${EXIT}"
