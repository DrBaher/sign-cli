# Agent guide

Canonical reference for driving `sign-cli` from an LLM agent or any
non-interactive client. Optimized for machine parsing: every section is a
table, a code block, or a tight decision rule. Humans can read it top to
bottom; agents should grep to the section they need.

If you're new, run this first:

```bash
sign doctor preflight   # is the environment healthy? (exits 0 ok / 1 fail)
sign --catalog json     # what commands + flags exist?
sign mcp tools          # what MCP tools + schemas?
```

---

## 1. Output contract

| Stream | Content | Format |
|---|---|---|
| stdout | Successful command output | JSON (one document) unless a `--format` flag selects otherwise |
| stderr | Provider banner, progress lines, errors | Banner is one line; errors are the structured envelope below |
| exit code | Outcome class (see §2) | Integer, stable across commands |

### Error envelope

Every error printed to stderr is the same shape:

```jsonc
{
  "ok": false,
  "error": {
    "code": "STABLE_CODE",          // e.g. TOKEN_EXPIRED, STRICT_PROVIDER_MISMATCH
    "message": "human-readable",    // for logs / display
    "hint": "what to try instead",  // optional, present when actionable
    "details": { ... }              // optional, command-specific
  }
}
```

To get plain-text errors instead (legacy mode): `SIGN_ERROR_FORMAT=text`.
Stable codes are listed in `TROUBLESHOOTING.md`. New codes added in the
current `[Unreleased]` cycle:

| Code | Where | Meaning |
|---|---|---|
| `STRICT_PROVIDER_MISMATCH` | any provider-touching command, with `--strict-provider true` | resolved provider ≠ request's persisted provider |
| `PRE_RENDER_MISSING_PLACEHOLDERS` | `workflow nda` | template has `{{KEY}}`s with no value; `details.missing[]` lists all |
| `STAMP_VERIFY_WRONG_POSITION` | `pdf stamp verify` | stamp present but found ≠ expected; `details.found` carries actuals |
| `STAMP_VERIFY_MISSING` | `pdf stamp verify` | no stamp found on the given page |

---

## 2. Cross-command exit-code map

Stable across **every** command unless noted. Branch on these in your loop.

| Code | Meaning | Recovery |
|---|---|---|
| `0` | OK | proceed |
| `2` | Invalid input — missing/bad flag, malformed spec, schema error | read `error.message`; fix flags and retry |
| `3` | Policy / verification / chain failure — something is wrong with the data or the assertion failed | inspect output; do NOT retry blindly |
| `4` | Not found / out of range — request id, page index, file | confirm prerequisites; do NOT retry without a fix |

`request watch` adds one extra value:

| Code | Meaning |
|---|---|
| `0` | terminal: `completed` |
| `2` | terminal: `declined / rejected / expired / canceled / voided` |
| `3` | provider error or invalid remote status |
| `4` | timeout before any terminal status |

`sign doctor preflight`:

| Code | Meaning |
|---|---|
| `0` | `summary.verdict == "ok"` (every check passed or was skipped) |
| `1` | `summary.verdict == "failed"` (at least one check failed) |

