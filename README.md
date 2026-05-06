# sign CLI MVP

CLI for consent-gated, auditable e-sign workflows with Dropbox Sign.

## What this gives you
- Human approval tokens (single-use, TTL)
- Local append-only audit chain (`hash_prev`, `hash_self`)
- Multi-signer support
- Dropbox Sign send + status
- Embedded signing support

## Commands
- `request create`
- `request run-email` (one command: create + auto-approve + send email)
- `approve`
- `request send`
- `request send-embedded`
- `request sign-url`
- `request status`
- `request watch`
- `request launch-embedded`
- `request fetch-final`
- `doctor`
- `audit show`
- `webhook verify`
- `webhook ingest`
- `webhook listen`

---

## Onboarding for a new Dropbox user (10 min)

## 1) Prereqs
- Node 22+
- Dropbox Sign account with API access

## 2) Install
```bash
git clone https://github.com/DrBaher/cli-digital-signature-mvp.git
cd cli-digital-signature-mvp
npm install
cp .env.example .env
```

## 3) Configure `.env`
```env
SIGN_DB_PATH=./data/sign.db
DROPBOX_SIGN_API_KEY=your_api_key_here
DROPBOX_SIGN_TEST_MODE=true
DROPBOX_SIGN_CLIENT_ID=your_client_id_for_embedded
```

## 4) Build
```bash
npm run build
```

## 5) Optional: start a local webhook receiver
```bash
npm run webhook:listen -- --port 3000 --path /dropbox/callback
```

This listens locally, verifies Dropbox Sign `event_hash` values with your API key, and appends webhook audit events through the existing ingest path.

---

## Standard user journey (email signing)

### A) Create request
```bash
npm run start -- request create \
  --title "Consent Test" \
  --document ./your.pdf \
  --signer name:You,email:you@gmail.com,order:1 \
  --signer name:Work,email:you@company.com,order:2 \
  --token-ttl-minutes 30
```

### B) Approve (agent permission gate)
```bash
npm run start -- approve --request-id <request_id> --token <token1>
npm run start -- approve --request-id <request_id> --token <token2>
```

### C) Send via Dropbox
```bash
npm run start -- request send --request-id <request_id> --test-mode true
```

### D) Track
```bash
npm run start -- request status --request-id <request_id>
npm run start -- request watch --request-id <request_id> --interval-ms 5000 --fetch-final true
npm run start -- audit show --request-id <request_id>
```

`request watch` exit codes:
- `0`: completed
- `2`: declined, rejected, expired, or canceled
- `3`: error or invalid remote status
- `4`: timeout before a terminal status

---

## Embedded signing journey (API-driven signing UI)

### 1) Send embedded request
```bash
npm run start -- request send-embedded \
  --request-id <request_id> \
  --client-id <dropbox_client_id> \
  --test-mode true
```

### 2) Generate sign URL per signer signature ID
```bash
npm run start -- request sign-url \
  --request-id <request_id> \
  --signature-id <signature_id>
```

### 3) Open with HelloSign Embedded JS
You must open `sign_url` through the embedded SDK with `clientId`.
Directly opening `sign_url` can fail with `Missing parameter: client_id`.

---

## Callback URL / domain rules
- `localhost` is not accepted as embedded app domain.
- Use a public domain/tunnel (e.g. `https://good-ravens-drum.loca.lt`).
- Put that domain in Dropbox Sign API App settings.
- Callback URL can be like `https://good-ravens-drum.loca.lt/dropbox/callback`.
- Dropbox Sign sends callbacks as `multipart/form-data` with a `json` field. The local receiver handles `multipart/form-data`, `application/x-www-form-urlencoded`, and raw JSON.

---

## Troubleshooting
- `Missing parameter: client_id`
  - You opened embedded `sign_url` directly instead of via embedded JS + `clientId`.
- `localhost is not a valid domain`
  - Use a public tunnel/domain and register it in API App.
- `command not found: ngrok`
  - Use localtunnel/cloudflared, or install/configure ngrok account+authtoken.

---

## Security notes
- Never commit `.env` or API keys.
- Rotate keys if shared in chat/logs.
- Keep test mode on during development.


## Detailed embedded setup
See `EMBEDDED_SETUP.md` for Dropbox-side setup (API App, domain, callback URL, and troubleshooting).

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
npm run start -- request create \
  --title "Consent Test" \
  --document ./your.pdf \
  --signer name:Alice,email:alice@example.com,order:1

npm run start -- approve --request-id <request_id> --token <token>
npm run start -- request send --request-id <request_id> --test-mode true
```

### 4) Watch for completion and fetch the signed PDF
```bash
npm run start -- request watch \
  --request-id <request_id> \
  --interval-ms 5000 \
  --fetch-final true \
  --out ./artifacts/<request_id>-signed.pdf
```

### 5) Inspect the local audit trail
```bash
npm run start -- audit show --request-id <request_id>
```

## Seamless mode (recommended)

1. `npm run start -- doctor`
2. `request create` + `approve` tokens
3. `request send-embedded`
4. `request launch-embedded` (opens signer UI-ready HTML)
5. `webhook listen`
6. `request watch`
