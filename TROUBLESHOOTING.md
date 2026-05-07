# Troubleshooting matrix

## Error envelopes

When a `sign` CLI command fails, it now emits a JSON envelope to stderr with a stable error code and exits 1:

```json
{
  "ok": false,
  "error": {
    "code": "TOKEN_EXPIRED",
    "message": "Token has expired (expiresAt=2026-05-07T13:55:00Z).",
    "hint": "Ask the requester to re-issue with a longer --token-ttl-minutes, or re-run `request create`.",
    "details": { "requestId": "req_...", "expiresAt": "2026-05-07T13:55:00Z" }
  }
}
```

Set `SIGN_ERROR_FORMAT=text` to fall back to the legacy plain-string-on-stderr behavior. Codes agents can rely on: `TOKEN_REQUIRED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_SIGNER_MISMATCH`, `SIGNER_ALREADY_SIGNED`, `PRE_SIGN_HASH_MISMATCH`, `PRE_SIGN_TITLE_MISMATCH`, `PRE_SIGN_TITLE_BAD_REGEX`, `PRE_SIGN_SIGNER_MISMATCH`, `NON_LOCAL_PROVIDER`, `REQUEST_NOT_SENT`, `MISSING_FLAG`, `UNKNOWN_COMMAND`, `INTERNAL` (fallback for un-tagged failures).

