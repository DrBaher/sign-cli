#!/bin/sh
# Hosted-demo entrypoint: wipe → seed → serve → exit-after-TTL.
# Designed for platforms that auto-restart the container (Fly, Railway, Render).
# When we exit cleanly after DEMO_TTL_SECONDS, the platform brings us back with
# a fresh seed — that's the reset mechanism. No persistent disk needed.

set -eu

PORT="${PORT:-4000}"
DEMO_TTL_SECONDS="${DEMO_TTL_SECONDS:-14400}"  # 4h
RATE_LIMIT="${SIGN_DEMO_RATE_LIMIT:-5}"
RATE_BURST="${SIGN_DEMO_RATE_BURST:-20}"
DATA_DIR="$(dirname "${SIGN_DB_PATH:-/app/data/sign.db}")"

echo "[entrypoint] wiping ${DATA_DIR}"
rm -rf "${DATA_DIR}"
mkdir -p "${DATA_DIR}"

echo "[entrypoint] seeding demo data"
node ./deploy/seed-demo.mjs || echo "[entrypoint] seed failed (continuing with empty DB)"

echo "[entrypoint] starting sign serve on 0.0.0.0:${PORT} (TTL ${DEMO_TTL_SECONDS}s)"
node ./dist/cli.js serve \
  --port "${PORT}" \
  --bind 0.0.0.0 \
  --read-only true \
  --web-demo true \
  --rate-limit "${RATE_LIMIT}" \
  --rate-limit-burst "${RATE_BURST}" &

SERVE_PID=$!
trap 'kill -TERM "${SERVE_PID}" 2>/dev/null || true' INT TERM

# Background TTL killer: after DEMO_TTL_SECONDS, send TERM so the platform
# restarts us with a fresh seed.
(
  sleep "${DEMO_TTL_SECONDS}"
  echo "[entrypoint] TTL elapsed (${DEMO_TTL_SECONDS}s); shutting down for fresh restart"
  kill -TERM "${SERVE_PID}" 2>/dev/null || true
) &

wait "${SERVE_PID}"
EXIT=$?
echo "[entrypoint] sign serve exited with ${EXIT}"
exit "${EXIT}"
