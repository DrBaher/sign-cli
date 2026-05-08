# Weekly audit anchor

A cron-friendly recipe that produces a continuity proof for every audit
chain in your DB. Re-running this weekly catches any tampering with old
chains: an attacker who rewrites history breaks the digest in every
later anchor that covered the rewritten chain.

## What an anchor is

`sign audit anchor` takes a snapshot of every request's current chain
head, hashes the sorted manifest, and gets a single RFC 3161 timestamp
over that digest. The output:

```
artifacts/audit-anchor-<ts>.tsr            ← TSA's signed timestamp
artifacts/audit-anchor-<ts>.manifest.json  ← {requestId, hashSelf}[] sorted
```

One file pair per anchor. Both are independently verifiable later.

## 0. Dry-run to preview

Before burning a TSA round-trip, see what would be anchored:

```bash
sign audit anchor --dry-run true | jq '{ digestHex, total: (.manifest|length) }'
# {
#   "digestHex": "1a2b...c0de",
#   "total": 142
# }
```

If `total` is 0, you have no audit events yet — the anchor would fail.

## 1. Issue the anchor

```bash
sign audit anchor \
  --tsa-url http://timestamp.digicert.com \
  --out ./artifacts/
```

Stdout returns the report (digest, manifest length, file paths). The
generated `.tsr` is the cryptographic seal — don't move it.

## 2. (Optional) Selective anchoring

Once you've anchored once, future anchors only need to cover chains that
have moved. Pair `audit anchor --since-anchor latest` with `signer policy
run-watch --since-anchor latest` for matching cutoffs:

```bash
sign audit anchor --since-anchor latest --tsa-url http://timestamp.digicert.com
```

## 3. Verify next week

```bash
sign audit verify-anchor --manifest ./artifacts/audit-anchor-<ts>.manifest.json
```

Per-row verdict for each chain:

| outcome | meaning |
|---|---|
| `matches` | head is exactly what was anchored |
| `shifted` | chain progressed (typical — `audit.anchored` events were appended) |
| `tampered` | anchored hash is gone — strong signal of rewrite |
| `missing` | request_id no longer exists |

Exits 3 if any chain is tampered or missing.

## 4. List historical anchors

```bash
sign audit anchors-list --limit 10 | jq '.anchors[] | {digestHex, createdAt, coveredRequests}'
```

## Cron pattern

```cron
# Anchor every Monday at 03:00, fail loudly on TSA outages.
0 3 * * 1 cd /var/sign && /usr/local/bin/sign audit anchor \
    --tsa-url http://timestamp.digicert.com \
    --out /var/sign/anchors/ \
  >> /var/log/sign-anchor.log 2>&1
```

## What's next

- [Auditor handoff bundle](auditor-handoff.md) — package the most recent anchor + per-request receipts for an external reviewer.
- [Agent loop over MCP](agent-loop-mcp.md) — let an LLM agent watch the chains and trigger ad-hoc anchors.
