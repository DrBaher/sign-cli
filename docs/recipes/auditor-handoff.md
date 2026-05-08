# Auditor handoff bundle

A compliance reviewer needs to confirm — without access to your live DB —
that:

1. Each signed request has a verifiable receipt.
2. The set of chains has been continuously anchored against an external
   trusted timestamp.

`sign audit chain-bundle` packages exactly that.

## What the bundle contains

```
bundle/
├── INDEX.json                         # version, generatedAt, anchor + per-request stats
├── anchor/
│   ├── audit-anchor-<ts>.tsr          # most recent RFC 3161 anchor (if any)
│   └── audit-anchor-<ts>.manifest.json
└── requests/
    └── <requestId>/                   # per-request receipt bundle
        ├── manifest.json
        ├── audit.json
        ├── signed.pdf
        ├── manifest.sig
        ├── manifest.cert.pem
        └── source.pdf                 # only if --include-source-pdf was set
```

Self-contained: an auditor with just this directory can verify the seal.
The DB stays on your side.

## 0. Issue a fresh anchor first (recommended)

```bash
sign audit anchor --tsa-url http://timestamp.digicert.com --out ./artifacts/
```

The bundle picks up the most recent anchor automatically.

## 1. Build the bundle

```bash
sign audit chain-bundle \
  --out ./bundle/ \
  --tarball ./bundle.tar.gz \
  --include-source-pdf true
```

The `--tarball` writes a portable `.tar.gz` (POSIX USTAR) alongside the
on-disk directory; `--include-source-pdf` copies the unsigned source into
each receipt dir so the auditor can re-hash it against the recorded
`document_hash`.

## 2. Hand off

Email/SFTP the tarball. Include a one-line note:

> Verify with `sign audit verify-chain-bundle --tarball bundle.tar.gz`
> (or `--bundle ./bundle/` after extracting).

## 3. The auditor's side

```bash
sign audit verify-chain-bundle --tarball bundle.tar.gz --report ./verdict.ndjson
echo "Exit: $?"   # 0 if everything verifies, 3 otherwise.
jq -c '. | {requestId, ok}' verdict.ndjson | head
# {"requestId":"req_...","ok":true}
# {"requestId":"req_...","ok":true}
# {"summary":true,"passed":42,"failed":0}
```

The verifier:

- Recomputes the anchor manifest digest and matches it against `INDEX.json`'s
  recorded `digestHex`.
- Runs `verifyRequestReceiptBundle` on every per-request directory.
- Streams a per-request NDJSON line to `--report` (great for Splunk/Elastic
  ingestion).

## Bundle scope

By default, every request that has audit events is included. To scope
down (e.g. one tenant, one quarter):

```bash
sign audit chain-bundle \
  --out ./bundle-tenant-acme/ \
  --request-id req_abc \
  --request-id req_def \
  --request-id req_ghi
```

## What's next

- [Weekly audit anchor](weekly-anchor.md) — keep issuing anchors so each
  bundle's `anchor/` reflects something fresh.
- [Agent loop over MCP](agent-loop-mcp.md) — let an MCP agent trigger the
  bundle on demand.