| Symptom | Likely cause | Fix |
|---|---|---|
| `DROPBOX_SIGN_API_KEY is not set.` | `.env` not loaded or key missing. | `cp .env.example .env`, fill `DROPBOX_SIGN_API_KEY`. |
| `SIGNWELL_API_KEY is not set.` | `.env` not loaded or SignWell section blank. | Add `SIGNWELL_API_KEY=...` to `.env`. |
| `SIGNWELL_WEBHOOK_SECRET (or SIGNWELL_API_KEY fallback) is not set.` | No webhook secret available. | Set `SIGNWELL_WEBHOOK_SECRET` (preferred) or fall back on `SIGNWELL_API_KEY`. |
| `Embedded signing is not yet supported for DocuSign.` | DocuSign embedded is intentionally not wired. | Use `request send` + `request watch` with `--provider docusign`. |
| `Missing parameter: client_id` (Dropbox embedded) | Opened the `sign_url` directly. | Use `request launch-embedded` or the HelloSign JS SDK. |
| `SignWell document ... did not return an embedded signing URL` | Document was sent via `request send`, not `request send-embedded`. | Re-send with `request send-embedded --provider signwell`. |
| `localhost is not a valid domain` | Dropbox embedded API App rejects localhost. | Use a tunnel (`localtunnel`, `cloudflared`, `ngrok`). |
| Webhook returns 401 | `event_hash` (Dropbox) or `event.hash` (SignWell) didn't match the secret used to verify. | Check that the API key / webhook secret in `.env` matches what's configured at the provider. |
| `DOCUSIGN_WEBHOOK_SECRET is not set.` | Ran `webhook verify`/`webhook ingest` with `--provider docusign` but the HMAC secret env var is empty. | Set `DOCUSIGN_WEBHOOK_SECRET` to the value configured in your DocuSign Connect HMAC keys. Pass the request's signature header via `--signature-header <hmac>` (DocuSign sends it as `X-DocuSign-Signature-1`, base64 or hex). |
| `SignWell PDF download failed: ...` | Document is not yet completed, or completed_pdf is still being generated. | Re-run after `request watch` reports `completed`. |
| `request watch` exits 4 (timeout) | Polling exceeded `--timeout-ms`/`--timeout-seconds`. | Increase the timeout, or run `request status` manually. |
| `request watch` exits 3 | Provider returned an error/invalid status. | Inspect `lastRemoteStatus` in the JSON output. |
| `request watch` exits 2 | Document was declined/expired/canceled/voided. | Treat as final-not-completed. |
| `request cancel is destructive at the provider. Re-run with --yes true to confirm.` | Safety guard. | Re-run with `--yes true`. |
| `DocuSign cancel requires --reason "..."` | DocuSign requires a void reason. | Pass `--reason "Reason"`. |
| `Dropbox Sign reminders require --email <signer email>.` | Dropbox's remind endpoint needs the signer email. | Pass `--email signer@example.com` to `request remind`. |
| `Document path escapes the working directory: ...` | Path validation blocked an absolute path or `..` traversal. | Move the file under your CWD or set `SIGN_ALLOW_ABSOLUTE_DOCS=1`. |
| `Document "X" is N bytes, exceeding the limit of M` | Document over `SIGN_MAX_DOCUMENT_BYTES` (default 25 MiB). | Override via env or use a smaller PDF. |
| `Signer email is not a valid email address` | Email failed the basic format check. | Fix the typo or surrounding whitespace. |
| `--return-url protocol "javascript:" is not allowed` / `--return-url must use https://` | URL allowlist for embedded `--return-url`. | Use https or a localhost http URL. |
| `Too many signers / fields / CSV rows` | Hard limit reached. | Split into multiple requests, or override per-call by editing the validate.ts limits. |
| `request send` returns `idempotent: true` and skips the provider call | The request already has a `provider_request_id`. | Pass `--force true` to send again, or treat the original `provider_request_id` as the source of truth. |
| Errors in CI/logs leak API keys | Errors are now run through `redactErrorMessage` before printing. | Make sure `DROPBOX_SIGN_API_KEY` / `SIGNWELL_API_KEY` / `SIGNWELL_WEBHOOK_SECRET` / `DOCUSIGN_INTEGRATION_KEY` are set in env so they're known and stripped from messages. |
| Need to debug a provider HTTP call | Use `--verbose true` (or `SIGN_DEBUG=1`). | Authorization / x-api-key / x-signwell-* headers are auto-redacted. |
| Database integrity concerns | Run `node dist/cli.js db verify`. | `db backup --out ./snap.db` writes a consistent copy via SQLite VACUUM INTO. |
| `Template requests need role:<name> on every --signer` | A `request from-template` signer was missing `role:`. | Add `role:<roleName>` matching the template role/placeholder. |
| `--template-id and --document cannot be combined` | Both flags were passed to a single request. | Use `request from-template --template-id ...` (no `--document`) or `request create --document ...` (no template). |
| `Template send is not supported for <provider>.` | The provider's send-from-template helper isn't wired (shouldn't happen for the bundled providers). | Make sure you're on the latest CLI; all three providers support templates. |
| `Field signer:N does not match any --signer order` / `Field doc:N is out of range` | A `--field` references a signer or document that wasn't passed. | Make the `signer:` order match a `--signer order:N`, and `doc:` indices stay within the number of `--document` flags (0-based). |
| `Anchor strings are not supported via this CLI` (Dropbox / SignWell) | Those providers don't accept anchor strings via API in this CLI. | Pass coordinates (`page:`, `x:`, `y:`) instead, or use `--provider docusign` for anchors. |
| `Field needs either anchor:"text" or page+x+y` | A `--field` had neither. | Add either `anchor:"Sign here"` (DocuSign) or `page:`, `x:`, `y:` (any provider). |
| `request bulk` exits 3 | One or more CSV rows failed. | Inspect `results[].error` in the JSON output; each row independently records its outcome. |
| CSV row missing name and/or email | The CSV has empty cells in the required columns. | The wizard expects `name` and `email` (or `signer_name`/`signer_email`); fix the row and retry. |
| `audit verify` exits 3 | Audit chain hash mismatch — tamper or deleted event. | Inspect the `break` field in the JSON output to see which event broke the chain. |
| `request verify-signed-pdf` exits 3 | One or more signatures' `messageDigest` did not match the recomputed digest of the byte range. | Inspect the `signatures[].parseWarnings` field; the PDF may have been modified after signing. |
| `Timestamp request failed (...)` | TSA URL unreachable or rejected the request. | Override with `--tsa-url` or `SIGN_TSA_URL` (default is `http://timestamp.digicert.com`). |
| `DocuSign embedded signing requires --return-url.` | DocuSign embedded recipient view requires a return URL. | Pass `--return-url https://your-app/return`. |
| Provider call appears to hang on flaky network | The CLI now retries 5xx/408/425/429 with exponential backoff (max 3 retries, base 1s). Tunable via `SIGN_HTTP_MAX_RETRIES` and `SIGN_HTTP_BASE_DELAY_MS`. | Set `SIGN_HTTP_MAX_RETRIES=0` to disable. |
| `Pre-sign safety check failed: --require-hash ...` / `... does not match --require-title ...` / `... does not match resolved signer ...` | The agent's `sign sign` call asserted an expected hash/title/signer that doesn't match the actual request. No state was mutated. | Re-fetch with `signer fetch-document` to inspect the document and metadata, then re-run with the corrected expectation — or treat this as evidence the requester swapped something behind your back. |
| `--token is required for signer-side commands.` | Ran `sign`, `signer fetch-document`, or `signer decline` without `--token`. | Pass `--token <t>` from the `tokens[]` array `request create` returned to the requester. |
| `Token does not match any signer on request <id>.` | Wrong token (typo, copy-paste error, or token from a different request). | Double-check the token + `--request-id` pair the requester sent you. |
| `Token has expired (expiresAt=...)` | The token's `tokenTtlMinutes` window elapsed. | Ask the requester to mint a fresh request, or re-`request create` with a longer `--token-ttl-minutes`. |
| `--signer-email <e> does not match the signer (<other>) the token authorizes.` | `--signer-email` was passed alongside `--token` but they disagree. | Drop `--signer-email` (the token alone is sufficient) or fix the email to match. |
| `Signer <e> has already signed request <id>.` | Replay — the same token tried to sign the same slot twice. | Each token can sign its slot at most once. If you need to undo, the requester must `request cancel` and start over. |
| `Signer-side flow only supports --provider local; this request uses ...` | Tried to run `sign sign`, `signer fetch-document`, or `signer decline` against a hosted provider request (Dropbox Sign / DocuSign / SignWell). | Use the provider's email link or embedded sign URL for those providers. Signer-side commands are for `--provider local` only. |
| `Request <id> has not been sent to the local provider yet; nothing to sign.` | Tried to sign before `request send`. | Run `request send --provider local --request-id <id>` first. |
| `<email> is not a recipient on request <id>.` | The `--signer-email` you passed isn't on the signer list. | Run `signer list --signer-email <e>` to confirm; check the requester's `--signer` flags. |
| `Request <id> has multiple signers; pass --signer-email to pick one of: ...` | Multi-signer request needs the agent to pick which signer it's acting as. | Pass `--signer-email <e>`. |
| `Local provider: document <id> is declined; cannot sign.` / `... is canceled; cannot sign.` | A signer already declined or the requester canceled. | The request is terminal — start a new one. |
| `Local provider: document <id> is already completed; cannot decline.` | All signers already signed. | Decline isn't applicable; the document is final. |
| Local request keeps auto-completing after one poll | Default `SIGN_LOCAL_AUTOCOMPLETE=true` is convenient for demos but races signer-side commands. | Export `SIGN_LOCAL_AUTOCOMPLETE=false` (or set it in `.env`) so the local provider holds at `sent` until each signer runs `sign sign`. |
| `Request <id> exceeded SIGN_LOCAL_MAX_FETCHES_PER_HOUR=N (current=M).` | A misbehaving (or runaway) agent is hammering `signer fetch-document` for the same request. | Lower the agent's poll rate, raise the limit, or unset `SIGN_LOCAL_MAX_FETCHES_PER_HOUR`. The window is a sliding hour anchored to `audit_events.created_at`. |

## Live smoke test
SignWell only:
```bash
SIGNWELL_API_KEY=... ./scripts/smoke-signwell.sh ./your.pdf
```
The script no-ops with exit 0 if `SIGNWELL_API_KEY` is unset, so it's safe to wire into automated jobs.
