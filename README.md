# sign-cli

CLI for consent-gated, auditable e-sign workflows with Dropbox Sign, DocuSign, SignWell, and a built-in local provider.

## Quick start

No accounts? No keys? No clone? Just run the demo:
```bash
npx sign-cli demo
```
or download the standalone binary from the [GitHub Releases page](https://github.com/DrBaher/sign-cli/releases) and run `./sign-linux-x64 demo`. See [DISTRIBUTION.md](./DISTRIBUTION.md) for all the install options.

If you've cloned the repo:
```bash
npm install && npm run build
node dist/cli.js demo
```
`sign demo` runs the entire pipeline end-to-end against a built-in **local** provider — create + approve + send + watch + fetch-final + PKCS#7 inspect + audit verify + bundle export — with no signups and no API keys. The signed PDF it produces is a real PAdES-style PDF signed by a self-issued cert, so `request verify-signed-pdf` validates the full chain.

When you're ready to wire up a real provider:
```bash
node dist/cli.js init
node dist/cli.js doctor providers
```
`sign init` walks you through provider selection and writes a `.env`. `doctor providers` confirms it's wired up. See [ONBOARDING.md](./ONBOARDING.md) for the longer path.

## What this gives you
- Human approval tokens (single-use, TTL)
- Local append-only audit chain (`hash_prev`, `hash_self`) with `audit verify`
- Multi-signer support
- Built-in `--provider local` that simulates the entire flow with no API keys, plus a self-signed PAdES PDF signer so `request verify-signed-pdf` validates a real chain
- Production hardening: input validation (path-traversal/email/return-url/sizes), secret redaction in errors and HTTP debug logs, idempotent `request send` (refuses to double-send unless `--force true`), `db backup` / `db verify` (SQLite WAL mode), and `--verbose` HTTP tracing with header redaction
- Provider abstraction for send + status + watch + final download + cancel + remind
- Multi-document requests (`--document` repeatable on `request create` / `run-email` / `bulk`)
- CSV-driven bulk send (`request bulk --csv`)
- Interactive `init` wizard that writes `.env`
- Dropbox Sign / DocuSign / SignWell — email send, embedded signing, and webhook ingest (DocuSign embedded uses `clientUserId` + recipient view)
- Provider capability matrix via `doctor providers`
- PDF signature inspection (`request verify-signed-pdf`) — parses `/ByteRange`, recomputes the digest, extracts X.509 signer cert
- RFC 3161 timestamping (`audit timestamp`) — anchors the audit head against a public TSA
- Tamper-evident bundle export (`audit export`) — writes `audit.json` + `signed.pdf` + `audit.tsr` + `manifest.json`
- HTTP retry with `Retry-After`-aware 429 handling on every provider call
- Structured logging for `request watch` (`--log json` / `--log human`)
- Live SignWell smoke test (`smoke signwell` / `scripts/smoke-signwell.sh`)
- Persisted provider, provider request ID, and signer IDs on requests

For an end-to-end onboarding bundle see [ONBOARDING.md](./ONBOARDING.md), [PROVIDER_SELECTION.md](./PROVIDER_SELECTION.md), [CHECKLIST.md](./CHECKLIST.md), and [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Commands
- `request create`
- `request run-email` (one command: create + auto-approve + send email)
- `approve`
- `request send`
- `request send-embedded` (Dropbox Sign / SignWell)
- `request sign-url` (Dropbox Sign / SignWell)
- `request status`
- `request watch`
- `request launch-embedded` (Dropbox Sign / SignWell)
- `request from-template` (provider templates: Dropbox/DocuSign/SignWell)
- `request fetch-final`
- `request remind` (Dropbox / DocuSign / SignWell)
- `request cancel` (Dropbox cancel / DocuSign void / SignWell delete; requires `--yes true`)
- `request bulk --csv` (one request per CSV row; `--document` repeatable)
- `request list` (local SQLite; filterable by `--provider` and `--status`)
- `request show`
- `init` (interactive `.env` wizard)
- `smoke signwell` (live SignWell smoke test; no-ops without `SIGNWELL_API_KEY`)
- `doctor`
- `doctor account-check`
- `doctor providers` (capability + config matrix)
- `audit show`
- `audit verify` (walks `hash_prev`/`hash_self` chain; exits 3 on tamper)
- `audit timestamp` (RFC 3161 — issues + verifies a TSA token over the chain head)
- `audit export` (signed PDF + audit JSON + TSR + manifest with sha256s)
- `request verify-signed-pdf` (parses `/ByteRange`, recomputes digest, extracts signer cert)
- `webhook verify [--provider dropbox|signwell]`
- `webhook ingest [--provider dropbox|signwell]`
- `webhook listen [--provider dropbox|signwell]`

---

## Onboarding for a new Dropbox user (10 min)

## 1) Prereqs
- Node 22+
- Dropbox Sign account with API access

## 2) Install
```bash
git clone https://github.com/DrBaher/sign-cli.git
cd sign-cli
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

SIGNWELL_API_KEY=your_signwell_api_key
SIGNWELL_BASE_URL=https://www.signwell.com/api/v1
SIGNWELL_TEST_MODE=true

DOCUSIGN_INTEGRATION_KEY=your_integration_key
DOCUSIGN_USER_ID=your_impersonated_user_guid
DOCUSIGN_ACCOUNT_ID=your_account_id
DOCUSIGN_BASE_PATH=https://demo.docusign.net/restapi
DOCUSIGN_PRIVATE_KEY_PATH=./keys/docusign-private.key
```

`SIGN_PROVIDER` defaults to `dropbox`. Every request command that talks to a remote provider also accepts `--provider dropbox|docusign|signwell`, and the CLI uses that flag over the env var when both are present.

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

You can add `--provider docusign` or `--provider signwell` to `request send`, `request status`, `request watch`, and `request fetch-final` when working with those providers. Once a request has been sent, the persisted provider is reused for later polling and downloads.

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

Embedded signing is supported across all three providers:
- Dropbox Sign — HelloSign Embedded JS (requires `--client-id`)
- SignWell — iframe over per-recipient `embedded_signing_url`
- DocuSign — recipient view (`clientUserId` is set when sending via `send-embedded`; `sign-url` and `launch-embedded` require `--return-url`)

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
- `DocuSign embedded signing requires --return-url.`
  - DocuSign's recipient view requires a return URL the user is bounced back to after signing. Pass `--return-url https://...` to `request sign-url`/`request launch-embedded`.
- `SignWell document <id> did not return an embedded signing URL for recipient <id>.`
  - The document was sent via `request send` instead of `request send-embedded` for SignWell. Re-run with `request send-embedded --provider signwell`.
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

## SignWell setup

### Agent onboarding (operator/setup checklist)
1. Create a SignWell API key from `Settings -> API`.
2. Store it locally as `SIGNWELL_API_KEY` and never commit it.
3. Optionally override `SIGNWELL_BASE_URL`; otherwise the CLI uses `https://www.signwell.com/api/v1`.
4. Keep `SIGNWELL_TEST_MODE=true` while validating the integration.
5. Run `npm run start -- doctor` and confirm the SignWell env fields are present.
6. Run `npm run start -- doctor account-check --provider signwell`.
7. Run a smoke flow: `request create` → `approve` → `request send --provider signwell` → `request watch --provider signwell`.

### User onboarding (daily usage)
1. Set `SIGN_PROVIDER=signwell` to make SignWell the default provider, or use `--provider signwell` per command.
2. Create + approve the request as usual.
3. Send the request with SignWell.
4. Use `request watch` or `request fetch-final` to complete the workflow.

### Required env vars
```env
SIGN_PROVIDER=signwell
SIGNWELL_API_KEY=your_signwell_api_key
SIGNWELL_BASE_URL=https://www.signwell.com/api/v1
SIGNWELL_TEST_MODE=true
```

### Send, watch, and download
```bash
npm run start -- request create \
  --title "SignWell Consent Test" \
  --document ./your.pdf \
  --signer name:Alice,email:alice@example.com,order:1 \
  --provider signwell

npm run start -- approve --request-id <request_id> --token <token>

npm run start -- request send \
  --request-id <request_id> \
  --provider signwell \
  --test-mode true

npm run start -- request watch \
  --request-id <request_id> \
  --provider signwell \
  --interval-seconds 5 \
  --fetch-final true \
  --out ./artifacts/<request_id>-signed.pdf
```

SignWell terminal states are normalized into the same watch exit codes as the other providers: `completed` exits `0`, `declined/expired/canceled` exits `2`, `bounced/error` exits `3`, and timeouts exit `4`.

See [SIGNWELL_SETUP.md](./SIGNWELL_SETUP.md) for the full setup and troubleshooting guide.

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


## Templates

Reuse a template you defined in your provider's dashboard, no PDF upload required:

```bash
node dist/cli.js request from-template \
  --template-id tmpl_abc \
  --provider dropbox \
  --signer role:Buyer,name:Alice,email:alice@example.com,order:1 \
  --signer role:Seller,name:Bob,email:bob@example.com,order:2 \
  --prefill name:purchase_price,value:1000 \
  --auto-approve true

node dist/cli.js request send --request-id <id> --provider dropbox --test-mode true
```

- `--template-id` is the template identifier from the provider dashboard.
- Each `--signer` must include `role:<roleName>` matching a template role/placeholder.
- `--prefill name:K,value:V[,signer:N]` populates template fields. DocuSign maps prefills to per-signer text tabs (use `signer:N` to scope); Dropbox uses `custom_fields`; SignWell uses `placeholders`.
- The request stores `template_id` + `prefills_json`. `request send` and `request send-embedded` automatically route to the provider's template send endpoint instead of uploading a document.
- `--template-id` and `--document` cannot be combined on the same request.

## Field placement

By default the CLI lets the provider auto-place a signature page at the end of the document. For real contracts you usually need each signature, date, or text field on a specific spot. Pass `--field` (repeatable) on `request create` / `run-email`:

```bash
node dist/cli.js request create \
  --title "NDA" \
  --document ./contract.pdf \
  --signer name:Alice,email:alice@example.com,order:1 \
  --field signer:1,page:1,x:100,y:200,type:signature \
  --field signer:1,page:1,x:100,y:240,type:date \
  --provider dropbox
```

Field spec keys:
- `signer:<order>` — required; matches a `--signer order:N`.
- `doc:<index>` — 0-based document index (defaults to 0). Use with multi-doc requests.
- `type:<signature|initials|date|text|name|email>` — defaults to `signature`.
- `page:<n>` `x:<pt>` `y:<pt>` — coordinate placement (required unless `anchor:` is given).
- `width:<pt>` `height:<pt>` — optional; sensible defaults applied.
- `required:true|false` — defaults to true.
- `anchor:"text"` — DocuSign-only anchor strings (Dropbox/SignWell return a clear error). Optional `x-offset:<n>` / `y-offset:<n>` / `anchor-units:pixels|inches|mms|cms|points`.

The fields are persisted on the request and forwarded to the provider at send time:
- Dropbox Sign — `form_fields_per_document`
- DocuSign — per-signer `tabs` (`signHereTabs`, `dateSignedTabs`, etc.) with anchor or coordinate
- SignWell — `files[].fields` keyed by recipient_id

## Bulk send

Drive a CSV of `name,email` columns to send one request per row:

```bash
node dist/cli.js request bulk \
  --csv ./fixtures/sample-bulk-signers.csv \
  --document ./contract.pdf \
  --provider dropbox \
  --title "Q2 NDA for {{email}}" \
  --test-mode true
```

Each row becomes its own request with `autoApprove: true`, and the title template supports `{{email}}`, `{{name}}`, and `{{row}}`. The exit code is `3` if any row failed; the JSON output lists per-row results.

## Reminders

```bash
# Dropbox Sign requires --email <signer@example.com>; DocuSign and SignWell don't.
node dist/cli.js request remind --request-id <id> --email signer@example.com
```

## Trust beyond the provider

The CLI doesn't just ask the provider "did this get signed?" — it also gives you tooling to verify
the result independently of the provider:

```bash
# Inspect the embedded PKCS#7 signature in the downloaded signed PDF.
node dist/cli.js request verify-signed-pdf --request-id <id>

# Anchor the audit head against a public RFC 3161 TSA (digicert by default).
node dist/cli.js audit timestamp --request-id <id>

# Bundle audit JSON + signed PDF + TSA token + sha256 manifest for archival.
node dist/cli.js audit export --request-id <id> --out ./bundle/
```

`audit verify` walks the local hash chain. `request verify-signed-pdf` recomputes the SHA-256
over the `/ByteRange` of the signed PDF and compares it to the `messageDigest` in the embedded
PKCS#7 — exit code 3 if anything was modified after signing. `audit timestamp` issues a TimeStamp
token from a TSA so the archive proves "the chain looked like this at time T."

## Account compatibility checks
Use these before onboarding:

```bash
npm run start -- doctor account-check --provider dropbox
npm run start -- doctor account-check --provider docusign
npm run start -- doctor account-check --provider signwell
```

This verifies API access for each provider (Dropbox account endpoint, DocuSign JWT+account endpoint, SignWell `/me` endpoint) and returns a machine-readable summary.
