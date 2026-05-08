# Hosted demo

Self-contained deploy for a public, read-only `sign-cli` demo. Goal: someone
with no Node, no API keys, and 10 seconds of attention can click a link and
poke the audit chain.

## What ships

- `Dockerfile` — Node 22 alpine, multi-stage build of the CLI.
- `seed-demo.mjs` — creates 4 sample requests (NDA, SoW, vendor DPA, offer
  letter) with varied signer counts; auto-completes one so the chain has a
  signed PDF.
- `entrypoint.sh` — wipes `/app/data`, re-seeds, starts
  `sign serve --read-only true --web-demo true --rate-limit 5
  --rate-limit-burst 20`, then exits after `DEMO_TTL_SECONDS` so the
  platform restarts us with fresh state.
- `fly.toml` / `render.yaml` / `railway.toml` — minimal configs for the
  three free-ish PaaS targets we test against.
- `docker-compose.yml` — local sanity check.

## Why read-only

The demo URL is public. Without `--read-only true`, anyone could create
requests, sign them, and burn the disk quota. Read-only blocks every
mutating endpoint with `403 FORBIDDEN_READ_ONLY`; visitors can still:

- list the seeded inbox (`/v1/signer/list`)
- fetch a request snapshot (`/v1/request/show`)
- inspect the audit chain (`/v1/audit/verify`)
- watch a request stream (`/v1/request/watch`)

If you want a writable demo for an internal audience, drop
`--read-only true` from `entrypoint.sh` and add `--auth-token` so it isn't
open to the world.

## How the reset works

There's no persistent volume. On every container start `entrypoint.sh`
deletes the data dir and re-runs `seed-demo.mjs`. We force a restart on a
cadence by `kill -TERM`-ing the serve process after `DEMO_TTL_SECONDS`
(default 4h). The platform's restart policy brings us back; the next start
re-seeds.

This also means: any state a visitor *could* mutate (none, given
`--read-only`) would vanish at next restart. Safe by construction.

## Local sanity check

```bash
docker compose -f deploy/docker-compose.yml up --build
open http://localhost:4000/web-demo/
```

Hit Ctrl-C, `docker compose down`, and `up` again to confirm the reset
loop produces a fresh DB with the same seeded titles.

## Deploy: Fly.io

```bash
cd deploy
fly launch --copy-config --no-deploy --name sign-cli-demo
fly deploy
fly open
```

Free tier: 1 shared-cpu-1x machine, auto-stops on idle. The auto-stop
itself is part of the reset — first request after a sleep wakes us
(cold start ~5s), entrypoint re-seeds, then we run until the next idle.

## Deploy: Render

1. Push this repo to GitHub.
2. Render dashboard → **New** → **Blueprint** → point at
   `deploy/render.yaml`.
3. The blueprint is configured for the free plan. Free instances sleep
   after 15min idle; first wake triggers a re-seed.

## Deploy: Railway

```bash
cd deploy
railway init
railway up
```

Railway respects `railway.toml`; `entrypoint.sh` will pick up Railway's
`PORT` env var automatically.

## Deploy: anywhere else

The container is a vanilla Node 22 image listening on `$PORT`. Cloud Run,
Heroku, Koyeb, DigitalOcean App Platform — anything that runs a Docker
image with restart-on-exit will work. Tune `DEMO_TTL_SECONDS` and the
rate-limit env vars to taste.

## Tuning knobs

| Env var                | Default | What it does                                         |
| ---------------------- | ------- | ---------------------------------------------------- |
| `PORT`                 | 4000    | HTTP port                                            |
| `DEMO_TTL_SECONDS`     | 14400   | Seconds before the container voluntarily exits       |
| `SIGN_DEMO_RATE_LIMIT` | 5       | Tokens/sec per IP for `/v1/*` requests               |
| `SIGN_DEMO_RATE_BURST` | 20      | Burst capacity per IP                                |
| `SIGN_DB_PATH`         | /app/data/sign.db | Where the SQLite DB lives (gets wiped each start) |

## What it doesn't do

- **No HTTPS termination.** All four target platforms terminate TLS for
  us. If you self-host, front it with caddy/traefik.
- **No persistent audit chain.** That's a feature for the demo; for a
  real deploy, mount a volume at `/app/data` and drop the `rm -rf` from
  `entrypoint.sh`.
- **No real PAdES signatures.** The seed creates synthetic PDFs; a tour
  of the receipt-bundle flow needs the CLI locally.
