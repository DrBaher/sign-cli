# Sign as Alice (local provider)

A complete one-signer walkthrough using the offline local provider — no
external API keys, no network. Use this to learn the shape of the lifecycle
before pointing the CLI at a real provider.

## What you'll have at the end

- A signed PDF on disk
- A verified audit chain in SQLite
- A re-verifiable receipt bundle Alice (or her auditor) can keep

## 0. Set up the workspace

```bash
mkdir -p ./recipe-demo && cd ./recipe-demo
sign init                      # scaffolds .env + ./data/
echo 'mock contract' > nda.pdf
```

## 1. Create the request

```bash
sign request create \
  --title "Mutual NDA — Alice + Acme" \
  --document ./nda.pdf \
  --signer "name:Alice,email:alice@example.com,order:1" \
  --provider local
```

The response includes a `requestId` (e.g. `req_01h…`) and a one-shot
`tokens[0].token`. **Copy the token** — it won't appear again. Below we
assume you saved it as `$TOKEN` and the id as `$REQ`.

## 2. Send and sign

```bash
sign request send --request-id "$REQ" --provider local --test-mode true
sign sign --request-id "$REQ" --token "$TOKEN"
```

The local provider doesn't actually email anyone — it just records the
state transition. After this, `request.status == completed`.

## 3. Verify the lifecycle

```bash
# Cryptographic chain (every audit_event is hash-linked to the previous).
sign audit verify --request-id "$REQ"

# The signed PDF.
sign request fetch-final --request-id "$REQ" --provider local --out ./signed.pdf
sign request verify-signed-pdf --request-id "$REQ" --path ./signed.pdf

# Human-readable timeline.
sign audit show --request-id "$REQ" --format pretty
```

## 4. Issue a receipt for the auditor

```bash
sign request receipt --request-id "$REQ" --out ./receipt/
ls ./receipt/
# manifest.json  manifest.sig  manifest.cert.pem  audit.json  signed.pdf

# Re-verify (no DB needed — the bundle is self-contained).
sign request verify-receipt --bundle ./receipt/
```

## 5. (Optional) Hand off via web demo

```bash
sign serve --port 4000 --web-demo true &
# Visit http://127.0.0.1:4000/web-demo/index.html — paste the request id
# into the snapshot panel, run the audit-chain scan.
```

## What's next

- **[Weekly audit anchor](weekly-anchor.md)** — once you have many requests, anchor all their chain heads in one TSA call.
- **[Auditor handoff bundle](auditor-handoff.md)** — package the receipt + the most recent anchor for a compliance reviewer.
