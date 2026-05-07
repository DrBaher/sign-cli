# Changelog

All notable changes to `sign-cli`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-05-07

A large discoverability + agent-as-signer release.

### Added
- **Agent-as-signer flow for `--provider local`** — `sign sign`, `signer list`, `signer fetch-document`, `signer decline`, with per-signer token authentication (#11, #12). Pre-sign safety checks (`--require-hash` / `--require-title` / `--require-signer-email`) throw before any state mutation. New audit events: `request.signed_by_signer`, `request.signer_declined`, `request.signer_fetched_document`.
- **Structured error envelopes** — `{ ok, error: { code, message, hint?, details? } }` on stderr, with stable `code` values (`TOKEN_EXPIRED`, `PRE_SIGN_HASH_MISMATCH`, `NON_LOCAL_PROVIDER`, …). Toggle off with `SIGN_ERROR_FORMAT=text` (#13).
- **Enriched `request show`** — adds `signedBy[]`, `declinedBy`, per-approval `tokenHint`/`expiresAt`/`expired`/`signed`, and a `nextSteps[]` array of suggested commands (#14).
- **MCP stdio server** — `sign mcp serve` exposes 8 tools (`signer_list`, `signer_fetch_document`, `sign`, `signer_decline`, `request_show`, `request_status`, `request_watch`, `audit_verify`) and 3 resource shapes (`request://<id>` snapshot, `request://<id>/document` PDF blob, `request://<id>/audit` chain) over JSON-RPC 2.0 (#15, #19). `request_watch` streams `notifications/progress` when the client supplies a `progressToken`. Tool args are validated against each tool's `inputSchema`.
- **Token recovery** — `signer reissue-token` mints a fresh token in place of an expired/lost one (#16).
- **Inbox token expiry hints** — every `signer list` entry now includes `tokens[]` with `expiresAt`, `expired`, `expiresSoon` (#16).
- **Spec-file requests** — `request create --spec ./request.json [--param key=value]` (#17, #20). Variable substitution lets a single template be reused across counterparties.
- **Declarative signer policy** — `signer policy run --spec ./policy.json [--dry-run true]` and `signer policy run-all --tokens-file …` (#18, #21). Two-layer model: non-negotiable expectations (`titleMatches`, `documentSha256`, `signerEmail`) + first-match-wins rules (`sign` / `decline` / `report`).
- **Webhook notifications** — `SIGN_LOCAL_NOTIFY_URL` fires fire-and-forget JSON POSTs on allow-listed audit events (`request.signed_by_signer`, `request.signer_declined`, `request.final_pdf_downloaded`, etc.) (#21).
- **Cryptographic receipts** — `request receipt --request-id <id> --out ./receipt/` produces an audit-export bundle plus a detached `manifest.sig` + `manifest.cert.pem` that openssl can verify directly (#20).
- **Per-signer PAdES identity** — each signer gets a stable on-disk RSA-2048 key/cert keyed by email; `signedBy[]` entries now carry `certFingerprintSha256` + `certSubjectCommonName`, giving multi-party requests cryptographically distinguishable per-signer identities at the audit-chain level (#23).
- **Cross-provider `signedBy` parity** — new `signer_signing_states` table is fed by both local sign/decline and Dropbox/SignWell webhook ingestion. `request show` for hosted-provider requests now returns a populated `signedBy[]` instead of `null` (#24).
- **Shell completion** — `sign completion bash|zsh|fish` (#22).
- **Self-documenting CLI** — `sign --help` (grouped index), `sign <cmd> --help` (focused per-command help), `sign --catalog json` (machine-readable index), `sign examples` (7 curated walkthroughs), `sign --version`, `sign mcp tools` (catalog without spinning up the server) (#25).
- **Discoverability TL;DR** in the README plus a 5-line cheatsheet (#26).

### Changed
- `request show` snapshot shape preserved as a strict superset; existing keys unchanged.
- `--token` is now **required** for `sign`, `signer fetch-document`, and `signer decline` (signer-side flow was 2 days old; no other callers).

### Migration

The new `signer_signing_states` table is created via `CREATE TABLE IF NOT EXISTS` on `openDatabase`, so existing DBs upgrade transparently. No data migration required.

## [0.4.0] — earlier

See `git log --oneline 0.3.0..0.4.0` for the SignWell webhook ingest, embedded signing, audit timestamping, and PAdES-signer history.
