# Audit chain

The canonical reference for what `sign-cli`'s audit log proves and how to verify it.

## What the chain is

Every state-changing operation appends a row to the `audit_events` table with these columns:

- `event_type` — e.g. `request.created`, `request.signed_by_signer`, `request.signer_declined`.
- `payload` — a JSON blob of event-specific fields (`signerEmail`, `documentSha256`, request id, …).
- `hash_prev` — sha256 of the previous event's `hash_self`.
- `hash_self` — sha256 over `(event_type, payload, hash_prev, created_at)`.

A break in `hash_prev` ⇄ `hash_self` linkage means a row was tampered with, inserted, or deleted. `audit verify` walks the chain and reports the first broken link.

## Append-only enforcement

Two layers:

1. **DB triggers.** The migration that creates `audit_events` also installs an `BEFORE UPDATE` and `BEFORE DELETE` trigger that raises `cannot_modify_audit_events`. So even a process with direct SQLite access can't quietly rewrite history.
2. **Hash chain.** Even if a trigger is dropped (e.g. by replacing the DB file), the chain detects the resulting break.

## What the chain proves

- **Order.** Events are ordered by `created_at`, but the chain anchors that order — re-ordering rows breaks `hash_prev`.
- **Completeness.** A missing event breaks the next event's `hash_prev`. So a deletion is visible.
- **Authenticity of the chain itself.** Combined with an RFC 3161 anchor (below), the chain can't be silently extended backwards.

## What it doesn't prove

- **Identity of the signer.** That's the job of the per-signer PAdES cert in the signed PDF, not the audit log.
- **Document integrity.** The chain stores `documentSha256`; the PAdES envelope is what protects the bytes of the PDF itself.
- **Non-existence.** The chain proves a given event happened; it can't prove a missing event "should have been there."

## Verification

```bash
# Per-request
sign audit verify --request-id req_abc
# → { "requestId": "...", "valid": true, "events": 7, "break": null }

# Cross-request (the full log)
sign audit verify --all
```

Exit `0` if `chainValid: true`. Exit `3` if any break.

## RFC 3161 timestamp anchors

`audit anchor` (or the legacy `audit timestamp`) sends the current chain head to a public Timestamp Authority, gets back a signed token, and stores the (`anchor_id`, `tsa_response`, `head_hash`, `timestamp`) tuple in the `audit_anchors` table. Subsequent verification:

```bash
sign audit verify-anchor --anchor-id <id>
```

re-parses the TSA token and confirms the head hash hasn't drifted. This is what makes the chain *durably* tamper-evident — even if your DB and your machine are both compromised, the TSA's signature proves the chain looked a certain way at a specific UTC instant.

Companion commands: `audit anchors-list` (history), `audit chain-bundle` (export a portable verification bundle).

## What an auditor receives

`sign request receipt --request-id ... --out ./receipt/` produces a self-contained directory:

- `audit.json` — the full chain for this request.
- `manifest.json` — sha256s of every file in the bundle.
- `manifest.sig` — a detached PKCS#7 signature over `manifest.json`, signed by the local signer's cert.
- `manifest.cert.pem` — the local signer's certificate.
- `signed.pdf` — the signed PDF.
- `original.pdf` — the unsigned source (byte-identical to what was sent).
- `receipts/<signer-email>.json` — per-signer event subsets.

`sign request verify-receipt ./receipt/` re-checks all of this offline. The auditor doesn't need access to your DB.

## See also

- [exit-codes.md](exit-codes.md) — full code map.
- [security-model.md](security-model.md) — threat model: what the chain guarantees vs. what it doesn't.
- [architecture.md](architecture.md) — the boxes the chain lives in.
- [`audit anchor` recipe](../recipes/weekly-anchor.md) — production anchoring cadence.
