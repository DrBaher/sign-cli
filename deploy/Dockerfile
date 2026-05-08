# Hosted-demo container for sign-cli.
#
# Builds the CLI from source, then on each container start:
#   1. Wipes the data dir (ephemeral DB).
#   2. Runs deploy/seed-demo.mjs to create a handful of sample requests.
#   3. Starts `sign serve --read-only true --web-demo true` on $PORT.
#   4. Exits after $DEMO_TTL_SECONDS so the platform restarts us with fresh state.
#
# Read-only + rate-limited + no auth token: safe to expose publicly.

FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY fixtures/ ./fixtures/

RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=4000
ENV DEMO_TTL_SECONDS=14400
ENV SIGN_DB_PATH=/app/data/sign.db
ENV SIGN_LOCAL_STORE_DIR=/app/data/store
ENV SIGN_LOCAL_KEY_DIR=/app/data/keys
ENV SIGN_LOCAL_AUTOCOMPLETE=true

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/package.json ./package.json
COPY deploy/seed-demo.mjs ./deploy/seed-demo.mjs
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod +x ./deploy/entrypoint.sh

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/web-demo/ >/dev/null 2>&1 || exit 1

ENTRYPOINT ["./deploy/entrypoint.sh"]
