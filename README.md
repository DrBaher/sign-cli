# sign CLI MVP

Local-testable Node.js TypeScript CLI for simple signing request orchestration with SQLite persistence, approval tokens, append-only audit logs, and Dropbox Sign integration hooks.

## Features

- Commands: `sign request create`, `sign approve`, `sign request send`, `sign request status`, `sign audit show`
- SQLite tables: `requests`, `approvals`, `audit_events`, `artifacts`
- Single-use approval tokens with TTL and request/document hash binding
- Append-only audit events with `hash_prev` and `hash_self`
- Multi-signer support via repeated `--signer`
- Dropbox Sign integration through `@dropbox/sign` with `test_mode`
- Webhook verification and sample payload ingestion
- Basic tests for token replay, expiry, and signer parsing

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env values:

```bash
cp .env.example .env
```

3. Set environment variables as needed:

- `SIGN_DB_PATH`: SQLite database path. Default: `./data/sign.db`
- `DROPBOX_SIGN_API_KEY`: required for `sign request send`, `sign request status`, `sign webhook verify`, `sign webhook ingest`
- `DROPBOX_SIGN_TEST_MODE`: `1` or `true` to send in Dropbox Sign test mode

## Scripts

- `npm run build`
- `npm run start -- <command>`
- `npm test`

## Quick local test flow

Build:

```bash
npm run build
```

Create a request with two signers:

```bash
npm run start -- request create \
  --title "MSA Demo" \
  --document ./fixtures/sample-contract.txt \
  --signer name:Alice,email:alice@example.com,order:1 \
  --signer name:Bob,email:bob@example.com,order:2 \
  --token-ttl-minutes 30
```

Approve using one returned token:

```bash
npm run start -- approve \
  --request-id <request_id> \
  --token <token>
```

Show audit chain:

```bash
npm run start -- audit show --request-id <request_id>
```

Send to Dropbox Sign in test mode:

```bash
npm run start -- request send --request-id <request_id> --test-mode true
```

Check Dropbox Sign status:

```bash
npm run start -- request status --request-id <request_id>
```

## Webhook utilities

Verify a callback payload file:

```bash
npm run start -- webhook verify --payload-file ./fixtures/sample-webhook.json
```

Ingest a sample callback payload file into the local audit trail:

```bash
npm run start -- webhook ingest \
  --payload-file ./fixtures/sample-webhook.json \
  --request-id <request_id>
```

Dropbox Sign sends callbacks as `multipart/form-data` with a `json` field. The CLI accepts either the raw event JSON or a wrapper object such as:

```json
{
  "json": "{\"event\":{\"event_type\":\"signature_request_sent\",\"event_time\":\"1669926463\",\"event_hash\":\"...\"}}"
}
```

Verification follows the Dropbox Sign event hash rule: HMAC-SHA256 of `event_time + event_type` using your API key.

## Example commands

```bash
npm run start -- request create --title "Offer Letter" --document ./fixtures/sample-contract.txt --signer name:Legal,email:legal@example.com,order:1
npm run start -- approve --request-id req_123 --token deadbeef
npm run start -- request send --request-id req_123 --test-mode true
npm run start -- request status --request-id req_123
npm run start -- audit show --request-id req_123
```

## Notes

- `sign request send` and `sign request status` fail with a clear error if `DROPBOX_SIGN_API_KEY` is missing.
- The SDK is loaded dynamically, so local create/approve/audit/test flows work even before Dropbox Sign credentials are configured.
- The project uses Node's built-in `node:sqlite` and a small local build step based on `node:module.stripTypeScriptTypes`.

## Dropbox Sign references

- SDK: https://www.npmjs.com/package/%40dropbox/sign
- Node SDK repo: https://github.com/hellosign/dropbox-sign-node
- Webhook docs: https://developers.hellosign.com/docs/guides/events-and-callbacks/walkthrough
