# Troubleshooting matrix

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
| `Webhook commands support --provider dropbox or signwell only.` | Tried `--provider docusign` for webhook commands. | DocuSign webhooks are not wired in this CLI. Use Dropbox or SignWell, or poll with `request watch`. |
| `SignWell PDF download failed: ...` | Document is not yet completed, or completed_pdf is still being generated. | Re-run after `request watch` reports `completed`. |
| `request watch` exits 4 (timeout) | Polling exceeded `--timeout-ms`/`--timeout-seconds`. | Increase the timeout, or run `request status` manually. |
| `request watch` exits 3 | Provider returned an error/invalid status. | Inspect `lastRemoteStatus` in the JSON output. |
| `request watch` exits 2 | Document was declined/expired/canceled/voided. | Treat as final-not-completed. |
| `request cancel is destructive at the provider. Re-run with --yes true to confirm.` | Safety guard. | Re-run with `--yes true`. |
| `DocuSign cancel requires --reason "..."` | DocuSign requires a void reason. | Pass `--reason "Reason"`. |
| `Dropbox Sign reminders require --email <signer email>.` | Dropbox's remind endpoint needs the signer email. | Pass `--email signer@example.com` to `request remind`. |
| `request bulk` exits 3 | One or more CSV rows failed. | Inspect `results[].error` in the JSON output; each row independently records its outcome. |
| CSV row missing name and/or email | The CSV has empty cells in the required columns. | The wizard expects `name` and `email` (or `signer_name`/`signer_email`); fix the row and retry. |
| `audit verify` exits 3 | Audit chain hash mismatch — tamper or deleted event. | Inspect the `break` field in the JSON output to see which event broke the chain. |
| `request verify-signed-pdf` exits 3 | One or more signatures' `messageDigest` did not match the recomputed digest of the byte range. | Inspect the `signatures[].parseWarnings` field; the PDF may have been modified after signing. |
| `Timestamp request failed (...)` | TSA URL unreachable or rejected the request. | Override with `--tsa-url` or `SIGN_TSA_URL` (default is `http://timestamp.digicert.com`). |
| `DocuSign embedded signing requires --return-url.` | DocuSign embedded recipient view requires a return URL. | Pass `--return-url https://your-app/return`. |
| Provider call appears to hang on flaky network | The CLI now retries 5xx/408/425/429 with exponential backoff (max 3 retries, base 1s). Tunable via `SIGN_HTTP_MAX_RETRIES` and `SIGN_HTTP_BASE_DELAY_MS`. | Set `SIGN_HTTP_MAX_RETRIES=0` to disable. |

## Live smoke test
SignWell only:
```bash
SIGNWELL_API_KEY=... ./scripts/smoke-signwell.sh ./your.pdf
```
The script no-ops with exit 0 if `SIGNWELL_API_KEY` is unset, so it's safe to wire into automated jobs.
