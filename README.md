# sign CLI MVP

CLI for consent-gated, auditable e-sign workflows with Dropbox Sign and DocuSign.

## What this gives you
- Human approval tokens (single-use, TTL)
- Local append-only audit chain (`hash_prev`, `hash_self`)
- Multi-signer support
- Provider abstraction for send + status + watch + final download
- Dropbox Sign send + status + embedded signing
- DocuSign send + status + final PDF download
- Persisted provider, provider request ID, and signer IDs on requests

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
- `doctor account-check`
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
SIGN_PROVIDER=dropbox

DROPBOX_SIGN_API_KEY=your_api_key_here
DROPBOX_SIGN_TEST_MODE=true
DROPBOX_SIGN_CLIENT_ID=your_client_id_for_embedded

DOCUSIGN_INTEGRATION_KEY=your_integration_key
DOCUSIGN_USER_ID=your_impersonated_user_guid
DOCUSIGN_ACCOUNT_ID=your_account_id
DOCUSIGN_BASE_PATH=https://demo.docusign.net/restapi
DOCUSIGN_PRIVATE_KEY_PATH=./keys/docusign-private.key
```

`SIGN_PROVIDER` defaults to `dropbox`. Every request command that talks to a remote provider also accepts `--provider dropbox|docusign`, and the CLI uses that flag over the env var when both are present.

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

### C) Send
```bash
npm run start -- request send --request-id <request_id> --provider dropbox --test-mode true
```

Both `request send` and `request send-embedded` persist the selected provider plus the remote request/envelope ID into SQLite. Dropbox signer `signatureIds` are also persisted when Dropbox returns them. `request show` and `request status` expose those values as `request.provider`, `request.provider_request_id`, and `request.signatureIds`.

### D) Track
```bash
npm run start -- request status --request-id <request_id>
npm run start -- request watch --request-id <request_id> --interval-ms 5000 --fetch-final true
npm run start -- audit show --request-id <request_id>
```

You can add `--provider docusign` to `request send`, `request status`, `request watch`, and `request fetch-final` when working with DocuSign. Once a request has been sent, the persisted provider is reused for later polling and downloads.

`request watch` exit codes:
- `0`: completed
- `2`: declined, rejected, expired, or canceled
- `3`: error or invalid remote status
- `4`: timeout before a terminal status

`request watch` also accepts `--interval-seconds` and `--timeout-seconds` as aliases for the millisecond flags. The final JSON now includes:
- `startedAt`
- `elapsedMs`
- `lastRemoteStatus`

While polling, stderr prints concise progress lines only on the first poll, status changes, and terminal states.

---

## Embedded signing journey (API-driven signing UI)

Embedded signing is currently supported only for Dropbox Sign. Calling embedded commands with `--provider docusign` returns a clear not-supported error.

### 1) Send embedded request
```bash
npm run start -- request send-embedded \
  --request-id <request_id> \
  --provider dropbox \
  --client-id <dropbox_client_id> \
  --test-mode true
```

The response includes the signer `signatureIds`, and they remain available later through `request show` and `request status`.

### 2) Generate sign URL per signer signature ID
```bash
npm run start -- request sign-url \
  --request-id <request_id> \
  --provider dropbox \
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
- `Embedded signing is not yet supported for DocuSign.`
  - Use `request send`, `request status`, `request watch`, and `request fetch-final` with `--provider docusign`.
- `localhost is not a valid domain`
  - Use a public tunnel/domain and register it in API App.
- `command not found: ngrok`
  - Use localtunnel/cloudflared, or install/configure ngrok account+authtoken.

---

## DocuSign setup

### Agent onboarding (operator/setup checklist)
1. Create a DocuSign app (Integration Key) in the correct account/environment.
2. Enable JWT Grant and configure user impersonation.
3. Generate/download the RSA private key and store it locally (never commit it).
4. Grant consent for the impersonated user for the integration key.
5. Set env vars (below), then run `npm run start -- doctor` and confirm DocuSign fields are present.
6. Run a smoke flow in demo/sandbox: `request create` → `approve` → `request send --provider docusign` → `request watch --provider docusign`.

### User onboarding (daily usage)
1. Keep default provider as Dropbox, or switch default by setting `SIGN_PROVIDER=docusign`.
2. For per-request control, add `--provider docusign` only on DocuSign flows.
3. Create + approve request, then send.
4. Use `request watch` for completion and optional auto-download.

### Required env vars
```env
SIGN_PROVIDER=docusign
DOCUSIGN_INTEGRATION_KEY=your_integration_key
DOCUSIGN_USER_ID=your_impersonated_user_guid
DOCUSIGN_ACCOUNT_ID=your_account_id
DOCUSIGN_BASE_PATH=https://demo.docusign.net/restapi
DOCUSIGN_PRIVATE_KEY_PATH=./keys/docusign-private.key
```

### JWT prerequisites
- Create a DocuSign integration key.
- Configure JWT auth for that integration key.
- Grant consent for the impersonated user.
- Store the RSA private key locally and point `DOCUSIGN_PRIVATE_KEY_PATH` at it.

### Send, watch, and download
```bash
npm run start -- request create \
  --title "DocuSign Consent Test" \
  --document ./your.pdf \
  --signer name:Alice,email:alice@example.com,order:1 \
  --provider docusign

npm run start -- approve --request-id <request_id> --token <token>

npm run start -- request send \
  --request-id <request_id> \
  --provider docusign

npm run start -- request watch \
  --request-id <request_id> \
  --provider docusign \
  --interval-seconds 5 \
  --fetch-final true \
  --out ./artifacts/<request_id>-signed.pdf
```

DocuSign terminal states are normalized into the same watch exit codes as Dropbox Sign: `completed` exits `0`, `declined/rejected/expired/voided` exits `2`, provider errors exit `3`, and timeouts exit `4`.

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
  --interval-seconds 5 \
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


## Account compatibility checks
Use these before onboarding:

```bash
npm run start -- doctor account-check --provider dropbox
npm run start -- doctor account-check --provider docusign
```

This verifies API access for each provider (Dropbox account endpoint, DocuSign JWT+account endpoint) and returns a machine-readable summary.
