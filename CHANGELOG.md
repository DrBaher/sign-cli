# Changelog

All notable changes to `sign-cli`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

`scripts/changelog.mjs` prints a Keep-a-Changelog-shaped block for commits
since the last tag — use it to seed the `[Unreleased]` section before a
release.

## [Unreleased]

### Added

- **`sign doctor preflight`** — structured per-check report on `sign doctor preflight` (subcommand). Each check is `{ name: "<category>:<specific>", status: "ok"|"failed"|"skipped", detail, hint? }`; the wrapping object is `{ provider, summary: { passed, failed, skipped, verdict: "ok"|"failed" }, checks[] }`. Exit `0` if `verdict == "ok"`, `1` if `verdict == "failed"`. Env-health checks run on every provider: `runtime:node_version` (Node ≥ 22 for `node:sqlite`), `storage:db_path` (`SIGN_DB_PATH` parent writable with a probe-file round-trip, default `./data/sign.db`). Provider-scoped checks layer on: `env:*` (required env vars present), `connectivity:*` (provider API reachable), `permissions:*` (filesystem paths writable + RSA key files exist for DocuSign), `fixture:canonical_unsigned` (for `local`). Bare `sign doctor` (no subcommand) remains the unstructured env-report; always exits 0. Stderr always prints `[sign] preflight: <verdict> (provider=<p>, N ok, N failed, N skipped)` so the one-line summary is grep-able without parsing JSON.
- **`sign workflow nda`** — one command that renders the bundled mutual-NDA template into a PDF and creates a signing request in one shot. Wraps `scripts/render-template.mjs` + `request create`. Flags: `--values <file.json>` (variable map), `--value KEY=VALUE` (repeatable, overrides values), `--party-a-email <addr>`, `--party-b-email <addr>` (both required, must differ), `--template <path>` (override the bundled template), `--out <file>` (PDF output), `--token-ttl-minutes`, `--auto-approve`. Signer names are read from `PARTY_A_SIGNATORY` / `PARTY_B_SIGNATORY` in values. Missing placeholders surface **all** gaps at once before any PDF is written — no half-rendered output. Output includes `templateUsed: "bundled" | "custom"`, the resolved `title`, and the embedded `request.requestId`. Exit `3` on validation errors (same-email, missing placeholders, missing values file).
- **`sign pdf stamp verify`** — confirms a previously-stamped image is at the expected position and size, within a ±1pt tolerance. Pairs with `sign pdf stamp` for CI-time tamper checks: stamp at known coords on send, verify on receipt. Flags: `--pdf <path>`, `--image-page <n>`, `--image-x`, `--image-y`, `--image-width`, `--image-height`. Output: `{ ok, verdict: "ok"|"wrong_position"|"missing"|"out_of_range", found?: { page, x, y, width, height } }`. Exit `0` for `ok`; `3` for `wrong_position` (found ≠ expected, `found` shows the actual coords); `4` for `missing` (no stamp on page) or `out_of_range` (page index ≥ page count).
- **Extended audit export bundle** — `audit export` now emits `bundleVersion: 2` in the manifest. New files alongside the existing `audit.json` / `signed.pdf` / `manifest.json`: `original.pdf` (the unsigned source, byte-identical to the request's input), `README.md` (human-readable handoff with the request ID, signer list, and verify commands), `receipts/<signer-email>.json` (per-signer event subsets filtered by `payload.signerEmail`). All files are sha256'd in `manifest.json`. Per-signer event arrays populate only from signer-action events (`request.signed_by_signer`, `request.signer_declined`, `request.signer_fetched_document`) — an auto-approved-but-never-signed request will have empty per-signer arrays, by design. Separately: `sign request receipt` (always was) still emits the cryptographically-signed `bundleVersion: 1` (with detached `manifest.sig` + `manifest.cert.pem`), and `sign request verify-receipt` re-verifies it — use that when a third party needs to validate the manifest itself without trusting your DB.
- **Trust labels in signed-PDF inspection** — `request verify-signed-pdf` adds a `trust` field to every entry in `signatures[].signers[]`. Values: `"self_signed_local"` (issuer == subject AND issuer matches this CLI's built-in local signer subject string), `"self_signed_other"` (issuer == subject but not from this CLI), `"ca_signed"` (issuer != subject — chains to a different issuer), `"unknown"` (cert parse error or absent). Labels are **structural and descriptive** — there's no trust-store lookup, expiry check, or chain validation built in. For chain validation, use an external verifier; for expiry, read `validTo` on the signer entry.
- **Strict provider mode + resolved-provider banner** — every command that touches a provider prints `[sign] resolved provider: <provider> (<source>)` to stderr on start. `<source>` is one of `via --provider flag`, `via SIGN_PROVIDER env`, `default — no flag, no SIGN_PROVIDER set`. New global flag `--strict-provider true` (or env `SIGN_STRICT_PROVIDER=true`) rejects mismatches between the resolved provider and the request's persisted provider with error code `STRICT_PROVIDER_MISMATCH` and a hint telling the operator which flag to use instead. Resolution order: flag > env > default.
- **`audit verify` per-class exit codes + summary** — `sign audit verify` (the canonical command; there is no top-level `sign verify` alias) emits a one-line summary `{ ok, chainValid, events, signers, ... }` and uses exit codes that distinguish failure kinds: `0` ok, `2` invalid input (missing request, bad flag), `3` chain tampered (events present but `chainValid: false`), `4` request not found. Replaces the previous "0 or 1" coarse codes. Existing JSON shape preserved.
- **Canonical unsigned PDF fixture** — `fixtures/canonical-unsigned-v1.pdf` is a reproducible 1-page A4 PDF for tests and demos that need a clean unsigned input. Regeneration is byte-stable: `node dist/scripts/generate-canonical-unsigned-pdf.js` produces the same sha256 every time. Programmatic accessor: `import { canonicalUnsignedPdfPath } from "./lib/fixtures.js"`. Used as the default `--document` for the new `workflow nda` flow when no template is rendered.
- **`sign pdf detect-signature-field`** — new command that returns ranked signature-field placement candidates for a PDF as JSON. AcroForm `/Sig` widgets (confidence `1.0`) rank first; anchor-text matches (Signature:, Sign here, Signed by:, Initial:, X____) follow with adjustment-method-derived confidence: `underline-snap` (`0.95`, anchor + adjacent underscore run), `whitespace-probe` (`0.75`, anchor + adjacent empty space), `shrink-to-fit` (`0.50`, default rect iteratively shrunk to avoid overlap). The safety contract: a candidate is never emitted with `overlapsText: true` — when no overlap-free rectangle exists, the candidate is dropped entirely. Exit `0` with candidates, exit `2` when none found. Uses `pdfjs-dist` for text-position extraction.
- **`sign sign --auto-place true`** — calls the detector and uses the top candidate iff there is a **unique** high-confidence (`≥ 0.8`) match. Multiple high-confidence candidates → `AUTO_PLACE_AMBIGUOUS` with the full candidate list. No high-confidence candidates → `AUTO_PLACE_NO_HIGH_CONFIDENCE` (with low-confidence candidates surfaced in `details` so the caller can pass `--image-*` explicitly). Without a visible-signature flag → `AUTO_PLACE_REQUIRES_VISIBLE_SIG`. Explicit `--image-*` coords always win over `--auto-place` (with a notice on stderr). The detector never silently picks a low-confidence rectangle.
- **`sign sign --name-signature`** — render the signer's name (or an explicit string) as a visible italic signature using pdf-lib's built-in `Helvetica-Oblique` font. Closes the UX gap where `--signature-image` was the only path to a visible stamp — now an agent or human can produce a signed PDF without preparing a signature image. Two forms: `--name-signature true` uses `--signer-name <text>` as the rendered text; `--name-signature "Custom Name"` renders that literal string. Mutually exclusive with `--signature-image` (caller bug → `SIGN_VISIBLE_SIG_BOTH`). Uses the same position resolution as image stamps (`--image-page/--image-x/--image-y/--image-width/--image-height` or fall back to a sender-placed SignatureField). Autosizes the text to fit the rectangle; draws an underline to signal "signature, not body text"; uses a signature-blue color matching the local-demo fixture.
- **`sign sign` help-catalog completeness** — `sign sign --help` and `sign --catalog json` now list every flag the command accepts. Previously they only advertised `--request-id`, `--token`, the `--require-*` safety checks, and `--idempotency-key`; the `--signature-image`, `--signer-name`, `--signer-email`, and `--image-page/--image-x/--image-y/--image-width/--image-height` flags existed in the code but couldn't be discovered from `--help`. (Plus the new `--name-signature` above.)
- **Visible photo signatures** — `sign sign --signature-image <path|data-url> --image-page <n> --image-x --image-y --image-width --image-height` stamps a PNG / JPG / SVG / `data:image/...;base64,...` onto the PDF *before* the PAdES envelope is sealed, so any post-signing tamper of the image breaks the cryptographic verification. Falls back to the sender's `--field signer:N,...` position when no explicit position flags are given. SVG inputs are rasterized at ~300 DPI of the target rectangle via `@resvg/resvg-wasm` (pure WASM, no native deps).
- **`sign pdf stamp`** — standalone command to stamp an image onto any PDF without a signing request. Shares the renderer with the integrated flow.
- **`docs/legal-posture.md`** — jurisdiction-by-use-case guide for when a `sign-cli` signature is enforceable. Covers US ESIGN/UETA, the eIDAS three-tier SES/AdES/QES breakdown, member-state nuances, and an EU-NDA deep-dive with the method-consent clause that materially improves enforceability for typical B2B NDAs.
- **`fixtures/templates/mutual-nda.md`** + **`scripts/render-template.mjs`** — bundled markdown template for a mutual NDA between two B2B parties (method-consent clause baked in per `legal-posture.md`) and a minimal `pdf-lib`-based renderer with `{{PLACEHOLDER}}` substitution. End-to-end recipe at [`docs/recipes/eu-nda.md`](docs/recipes/eu-nda.md).
- **`npm run lint:legal-claims`** — CI guardrail that scans user-facing docs + the web-demo landing page for unqualified legal claims ("legally binding" without a jurisdiction qualifier, "eIDAS-compliant", "court-ready", etc.) and fails loud. Exempts `docs/legal-posture.md` (the authoritative source) and `CHANGELOG.md`.
- **Web-demo signed-PDF artifact** — step 02 of the hosted demo now ships a downloadable PAdES-signed PDF with a visible SVG signature stamped on the page. Static fixture, generated by `scripts/generate-signed-fixture.mjs`.
- **Hosted-demo deploy kit** — `deploy/` ships a multi-stage Dockerfile, `seed-demo.mjs` (4 sample requests; one auto-completed), `entrypoint.sh` (wipe → seed → `sign serve --read-only true --web-demo true --rate-limit 5` → exit-after-TTL), and provider configs for Fly / Render / Railway plus a docker-compose for local validation.
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

### Changed

- **`sign doctor preflight` env-health checks** — preflight now runs two env-scoped checks before any provider-specific ones, on every provider: `runtime:node_version` (Node ≥ 22) and `storage:db_path` (`SIGN_DB_PATH` parent writable via a probe-file round-trip). Closes the gap where `doctor preflight` only validated provider credentials and ignored the env that the CLI itself needs.

### Fixed

- **Web-demo signed-PDF fixture's signer subject** — the fixture-generation script passed the per-signer keypair under the wrong option key (`keyPair` instead of `signerKeyPair`), so `signPdfLocally` fell through to `loadOrCreateLocalSigner()` and the fixture's signature panel showed the generic `CN=Sign CLI Local Signer` instead of `CN=Alice Anderson <alice@example.com>`. Regenerated; added a `web-demo.test.ts` guard asserting the fixture cert subject contains an `@` so the script can't silently regress.

### Refactor

- All `INSERT INTO artifacts` call sites route through `insertArtifactRow`. Sync write primitives now share SQL constants + parameter projections with their async siblings — column order can't drift.

### Docs

- **[`docs/agent-guide.md`](docs/agent-guide.md)** — canonical agent reference. Output conventions (stdout JSON / stderr error envelope), cross-command exit-code map, per-command schemas + side-effects + idempotency for the new surfaces (`doctor preflight`, `pdf stamp verify`, `workflow nda`, `audit export` v2, trust labels, strict-provider, `audit verify`), and the failure-mode → recovery table.
- **[`docs/recipes/preflight.md`](docs/recipes/preflight.md)** — pre-production agent recipe: `doctor preflight` → strict-provider → `pdf stamp verify` → `audit export` for handoff. Shows exit-code branching at each step.
- **[`docs/regression-testing.md`](docs/regression-testing.md)** — per-item manual regression tests for every surface in the `[Unreleased]` block, plus an end-to-end smoke. Exit-code-driven and copy-pasteable. Pairs with `npm test` (which covers the same surfaces automatically); use this when validating a build against expected behavior outside the suite.
- **[`docs/profiles-design.md`](docs/profiles-design.md)** — design proposal for named provider/credential/dbPath bundles (Item 5 of the readiness feedback). No code; open for review in #162.
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
