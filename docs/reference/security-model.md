# Compliance posture

What `sign-cli` does and doesn't prove. Read this before relying on the
audit chain in a regulated context — we'd rather you know the limits up
front than discover them in a deposition.

## Threat model in one paragraph

We assume an honest signing flow but a **potentially compromised
operator** at some future date. Specifically, we want a third party
(auditor, opposing counsel, regulator) to be able to confirm — without
trusting the operator's current database — that:

1. The signed PDF they're looking at is the same bytes that were signed
   when the request completed.
2. The audit chain hasn't been silently rewritten to hide events.
3. The chain existed in its current form on or before some external
   trusted timestamp.

Each of those gets a separate mechanism. None of them are perfect; the
gaps are documented below.

## What the chain actually proves

| Claim | Mechanism | What an attacker would need to forge it |
|---|---|---|
| "Event N hash-links to event N-1" | `audit_events.hash_self = sha256(stable_stringify({event,N-1.hash_self}))` | A hash collision (we use SHA-256) |
| "The chain hasn't been rewritten in place" | SQLite `BEFORE UPDATE/DELETE` triggers on `audit_events` raise + abort | Drop the trigger; trigger drops are themselves SQL writes you'd need to log |
| "The state on disk matches today's chain" | `sign audit verify --request-id <id>` recomputes hashes; `sign audit scan` does it for every chain | A second-preimage attack on SHA-256 |
| "The chain existed on date X" | `sign audit timestamp` (per-request) and `sign audit anchor` (cross-request) get an RFC 3161 TSA signature over the chain head digest | Compromise the TSA, *or* keep your forged DB consistent through every later anchor — anchoring weekly makes this rapidly impractical |
| "This receipt is what the system held" | `sign request receipt` writes a manifest signed by the local issuer cert; `verify-receipt` re-checks offline | Compromise the issuer cert *and* the .tsr's TSA |

## What it doesn't prove

- **Identity of the human.** The token that authorized a signature was
  issued to an email; we can prove the token was used, not that the
  named human used it. Tie tokens to your IdP for that — the CLI doesn't
  ship one.
- **Document semantics.** We hash bytes. "Did Alice know what she
  signed?" is a UX problem, not a cryptographic one.
- **Provider honesty.** When you use Dropbox Sign / DocuSign / SignWell,
  the provider's webhook says "completed". We record what they tell us;
  we can detect tampering of *our* records but not of *theirs*.
- **Time before the first anchor.** `audit timestamp` and `audit anchor`
  pin events to a moment in time, but only after they're issued. Events
  before your first anchor are vouched-for only by the next anchor's
  digest, which catches rewrites of those events but not their original
  timestamps.

## Operator hygiene that matters

- **Anchor on a cadence.** Weekly `sign audit anchor` is the gap-narrower.
  See [`docs/recipes/weekly-anchor.md`](recipes/weekly-anchor.md) for a
  cron pattern.
- **Keep the .tsr files off the same host.** A compromised operator who
  controls both the DB and the anchors can't rewrite history without
  burning a TSA signature, but they can rewrite history *and replay*
  the .tsr if they keep it. Ship them to a separate bucket / SIEM.
- **Don't delete the per-request receipt cert backups.** When you rotate
  signer keys (`sign db rotate-keys`), the previous cert+key are saved
  with a `.bak.<ts>` suffix in the same directory. Receipts signed by
  the old key remain verifiable as long as those backups exist (or you
  re-sign with `--re-sign-receipts true`).
- **Watch the rate-limit + read-only knobs on `sign serve`.** They're
  off by default; turn them on in production. See
  [`integrations/`](../integrations) for least-privilege MCP setup too.

## Threats we explicitly haven't tried to address

- **Side-channel leaks.** If the operator's DB host is rooted, the
  attacker has the same view a legitimate operator does.
- **Provider-key theft.** A stolen Dropbox Sign API key lets the thief
  impersonate the operator at the provider. We log signing events to
  the audit chain, but the chain doesn't constrain who could call into
  the provider's API.
- **Supply-chain attacks on this CLI.** We pin dependencies and check
  in `package-lock.json`; we don't sign the published binaries (today).
  Track [Releases](https://github.com/DrBaher/sign-cli/releases) for
  signed builds.

## Concrete checklist for an audit

For a third party who's reviewing a signed request:

```bash
# They want to see: this PDF, signed at this moment, by this signer,
# with a chain that ties back to a TSA-anchored digest.

sign audit chain-bundle --out ./bundle/ --tarball ./bundle.tar.gz \
  --include-source-pdf true --request-id <id>

# Hand them bundle.tar.gz. Their verification:
sign audit verify-chain-bundle --tarball bundle.tar.gz --report ./verdict.ndjson
echo "Exit: $?"   # 0 if the chain + receipt + anchor digest all verify.
```

That's the canonical handoff. If the verifier reports `ok: false` or
exits non-zero, the chain has either been rewritten or the bundle was
corrupted in transit. Keep both copies until they confirm.

## Reporting issues

Found a gap we haven't documented? Please open a [GitHub issue](https://github.com/DrBaher/sign-cli/issues)
or — if it's sensitive — see [`SECURITY.md`](../SECURITY.md) for the
private disclosure path.
