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
- `approve`
- `request send`
- `request send-embedded`
- `request sign-url`
- `request status`
- `audit show`
- `webhook verify`
- `webhook ingest`

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
npm run start -- audit show --request-id <request_id>
```

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
- Callback URL can be like:
  - `https://good-ravens-drum.loca.lt/dropbox/callback`

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
