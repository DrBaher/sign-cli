# Dropbox Sign setup

Onboarding for a new Dropbox Sign account. About 10 minutes end to end.

## Prereqs

- Node 22+
- A Dropbox Sign account with API access enabled.

## 1) Install + configure

```bash
git clone https://github.com/DrBaher/sign-cli.git
cd sign-cli
npm install
cp .env.example .env
```

Edit `.env`:

```env
SIGN_DB_PATH=./data/sign.db
SIGN_PROVIDER=dropbox

DROPBOX_SIGN_API_KEY=your_api_key_here
DROPBOX_SIGN_TEST_MODE=true
DROPBOX_SIGN_CLIENT_ID=your_client_id_for_embedded
```

Set `SIGN_PROVIDER=dropbox` (as shown above) to route commands through Dropbox Sign — otherwise the built-in default is the offline `local` provider. Every command also accepts `--provider dropbox|docusign|signwell|local`; flag wins over env. Every provider-touching command echoes `[sign] resolved provider: <p> (<source>)` to stderr so you never sign against the wrong account by accident.

For production scripts, pass `--strict-provider true` (or set `SIGN_STRICT_PROVIDER=true`) to refuse mismatches between the resolved provider and the request's persisted provider. Catches the "I created the request as `dropbox` but I'm about to sign with `--provider local`" footgun. Error code: `STRICT_PROVIDER_MISMATCH`.

## 2) Build

```bash
npm run build
```

## 3) Optional: start a local webhook receiver

```bash
npm run webhook:listen -- --port 3000 --path /dropbox/callback
```

Listens locally, verifies Dropbox Sign `event_hash` values with your API key, and appends webhook audit events through the existing ingest path. For end-to-end callback setup (tunnel + Dropbox API app config), see [End-to-end callback setup](#end-to-end-callback-setup) below.

## Standard user journey (email signing)

### A) Create request

```bash
sign request create \
  --title "Consent Test" \
  --document ./your.pdf \
  --signer name:You,email:you@gmail.com,order:1 \
  --signer name:Work,email:you@company.com,order:2 \
  --token-ttl-minutes 30
```

### B) Approve (agent permission gate)

```bash
sign approve --request-id <request_id> --token <token1>
sign approve --request-id <request_id> --token <token2>
```

### C) Send

```bash
sign request send --request-id <request_id> --provider dropbox --test-mode true
```

Both `request send` and `request send-embedded` persist the selected provider plus the remote request/envelope ID into SQLite. Dropbox signer `signatureIds` are also persisted when Dropbox returns them. `request show` and `request status` expose those as `request.provider`, `request.provider_request_id`, and `request.signatureIds`.

### D) Track

```bash
sign request status --request-id <request_id>
sign request watch --request-id <request_id> --interval-ms 5000 --fetch-final true
sign audit show --request-id <request_id>
```

`request watch` exit codes:
- `0` — completed
- `2` — declined, rejected, expired, or canceled
- `3` — error or invalid remote status
- `4` — timeout before a terminal status

`--interval-seconds` / `--timeout-seconds` aliases also accepted. Final JSON includes `startedAt`, `elapsedMs`, `lastRemoteStatus`. While polling, stderr prints concise progress lines on the first poll, status changes, and terminal states.

## Embedded signing

See [embedded.md](embedded.md) for the API-driven signing UI flow (HelloSign Embedded JS + per-recipient `sign_url`).

## End-to-end callback setup

### 1) Start the local receiver

```bash
npm run webhook:listen -- --port 3000 --path /dropbox/callback
```

### 2) Expose it with a tunnel

```bash
npx localtunnel --port 3000
```

Use the resulting public URL plus `/dropbox/callback` as your Dropbox Sign account callback URL or API app callback URL.

### 3) Create, approve, and send a request

```bash
sign request create \
  --title "Consent Test" \
  --document ./your.pdf \
  --signer name:Alice,email:alice@example.com,order:1

sign approve --request-id <request_id> --token <token>
sign request send --request-id <request_id> --test-mode true
```

### 4) Watch for completion and fetch the signed PDF

```bash
sign request watch \
  --request-id <request_id> \
  --interval-seconds 5 \
  --fetch-final true \
  --out ./artifacts/<request_id>-signed.pdf
```

### 5) Inspect the local audit trail

```bash
sign audit show --request-id <request_id>
```

## Callback URL / domain rules

- `localhost` is not accepted as embedded app domain.
- Use a public domain/tunnel (e.g. `https://good-ravens-drum.loca.lt`).
- Put that domain in Dropbox Sign API App settings.
- Callback URL can be `https://good-ravens-drum.loca.lt/dropbox/callback`.
- Dropbox Sign sends callbacks as `multipart/form-data` with a `json` field. The local receiver handles `multipart/form-data`, `application/x-www-form-urlencoded`, and raw JSON.

## Troubleshooting

- `Missing parameter: client_id` — opened embedded `sign_url` directly instead of via embedded JS + `clientId`. See [embedded.md](embedded.md).
- `localhost is not a valid domain` — use a public tunnel/domain and register it in the API App.
- `command not found: ngrok` — use localtunnel/cloudflared, or install/configure ngrok with an account+authtoken.

For the full error catalog see [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md).
