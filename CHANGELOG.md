# Changelog

All notable changes to `sign-cli`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

`scripts/changelog.mjs` prints a Keep-a-Changelog-shaped block for commits
since the last tag — use it to seed the `[Unreleased]` section before a
release.

## [Unreleased]

### Added

- **Postgres async surface** — every read-only audit primitive (`verifyAuditChainAsync`, `listAuditEventsAsync`, `searchAuditEventsAsync`) and most write primitives (`appendAuditEventAsync`, `tryClaimWebhookEventAsync`, `insertApprovalRowAsync`, `insertArtifactRowAsync`, `markApprovalUsedAsync`, `markAllRequestApprovalsUsedAsync`, `updateRequestStatusAsync`, `reissueApprovalTokenRowAsync`, `persistRequestProviderMetadataAsync`) now run against `PostgresBackend`. Driver-level dialect translation (`?` → `$N`) handled by `db-backend.ts`.
- **`sign db postgres-smoke`** — eight-step integration probe for the async path: bootstrap → insert → extend chain → verify → list → search. Use after `sign db migrate-postgres` to confirm a fresh deployment.
- **`sign db migrate-postgres`** — Postgres-flavor schema bootstrap with PL/pgSQL append-only triggers. Idempotent.
- **`sign db rotate-keys`** — re-issues the local signer keypair with timestamped backups. `--re-sign-receipts true` walks every prior receipt and re-signs each manifest with the new key.
- **`sign audit anchor`** — cross-request RFC 3161 anchoring with `--since`, `--since-anchor`, and `--dry-run` modes. Companion commands: `audit anchors-list`, `audit verify-anchor`.
- **`sign audit chain-bundle`** — self-contained compliance directory (anchor + per-request receipts + INDEX.json). `--tarball` writes a portable `.tar.gz` (pure-Node USTAR + gzip writer); `--include-source-pdf true` includes the unsigned PDF for reproducibility.
- **`sign audit verify-chain-bundle`** — re-checks a stored bundle (dir or tarball) and reports per-request results; `--report` streams NDJSON.
- **`sign audit show`** gains `--format pretty` (human-readable timeline), `--format csv` (RFC 4180), `--event-type` (repeatable), and `--since`/`--until` (time window).
- **`sign audit search`** — log-style cross-request filter with `--request-id`, `--event-type`, `--since`, `--until`, `--payload-contains`.
- **`sign signer policy lint`** — static checks (invalid regex, empty rules, unreachable rules, redundant rules, decline-without-reason, contradictory rules).
- **`sign signer policy diff`** — preview action flips between two specs against a snapshot or the inbox; `--format markdown` renders a reviewer-friendly table.
- **`sign signer policy try`** — offline tester; `--batch` evaluates an array of contexts in one shot.
- **`sign signer policy run-watch`** — long-running tail-the-inbox + apply-policy loop. Flags: `--report` (NDJSON), `--on-decision <cmd>` (shellout hook), `--since-anchor` (skip already-anchored chains).
- **`sign request rerun-policy`** — re-evaluate a stored request against an updated spec. Pure read.
- **`sign request bulk-resend`** — re-issue tokens en masse from a CSV roster.
- **`sign request show`** gains `--hash-only true` (stable digest triple) and `--recipient <email>` (redacted single-signer view).
- **`sign request list`** gains `--since`, `--format json|table`.
- **`sign metrics show` / `sign metrics ship`** — Prometheus text output and a long-running pusher; `--batched` coalesces N snapshots per HTTP body.
- **`sign serve --rate-limit`** — token-bucket per-IP gate with `X-RateLimit-*` headers and `Retry-After`.
- **`sign serve --read-only` + `sign mcp serve --read-only`** — block lifecycle-mutating endpoints/tools with `FORBIDDEN_READ_ONLY`.
- **`sign mcp serve`** gains `--tool` allow-list, `--capability` toggle (tools/resources/prompts), `--emit-events` NDJSON tee log, `--emit-events-redact true` (mask token-shaped fields).
- **`sign serve --web-demo true`** — bundled static HTML/CSS/JS dashboard served from same origin under `/web-demo/*` (no CORS).
- **MCP tool catalog** — every tool ships an `inputSchema` and most ship an `outputSchema`; `request_watch` ships a `progressSchema`. `sign mcp tools --format markdown` renders the catalog as a docs page.
- **Selftest MCP leg** — `runSelftest` now also drives `initialize`, `tools/list`, `tools/call request_show`, `tools/call audit_verify` through the JSON-RPC server.

### Refactor

- All `INSERT INTO artifacts` call sites route through `insertArtifactRow`. Sync write primitives now share SQL constants + parameter projections with their async siblings — column order can't drift.

### Docs

- New `docs/recipes/` — sign-as-Alice, weekly anchor, auditor handoff, agent loop over MCP.
- New `docs/architecture.md` — mermaid diagram + layer-by-layer prose.
- New `docs/comparison.md` — frank pros/cons vs. SaaS providers and DIY.
- New `docs/compliance-posture.md` — explicit threat model + what the audit chain proves and doesn't.
- New `integrations/` — Claude Desktop config + langchain wrapper starters.
- README intro tightened: one-line lede, `npx sign-cli demo` above the fold, "Read in this order" pointer to the four entry points.

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
