# Security controls

What `sign-cli` does to prevent a malicious or buggy caller (especially an agent) from doing the wrong thing. For the threat model and what the audit chain proves, see [security-model.md](security-model.md).

## Path-traversal guards on every input and output

Every flag that takes a file path runs through one of three validators in `src/lib/validate.ts`:

- `validateDocumentPath` — for inputs (`--pdf`, `--input`, `--document`). Rejects paths that resolve outside the current working directory.
- `validateOutputPath` — for outputs (`--out`, `--out-dir`). Same rule.
- `validateConfigPath` — for profile-stored paths (`dbPath`). Permissive about `~` and the user's home; rejects paths outside `$HOME` and CWD.

Default behavior is **CWD-only**. Set `SIGN_ALLOW_ABSOLUTE_DOCS=1` to opt out — useful when you want to write to `/var/data/...` from a CI runner that isn't in that directory.

This applies uniformly across CLI invocations, MCP tool calls (over `sign mcp serve`), and HTTP routes (over `sign serve`). A buggy or malicious MCP client can't coax the server into reading `/etc/passwd` via a `pdf_path` argument.

## Read-only mode

Both the MCP server and the HTTP API support `--read-only true`. Mutating tools and routes (the ones in `READ_ONLY_BLOCKED_TOOLS` / `READ_ONLY_BLOCKED_ROUTES`) respond with `FORBIDDEN_READ_ONLY` (exit `3` / HTTP 403). Useful for sandboxed agents that should be able to inspect and track but not send, sign, or decline.

```bash
sign mcp serve --read-only true \
  --tool request_show --tool audit_verify --tool pdf_detect_signature_field

sign serve --read-only true --rate-limit 5
```

`--tool` allow-lists narrow further — only the named tools are exposed.

## Secret redaction in error envelopes and HTTP logs

`src/lib/secret.ts` maintains a registry of known secret keys (the provider API keys: `DROPBOX_SIGN_API_KEY`, `DOCUSIGN_*`, `SIGNWELL_API_KEY`, plus the per-call dynamic set populated by `applyCredentialsToProcessEnv`). Every error envelope, stack trace, and HTTP debug log is post-processed: any registered secret value gets replaced with `***`.

Profile-injected credentials (custom keys like `ACME_API_KEY`) flow through the dynamic set, so they redact the same way as the hardcoded list.

This means an error like

```
{"ok":false,"error":{"code":"PROVIDER_HTTP_500","message":"Dropbox Sign returned 500","details":{"requestUrl":"https://api.hellosign.com/v3/signature_request/send?api_key=DROPBOX_..."}}}
```

reads as

```
{"ok":false,"error":{"code":"PROVIDER_HTTP_500","message":"Dropbox Sign returned 500","details":{"requestUrl":"https://api.hellosign.com/v3/signature_request/send?api_key=***"}}}
```

before reaching the caller.

## Idempotent send

`request send` accepts an `--idempotency-key`. Same key + same args returns the cached result without re-sending. Provider quotas appreciate this; so does a retrying agent.

The default behavior of `request send` also refuses to double-send: if a request already has a `provider_request_id` persisted, send fails with `ALREADY_SENT` unless `--force true` is passed. Combined with the idempotency key, an agent retrying after a transient network failure won't duplicate the document on the signer's end.

## Per-signer token gate on the sign step

The whole architecture's load-bearing security control. `sign sign` (CLI), the `sign` MCP tool, and `POST /v1/sign` all require a per-signer token. Tokens are:

- **Scoped to one signer email.** A token for `alice@acme.com` can't sign as `bob@beta.com`.
- **TTL-bounded.** Default 60 minutes; configurable per-request via `--token-ttl-minutes`.
- **Single-use.** Once `request.signed_by_signer` is recorded for that signer, the token is marked used and subsequent calls fail with `TOKEN_USED`.
- **Held by the human, not the agent.** The expectation is that the requester DMs the token to the signer, and the signer pastes it into a `sign sign --token ...` call.

An agent driving the requester side never sees signer tokens — `request show` redacts them by default; the only way to retrieve a token is to be the requester at create-time. This is the asymmetry: the agent does every step *except* the signing gesture.

## Pre-sign safety checks

`sign sign` accepts three optional guards that throw with structured errors *before* any state mutation:

- `--require-hash <sha256>` — the document's sha256 must match. Useful when an agent is signing a document it computed earlier; protects against the document being swapped in flight.
- `--require-title <regex>` — the request's title must match. Defense in depth against a token being used against the wrong request.
- `--require-signer-email <email>` — the resolved signer must match.

All three throw `PRE_SIGN_*_MISMATCH` errors (exit `3`) before the sign attempt is recorded. The audit chain doesn't grow on a failed pre-sign check.

## Verified RFC 3161 timestamps

`audit timestamp` and `audit anchor` obtain an RFC 3161 timestamp token over the audit chain head (or a manifest of all heads) and store it as a re-verifiable artifact. The token is **cryptographically verified**, not merely status-checked:

- The TSA's CMS (`SignedData`) signature over the `TSTInfo` is verified with the signer certificate's public key.
- The signer certificate must carry `extendedKeyUsage = id-kp-timeStamping` (RFC 3161 §2.3).
- The token's `messageImprint` must equal the digest we asked to be stamped — a valid token over *different* data is rejected.
- Optionally, the signer can be required to chain to a supplied trust anchor.

The authoritative result is surfaced as `cryptographicallyVerified` and recorded into the `audit.timestamped` / `audit.anchored` events. The legacy `granted` (PKIStatus) and `containsDigest` fields are retained for compatibility but are **not** trustworthy on their own.

TSA transport is HTTPS-only: `issueRfc3161Timestamp` refuses a plaintext `http://` TSA URL (a timestamp is a trust anchor and must not be downgradeable). A localhost TSA, or `SIGN_ALLOW_INSECURE_TSA=1`, is accepted for trusted local test servers.

## Keyed audit chain (optional HMAC)

By default the audit chain is an unkeyed SHA-256 hash chain: tamper-evident against a naive edit, but because the algorithm is public, anyone with write access to the database file could recompute a fully self-consistent forged chain. For deployments that need integrity against a local-file attacker, configure an HMAC key held **outside** the database:

- `SIGN_AUDIT_HMAC_KEY=<material>` — raw key, or
- `SIGN_AUDIT_HMAC_KEY_FILE=<path>` — file containing the key.

When a key is set, new audit events are written with `hash_algo = hmac-sha256` and their chain hash is an HMAC over the event body (with the algorithm bound in). Forging a keyed chain then requires the key, not just the algorithm. The design is:

- **Backward compatible.** Existing unkeyed chains hash byte-identically and keep verifying. Each row records its own `hash_algo`, so mixed-history databases verify correctly.
- **Fail-closed.** A keyed chain cannot be verified without the key — verification fails rather than silently skipping the integrity check.
- **Downgrade-resistant.** Once a chain has a keyed row, any later unkeyed (legacy) row is flagged as tampering, so an attacker can't "downgrade" the chain back to the forgeable scheme.

Keep the key in your secrets manager / KMS, not alongside the database. Losing the key means keyed history can no longer be verified (the events remain readable; only the integrity proof is lost).
