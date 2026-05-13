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
| `AUTO_PLACE_REQUIRES_VISIBLE_SIG` on `sign sign --auto-place true` | `--auto-place true` was passed without a visible-signature flag. The auto-placed rectangle is only useful as the position for a stamp. | Add `--name-signature "<text>"` (renders the signer's name) or `--signature-image <path>` alongside `--auto-place true`. |
| `AUTO_PLACE_NO_HIGH_CONFIDENCE` on `sign sign --auto-place true` | The detector found no AcroForm `/Sig` widget and no high-confidence (`≥0.8`) anchor-text match. Either the PDF has no recognizable signature field, or the anchor wording / layout isn't supported. | Run `sign pdf detect-signature-field --pdf <path> --verbose true` to see what pdfjs extracted. If text items contain the would-be anchor but no candidate was emitted, the layout isn't handled (e.g., anchor at the right edge or surrounded by text). Pass `--image-page/--image-x/--image-y/--image-width/--image-height` explicitly to bypass auto-placement. |
| `AUTO_PLACE_AMBIGUOUS` on `sign sign --auto-place true` | Multiple high-confidence (`≥0.8`) candidates were found — the detector refuses to pick one because it can't tell which signature line is meant for this signer. | Use a selector instead of `true`: `--auto-place first` / `last` / `all` / `page:N` / `index:N`. Or inspect `details.candidates` and pass `--image-*` explicitly. |
| `AUTO_PLACE_PAGE_NOT_FOUND` / `AUTO_PLACE_PAGE_AMBIGUOUS` on `sign sign --auto-place page:N` | `page:N` matched zero candidates (`NOT_FOUND`) or multiple (`AMBIGUOUS`) on that page. | Hint lists the pages that DO have candidates; pick one of those, switch to `index:N`, or pass `--image-*` explicitly. |
| `AUTO_PLACE_INDEX_OUT_OF_RANGE` on `sign sign --auto-place index:N` | `index:N` was beyond the count of high-confidence candidates. | Hint includes the valid range (`0..N-1`); inspect `details.candidates` for the order. |
| `INVALID_AUTO_PLACE_VALUE` | The `--auto-place` value wasn't one of `true / first / last / all / page:N / index:N`. | Hint lists the full set. Common mistakes: `--auto-place 1page` (use `page:1`), `--auto-place page1` (missing colon). |
| `sign pdf stamp-text --auto-place` errors `AUTO_PLACE_NO_HIGH_CONFIDENCE` even though the PDF has visible `Date:` fields | All date candidates were skipped because a date string is already filled in near each anchor (`alreadyFilled: true`). The default is to preserve existing content. | Pass `--overwrite-filled true` to include filled candidates; or pass `--image-*` explicitly with one of the rectangles in `details.allDateCandidates`. |
| `sign sign --auto-place` previously found a candidate, now returns no candidates after adding `Date:` fields | The `sign sign --auto-place` flow filters to signature-category candidates only; date anchors are excluded from the pool. | Confirm the PDF still has a `Signature:` / `Signed by:` / `Sign here:` anchor. Use `sign pdf detect-signature-field --pdf <path> --verbose true` to see what's actually detected. For date fields, use `sign pdf stamp-text` instead. |
| `DOCX_CONVERSION_FAILED` on `sign document <file.docx>` | The bundled `docx2pdf-cli` couldn't find a working backend in your environment. | Run `npx docx2pdf --doctor` to see which backends (LibreOffice, Pages, Word, Gotenberg, ConvertAPI, textutil-cups) are available. Install one (e.g. `apt install libreoffice` on Linux) and retry. For pre-converted inputs, run `docx2pdf` separately first and pass the resulting `.pdf` to `sign document`. |
| `sign document` errors `AUTO_PLACE_NO_HIGH_CONFIDENCE` on a converted DOCX | The DOCX→PDF backend produced a PDF without a recognizable `Signature:` / `Sign here` anchor — either the original DOCX didn't include one, or the chosen backend rasterized the text in a way pdfjs can't extract (rare). | Pre-convert with a different backend (`docx2pdf --backend libreoffice doc.docx`) and pass the resulting PDF, or pass explicit `--image-page/--image-x/--image-y/--image-width/--image-height` coords. |
| `PROFILE_NOT_FOUND` when running any command with `--profile <name>` or `SIGN_PROFILE=<name>` | The named profile doesn't exist in the user file (`$XDG_CONFIG_HOME/sign-cli/profiles.json` or `SIGN_PROFILES_FILE`). | The error hint lists available profile names. Create the profile with `sign profile init --name <name> --provider <p> ...`, or pick a name from the available list. |
| `PROFILE_ENV_VAR_UNSET` on profile load | A profile's `credentials.*` value contains `{{env:VAR}}` but `VAR` is not set in the current shell. | The error names the missing variable. `export VAR=...` before running, or run `sign profile set --name <n> --key credentials.X --value <literal>` to switch to a literal. To find which fields reference env vars, inspect the raw profile file directly — `sign profile show` displays *resolved* values, not the raw references. |
| `INVALID_PROFILE` on init/set/load | Schema validation failed — unknown field, bad provider value, wrong type (e.g. `strictProvider: "yes"` instead of `true`), or unknown top-level key (typo like `defaultTokenTtl` instead of `defaultTokenTtlMinutes`). | The error message names the field and the expected type. Common: pass the right boolean (`--value true`/`--value false` for `strictProvider`), pick from `dropbox / docusign / signwell / local` for `provider`. |
| `PROFILE_ALREADY_EXISTS` on `sign profile init --name <n>` | A profile with that name already exists in the user file. | Either `sign profile delete --name <n> --yes true` first, then re-init; or use `sign profile set --name <n> --key <k> --value <v>` to edit fields on the existing profile. |
| `sign profile show` doesn't show credential values | Credentials are redacted by default (matches `aws sts`, `gh auth view`, `kubectl config view`). | Pass `--show-secrets true` to reveal resolved (post-`{{env:}}`-expansion) credential values. |
| Want to use a different profile file path than `~/.config/sign-cli/profiles.json` | The default is XDG-compliant but overridable. | Set `SIGN_PROFILES_FILE=/path/to/profiles.json` in your shell environment. Useful for tests or per-project user-style overrides. |
| `sign pdf detect-signature-field` returns `candidates: []` (exit 2) | No AcroForm signature widget AND no recognized anchor text was matched **with a viable rectangle**. Note: even when the anchor regex matches, the candidate is dropped if every adjustment strategy fails to find an overlap-free rectangle. | Re-run with `--verbose true` and inspect `textItemsByPage`: (1) if the anchor word IS in the items, the layout strategies couldn't fit (try explicit `--image-*` coords); (2) if the anchor word ISN'T in the items, either it's not one of the 5 patterns (`Signature:`, `Sign here`, `Signed by:`, `Initial:`, `X____`), or the PDF uses an embedded font without a ToUnicode CMap (pdfjs returns garbage). |

## Live smoke test
SignWell only:
```bash
SIGNWELL_API_KEY=... ./scripts/smoke-signwell.sh ./your.pdf
```
The script no-ops with exit 0 if `SIGNWELL_API_KEY` is unset, so it's safe to wire into automated jobs.