(Bare `sign doctor` always exits 0 — it's a human-readable env report, not a structured check.)

---

## 3. Introspection

Three machine-readable entry points. None of them require network or DB.

```bash
sign --catalog json           # → { version, commands[] : { command, summary, flags[], example? } }
sign mcp tools                # → { tools[] : { name, inputSchema, outputSchema?, progressSchema? } }
sign <cmd> --help             # → human-readable, but stable enough to grep
```

`--catalog json` is the **truth** for command + flag inventory. If a flag
isn't there, it isn't a stable surface. The catalog is regenerated from
`src/lib/help-catalog.ts` at build time.

---

## 4. Preflight — `sign doctor preflight`

**Always your first call** in a fresh environment. (Note: it's `doctor preflight`, the subcommand — bare `sign doctor` is the legacy env-report and does not return a structured check list.)

```bash
sign doctor preflight                              # uses resolved provider
sign doctor preflight --provider local             # force a specific provider
SIGN_DB_PATH=./prod.db sign doctor preflight       # check a specific DB path
```

### Output

```jsonc
{
  "provider": "local" | "dropbox" | "signwell" | "docusign",
  "summary": {
    "passed":  <int>,
    "failed":  <int>,
    "skipped": <int>,
    "verdict": "ok" | "failed"
  },
  "checks": [
    {
      "name":   "<category>:<specific>",        // see check reference below
      "status": "ok" | "failed" | "skipped",
      "detail": "human-readable summary",
      "hint":   "what to do if not ok"          // present when status != ok
    }
  ]
}
```

Also prints a one-line stderr summary: `[sign] preflight: <verdict> (provider=<p>, N ok, N failed, N skipped)`.

### Check reference

Env-health checks run **on every provider** (they gate the basic ability to use the CLI):

| `name` | Verifies | On fail |
|---|---|---|
| `runtime:node_version` | Node ≥ 22 (node:sqlite requirement) | `hint: "Upgrade Node to 22 or later..."` |
| `storage:db_path` | `SIGN_DB_PATH` (default `./data/sign.db`) parent dir is writable | `hint: "...set SIGN_DB_PATH to a writable location."` |

Provider-scoped checks layer on top:

| Provider | Check name | Verifies |
|---|---|---|
| `local` | `permissions:key_dir` | `SIGN_LOCAL_KEY_DIR` (default `./data/local-keys`) writable |
| `local` | `permissions:store_dir` | `SIGN_LOCAL_STORE_DIR` (default `./data/local-provider`) writable |
| `local` | `fixture:canonical_unsigned` | `fixtures/canonical-unsigned-v1.pdf` present + non-corrupt |
| `dropbox` | `env:DROPBOX_SIGN_API_KEY` | env var set |
| `dropbox` | `connectivity:dropbox_account` | API call to Dropbox account endpoint succeeds (skipped if env missing) |
| `signwell` | `env:SIGNWELL_API_KEY` | env var set |
| `signwell` | `connectivity:signwell_account` | `/me` endpoint reachable |
| `docusign` | `env:DOCUSIGN_INTEGRATION_KEY` / `_USER_ID` / `_ACCOUNT_ID` / `_BASE_PATH` / `_PRIVATE_KEY_PATH` | env vars set |
| `docusign` | `permissions:docusign_private_key` | The JWT RSA key file exists on disk |

### Exit codes

| Code | Condition |
|---|---|
| `0` | `summary.verdict == "ok"` (every check passed or was skipped) |
| `1` | `summary.verdict == "failed"` (at least one check failed) |

### Decision rule

```text
exit 0 → proceed
exit 1 → for each check where status == "failed":
           apply `hint`, then re-run `sign doctor preflight`
         if a check keeps failing after one retry: surface to a human
```

Side effects: reads env + filesystem. The `storage:db_path` check writes (and removes) a probe file in the DB parent dir. Otherwise read-only. Idempotent.

### Legacy `sign doctor`

`sign doctor` (no subcommand) prints an unstructured env + key-detection report and **always exits 0**. It's kept for human glanceability. Use `sign doctor preflight` whenever you want a machine-readable result.

---

## 5. Provider resolution

### Banner

Every command that touches a provider prints one line to **stderr** before
any other output:

```
[sign] resolved provider: <provider> (<source>)
```

`<source>` is exactly one of:

| String | Meaning |
|---|---|
| `via --provider flag` | the `--provider` CLI flag was set |
| `via SIGN_PROVIDER env` | env var was set, no flag |
| `default — no flag, no SIGN_PROVIDER set` | nothing was set; fell back to `dropbox` |

### Resolution order

```
--provider flag  >  SIGN_PROVIDER env  >  default (dropbox)
```

### Strict mode

| Flag / env | Effect |
|---|---|
| `--strict-provider true` | refuse to operate if the resolved provider doesn't match the request's persisted provider |
| `SIGN_STRICT_PROVIDER=true` | same as flag |
| (unset) | mismatches are silently allowed (legacy behavior) |

On mismatch:

```jsonc
{
  "ok": false,
  "error": {
    "code": "STRICT_PROVIDER_MISMATCH",
    "message": "resolved provider 'local' does not match request provider 'dropbox'",
    "hint": "rerun with --provider dropbox, or unset --strict-provider"
  }
}
```

Production agents: always pass `--strict-provider true`. The cost of the
check is zero; the cost of signing against the wrong account is not.

---

## 6. New commands — per-command reference

### 6.1 `sign audit verify`

Walks the request's hash chain, emits a summary, exits with the verdict
class. There is no top-level `sign verify` alias — the canonical command is `sign audit verify`.

```bash
sign audit verify --request-id req_abc...
```

**Stdout** (single JSON document):

```jsonc
{
  "ok": true | false,
  "requestId": "req_abc...",
  "events": 12,
  "signers": 2,
  "chainValid": true | false,
  "anchorVerified": true | false   // when an anchor is present on the chain
}
```

**Exit codes**

| Code | Condition | Meaning for agent |
|---|---|---|
| `0` | `chainValid: true`, request found | proceed |
| `2` | missing `--request-id` or malformed | fix flags |
| `3` | `chainValid: false` — chain was tampered | escalate, do NOT auto-repair |
| `4` | request id not found in DB | check `request list` or accept upstream input is stale |

Side effects: **read-only**. Idempotent.

---

### 6.2 `sign pdf stamp verify`

Confirms a stamp's position on a previously-stamped PDF. Use it in CI
between "sender stamped" and "signer accepts" — catches a swapped or
moved image.

```bash
sign pdf stamp verify \
  --pdf ./signed.pdf \
  --image-page 1 --image-x 100 --image-y 200 \
  --image-width 150 --image-height 60
```

Tolerance: ±1 PDF point on every coordinate.

**Stdout**:

```jsonc
{
  "ok": true | false,
  "verdict": "ok" | "wrong_position" | "missing" | "out_of_range",
  "found": {                          // present for "wrong_position"
    "page": 1, "x": 100.0, "y": 200.0, "width": 150.0, "height": 60.0
  }
}
```

**Exit codes**

| Code | `verdict` | Recovery |
|---|---|---|
| `0` | `ok` | stamp matches — proceed |
| `3` | `wrong_position` | use `found` to either accept the new coords (if intentional) or escalate |
| `4` | `missing` | no stamp on that page — re-run `pdf stamp` |
| `4` | `out_of_range` | requested page exceeds the PDF — fix the page number |

Side effects: **read-only**. Idempotent.

---

### 6.3 `sign workflow nda`

One command: render the bundled mutual-NDA template into a PDF + create
the signing request. No intermediate steps to coordinate.

```bash
sign workflow nda \
  --values ./values.json \
  --party-a-email alice@example.com \
  --party-b-email bob@example.com \
  --out ./nda.pdf
```

**Inputs**

| Source | Field | Notes |
|---|---|---|
| `--values <file>.json` | `{{PLACEHOLDER}}` map | Every placeholder in the template must be present |
| `--value KEY=VALUE` | inline override | repeatable; wins over `--values` |
| `--party-a-email` / `--party-b-email` | signer emails | required; must differ — same email errors out |
| `--template <path>` | custom template | optional; defaults to `fixtures/templates/mutual-nda.md` |

Signer **names** are pulled from `PARTY_A_SIGNATORY` / `PARTY_B_SIGNATORY`
in the values map (so the values file owns identity).

**Stdout**:

```jsonc
{
  "ok": true,
  "templateUsed": "bundled" | "custom",
  "title": "Mutual NDA — <Party A> & <Party B>",
  "pdfPath": "./nda.pdf",
  "request": {
    "requestId": "req_...",
    "tokens": [
      { "signer": { "email": "alice@..." }, "token": "...", "expiresAt": "..." },
      { "signer": { "email": "bob@..."   }, "token": "...", "expiresAt": "..." }
    ]
  }
}
```

**Exit codes**

| Code | Condition | Recovery |
|---|---|---|
| `0` | request created | proceed: distribute tokens, then `request send` |
| `3` | validation error (same email, missing placeholders, values file unreadable) | inspect `error.code` + `error.details` |

**Failure modes** worth branching on:

- `code: "PRE_RENDER_MISSING_PLACEHOLDERS"` — `details.missing` lists **all** unresolved placeholders at once. Fill them, retry.
- `code: "INVALID_ARGS"` with message about emails — same email passed for both parties. Pick a different one.

Side effects: **writes** `--out` PDF + a new request row + N approval token rows + audit events. **Not idempotent** — re-running creates a second request. Use `--idempotency-key` on `request create` if you need idempotence for retries; for `workflow nda`, dedupe in the calling agent.

---

### 6.4 `sign audit export` (bundleVersion 2)

Produces a self-contained handoff bundle. Layout:

```
<out>/
├── audit.json
├── signed.pdf            (only when a signed PDF exists)
├── original.pdf          (byte-identical to the request's input)
├── manifest.json         (bundleVersion: 2, every file's sha256 + bytes)
├── README.md             (human-readable: request ID, signers, verify commands)
└── receipts/
    ├── <signer-a-email>.json
    └── <signer-b-email>.json
```

**Per-signer isolation guarantee**: each `receipts/<email>.json` contains
**only** events whose `payload.signerEmail` matches that signer. You can
hand one signer's receipt to that signer without disclosing the other's
events.

```bash
sign audit export --request-id req_abc... --out ./bundle/
```

**Manifest shape** (`bundle/manifest.json`):

```jsonc
{
  "bundleVersion": 2,
  "requestId": "req_abc...",
  "createdAt": "2026-05-12T...",
  "files": [
    { "name": "audit.json",                 "sha256": "...", "bytes": 12345 },
    { "name": "original.pdf",               "sha256": "...", "bytes": 87654 },
    { "name": "receipts/alice@example.json","sha256": "...", "bytes": 2345 },
    ...
  ]
}
```

**Exit codes**: `0` ok, `2` bad flags, `4` request not found.

Side effects: **writes** the bundle directory. Idempotent **per output
path** — re-running over the same `--out` regenerates the bundle and
overwrites in place. Safe to retry.

**Cryptographically-signed receipt (separate command)**: `sign request receipt --request-id <id> --out ./receipt/` produces a different bundle — `bundleVersion: 1`, with a detached `manifest.sig` + `manifest.cert.pem` so the manifest itself is openssl-verifiable. `sign request verify-receipt --bundle ./receipt/` re-verifies it. This is the right command when a downstream party wants to validate the bundle's integrity **without trusting your DB or your CLI**. The v2 `audit export` bundle has no detached signature; its integrity is the audit chain + file sha256s inside the bundle.

---

### 6.5 Trust labels — `request verify-signed-pdf`

The output's per-signer report carries a `trust` label classifying the certificate so an agent can branch without a trust-store lookup. The label is **descriptive, not enforced** — it tells you what kind of cert produced the signature, not whether to accept it.

```bash
sign request verify-signed-pdf --pdf ./signed.pdf
```

**Label values** (every `signatures[].signers[].trust`, defined in `src/lib/pdf-signature.ts:128`):

| Value | Meaning | Typical decision |
|---|---|---|
| `self_signed_local` | issuer == subject AND issuer contains "Sign CLI Local Provider" / "Sign CLI Local Signer" — produced by this CLI's built-in PAdES signer | accept iff your policy allows the local provider (production typically rejects unless you've enrolled the local-key fingerprint) |
| `self_signed_other` | issuer == subject, but not from this CLI's local signer | almost always reject — this is "someone else's self-signed cert" |
| `ca_signed` | issuer != subject — cert chains to a different issuer | accept; verify the chain separately if your policy requires |
| `unknown` | cert parse error or no cert present | reject |

Note: the label is **purely structural** (issuer vs subject + issuer-string matching) — there is no live trust-store lookup, expiry check, or chain validation built into the label. For expiry, use `validTo` on the signer entry. For chain validation, run an external verifier.

Side effects: **read-only**. Idempotent.

---

## 7. Decision recipes

Short "if X then Y" rules covering the common branching points.

### After `sign doctor preflight`

```text
checks[].status == "failed" with name == "runtime:node_version"
  → Node version too old. Surface to operator; do NOT attempt to upgrade
    Node unprompted.

checks[].status == "failed" with name == "storage:db_path"
  → SIGN_DB_PATH parent dir is not writable. Apply `hint`; do NOT mutate
    the user's filesystem unprompted.

checks[].status == "failed" with name starting "env:"
  → A provider env var is missing. Apply `hint`; ask the operator before
    setting credentials.

checks[].status == "failed" with name starting "connectivity:"
  → Provider API unreachable / auth failed. Read `detail` for the upstream
    error. Surface; retry only after the operator confirms the credential
    fix.

checks[].status == "failed" with name starting "permissions:"
  → Filesystem permission issue on a provider-specific path. Apply `hint`.

checks[].status == "skipped"
  → Means a prerequisite earlier in the list failed. Fix the prereq first,
    then re-run preflight.
```

### After `sign audit verify`

```text
exit 0  → trust the chain, proceed.
exit 3  → chain is tampered. Do NOT auto-repair. Capture the JSON,
          surface to a human, stop the workflow for this request.
exit 4  → request id is wrong upstream. Reject input, do not retry.
```

### After `sign pdf stamp verify`

```text
verdict "ok"             → proceed.
verdict "wrong_position" → branch on policy:
                             - strict: reject, surface `found`
                             - lenient: accept new coords if within
                               policy-defined drift
verdict "missing"        → either the PDF was swapped or the stamp
                           was never applied. Reject; ask the sender
                           to re-stamp.
verdict "out_of_range"   → bad caller input (page number too high).
                           Fix the caller; this isn't a stamping bug.
```

### After `request verify-signed-pdf`

```text
For each signer in signatures[*].signers[*]:

  trust == "ca_signed"           → accept (chain validates structurally;
                                   verify chain to trusted root separately
                                   if your policy requires).
  trust == "self_signed_local"   → accept iff policy allows this CLI's
                                   built-in local signer (typically only
                                   in dev / test).
  trust == "self_signed_other"   → almost always reject — unknown
                                   self-signed cert from outside.
  trust == "unknown"             → reject — cert couldn't be parsed.
```

There is no `worstTrust` field on the summary. To get the equivalent in jq:

```bash
jq -r '[.signatures[].signers[].trust] | min_by(
  if . == "ca_signed" then 3
  elif . == "self_signed_local" then 2
  elif . == "self_signed_other" then 1
  else 0 end)'
```

### After `workflow nda` error

```text
error.code == "PRE_RENDER_MISSING_PLACEHOLDERS"
  → error.details.missing[] lists every gap. Resolve them all
    in one retry, not one-at-a-time.

error.code == "INVALID_ARGS" and message mentions emails
  → same email passed twice. Pick a different one for party-b.
```

---

## 8. Side-effect + idempotency matrix

Quick reference for "is it safe to retry?"

| Command | Reads | Writes | Idempotent? |
|---|---|---|---|
| `doctor preflight` | env, fs | write probe under DB parent dir | yes |
| `audit verify` | DB | — | yes |
| `pdf stamp verify` | PDF | — | yes |
| `audit export` | DB, PDFs | `<out>/` (bundleVersion 2) | yes (overwrites in place) |
| `request receipt` | DB, PDFs, local signer key | `<out>/` with detached `manifest.sig` + `manifest.cert.pem` (bundleVersion 1) | yes (overwrites in place) |
| `request verify-receipt` | bundle | — | yes |
| `request verify-signed-pdf` | PDF | — | yes |
| `workflow nda` | template, values | PDF, DB rows, audit events | **no** — use `--idempotency-key` on `request create` if you build your own variant |
| `pdf stamp` | PDF, image | output PDF | yes per output path |
| `request create` | flags / spec | DB rows, audit events | yes with `--idempotency-key` |
| `request send` | DB | provider API, DB row updates | yes — refuses double-send unless `--force true` |
| `sign sign` | DB | DB rows, audit events, PDF | **no** — each token can sign at most once |
| `signer decline` | DB | DB rows, audit events | **no** — token is consumed |

Rule of thumb: anything that mutates a token (sign, decline) is
single-shot. Anything that produces a derived artifact (export, stamp,
render) is safe to re-run.

---

## 9. Patterns

### Pattern A — pre-flight gate before any mutation

```bash
sign doctor preflight > /tmp/doctor.json
PRE_EXIT=$?
if [ $PRE_EXIT -ne 0 ]; then
  jq -r '.checks[] | select(.status=="failed") | "[FAIL] \(.name): \(.detail)\n  hint: \(.hint)"' \
    /tmp/doctor.json
  exit $PRE_EXIT
fi
```

### Pattern B — strict provider in every script

```bash
export SIGN_STRICT_PROVIDER=true
export SIGN_PROVIDER=dropbox          # canonical for this script
# Now every sign-cli invocation in this script is locked to dropbox.
```

### Pattern C — verify trust, fail closed

```bash
sign request verify-signed-pdf --pdf "$PDF" > /tmp/inspect.json
# Reject anything that isn't a CA-signed cert (adjust to your policy).
WORST=$(jq -r '[.signatures[].signers[].trust] | min_by(
  if . == "ca_signed" then 3
  elif . == "self_signed_local" then 2
  elif . == "self_signed_other" then 1
  else 0 end)' /tmp/inspect.json)
if [ "$WORST" != "ca_signed" ]; then
  jq '.' /tmp/inspect.json    # surface for review
  exit 3
fi
```

### Pattern D — CI tamper-check between sender and signer

```bash
# Sender stamps at known coords:
sign pdf stamp --pdf in.pdf --image sig.png \
  --image-page 1 --image-x 100 --image-y 200 \
  --image-width 150 --image-height 60 \
  --out out.pdf

# Signer's CI re-verifies the position before signing:
sign pdf stamp verify --pdf out.pdf \
  --image-page 1 --image-x 100 --image-y 200 \
  --image-width 150 --image-height 60
# exit 0 → safe to sign
# exit 3 → stamp was moved; refuse
# exit 4 → stamp is missing or page out-of-range; refuse
```

---

## 10. Where to go next

- [`docs/recipes/preflight.md`](recipes/preflight.md) — pre-production
  agent recipe walking the doctor → strict → stamp-verify → bundle
  pipeline.
- [`docs/recipes/agent-loop-mcp.md`](recipes/agent-loop-mcp.md) — drive
  the same surface over MCP/stdio instead of CLI.
- [`docs/architecture.md`](architecture.md) — what the boxes are and
  how state flows between them.
- [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) — full error-code
  reference.
- `sign --catalog json` — always-current command + flag inventory.
- `sign mcp tools` — always-current MCP tool catalog with JSON Schemas.

**If something here disagrees with `sign --catalog json` or `--help`,
those are authoritative — please open an issue.**
