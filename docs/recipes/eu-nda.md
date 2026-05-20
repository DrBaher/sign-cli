# Recipe: mutual NDA between EU companies, signed via `sign-cli`

End-to-end workflow for the use case `docs/legal-posture.md` identifies as
**🟢 defensible**: a B2B mutual NDA between two known counterparties, where
both parties contractually consent to the e-signature method via the
clause baked into the template.

Total time: ~2 minutes. Total commands: 6.

## What you get

- A real PDF mutual NDA with both parties' details filled in
- A `sign-cli` request with per-signer approval tokens (TTL-bounded)
- A PAdES-signed final PDF that any PDF reader recognises as a digital
  signature
- A hash-chained audit trail you can verify offline a year later
- An exportable receipt bundle (`audit.json + signed.pdf + audit.tsr +
  manifest.json`) for retention

## Before you start

Read [`docs/legal-posture.md`](../legal-posture.md) — especially the
"EU NDAs deep-dive" section. The template includes the method-consent
clause that section recommends; the rest of this recipe assumes you're
comfortable with the trade-offs the legal posture doc spells out.

If your counterparty is in France, Italy, Belgium, or a public-sector
EU body, or if the disclosed information is genuinely catastrophic if
leaked, **stop and switch to provider-integrated mode** (Dropbox Sign,
DocuSign, or SignWell). The local provider's self-issued cert isn't
right for those cases.

## Step 1 — fill in the template

Copy the example variables file and edit the values:

```bash
cp fixtures/templates/mutual-nda.example.json my-nda.json
$EDITOR my-nda.json
```

The example values are illustrative — Alpha Inc. (US) and Beta GmbH
(Germany), 3-year term, German governing law. Replace with the real
parties, addresses, signatories, dates, and governing-law clause.

> Tip: `GOVERNING_LAW` and `JURISDICTION` should reflect what the
> Parties actually agreed. If you're unsure which jurisdiction to
> pick, Germany is the most permissive EU member state for SES — see
> the member-state table in `docs/legal-posture.md`.

## Step 2 — render the markdown template to PDF

```bash
node scripts/render-template.mjs \
  --template fixtures/templates/mutual-nda.md \
  --out my-nda.pdf \
  --vars my-nda.json
```

The renderer reports how many placeholders it resolved and how many
markdown blocks it laid out. If any placeholder is missing, the script
fails with the list of unresolved keys — no half-rendered PDF.

Open `my-nda.pdf` in a viewer and read it end-to-end before sending.
This is a contract, not a fire-and-forget operation.

## Step 3 — create a `sign-cli` request

```bash
sign request create \
  --title "Mutual NDA: Alpha Inc. / Beta GmbH" \
  --document my-nda.pdf \
  --signer name:"Carol Adams",email:carol@alpha.com,order:1 \
  --signer name:"Dieter Becker",email:dieter@beta.de,order:2 \
  --provider local \
  --auto-approve false
```

`--auto-approve false` is the important bit. The whole architecture
hinges on a human gesture per signature (one of the things that
materially strengthens the audit chain in court). Read
`docs/legal-posture.md` → "The thing that actually makes signatures
weak in court" if you're tempted to flip it.

The command emits each signer's approval token. Hand each token to
the human who will execute the corresponding signature — never to an
agent.

## Step 4 — approve and send

Once Carol and Dieter have their tokens (out-of-band — Slack, email,
phone, however your org gates human approvals):

```bash
sign approve --request-id <id> --token <carol-token>
sign approve --request-id <id> --token <dieter-token>
sign request send --request-id <id>
```

## Step 5 — each signer signs

Carol:

```bash
sign sign --request-id <id> --token <carol-token> \
  --signer-email carol@alpha.com
```

Dieter:

```bash
sign sign --request-id <id> --token <dieter-token> \
  --signer-email dieter@beta.de
```

> When the photo-signature feature (PR #144) lands you can pass
> `--signature-image carol.png --image-page <n> --image-x <pt> ...`
> here for a visible signature on top of the PAdES envelope.

## Step 6 — fetch the final PDF and the receipt bundle

```bash
sign request fetch-final --request-id <id> --out my-nda.signed.pdf
sign audit timestamp --request-id <id>     # RFC 3161 anchor (optional but recommended)
sign audit export --request-id <id> --out ./nda-bundle/
```

`./nda-bundle/` contains everything an auditor would need:

- `signed.pdf` — the PAdES-signed contract
- `audit.json` — hash-chained event log
- `audit.tsr` — the RFC 3161 timestamp (if you ran step 6b)
- `manifest.json` — a signed manifest tying the three together

Retain the bundle for at least the contract's survival term (the
example template's `SURVIVAL_YEARS` defaults to 5). Storage is small
(~30 KB per request) so a long retention horizon is cheap.

## What this gives you, evidentially

If the NDA is ever disputed, you can show a court:

1. The signed PDF, with PAdES envelope intact and the byte-range
   digest matching (verifies via `sign request verify-signed-pdf`).
2. The audit chain showing: approval tokens issued to each signer's
   verified business email, opened and approved by a human, sign
   event recorded with timestamp and cert fingerprint.
3. The RFC 3161 timestamp anchoring the chain head to a point in
   time the counterparty's IT team can't have rewritten.
4. The NDA itself, containing the method-consent clause both
   parties signed under.

That bundle, for typical inter-company NDAs in EU member states with
permissive contract-form rules, is a defensible position. It is **not**
QES; it is a strong Simple Electronic Signature with an unusually
clean evidentiary chain.

## When this recipe is the wrong tool

Same list as the legal-posture doc, repeated here for ease:

- 🔴 NDAs with public-sector EU entities — need AdES or QES
- 🔴 NDAs underpinning M&A deals at €1M+ scale — use provider-integrated mode
- 🔴 NDAs covering pre-filing patents or irreplaceable trade secrets — get a lawyer
- 🔴 NDAs with parties in France, Italy, or Belgium for serious commercial purposes — formalist courts; stronger evidentiary tier recommended

In all those cases, the same `sign-cli` orchestration + audit chain
works perfectly well — just swap `--provider local` for
`--provider docusign` (or `dropbox` / `signwell`) and you get a
provider-issued cert on top of the same workflow.
