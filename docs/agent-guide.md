# Agent guide

Canonical reference for driving `sign-cli` from an LLM agent or any
non-interactive client. Optimized for machine parsing: every section is a
table, a code block, or a tight decision rule. Humans can read it top to
bottom; agents should grep to the section they need.

If you're new, run this first:

```bash
sign doctor             # is the environment healthy?
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

`sign doctor`:

| Code | Meaning |
|---|---|
| `0` | every check is `ok` or `warn` |
| `3` | one or more checks are `fail` |

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

## 4. Preflight — `sign doctor`

**Always your first call** in a fresh environment.

```bash
sign doctor                                    # default
SIGN_CLI_DB=./prod.db sign doctor              # check a specific DB path
```

### Output

```jsonc
{
  "ok": false,
  "checks": [
    {
      "name": "node" | "sqlite" | "provider" | "dbPath" | "writable" | "localSignerKey",
      "status": "ok" | "warn" | "fail",
      "message": "human-readable summary",
      "hint": "what to do if not ok"      // present when status != ok
    }
  ]
}
```

### Check reference

| `name` | Verifies | Common fail/hint |
|---|---|---|
| `node` | Node ≥ 22 | `hint: "upgrade Node to 22 or later"` |
| `sqlite` | `node:sqlite` available | `hint: "rebuild Node with sqlite support"` |
| `provider` | `SIGN_PROVIDER` resolves to a supported value | `hint: "set SIGN_PROVIDER or pass --provider"` |
| `dbPath` | `SIGN_CLI_DB` resolves to a path | `hint: "set SIGN_CLI_DB or use --db"` |
| `writable` | The DB parent dir is writable | `hint: "chmod the directory, or pick a different SIGN_CLI_DB"` |
| `localSignerKey` | `data/local-keys/` cert + key exist & parse | `hint: "run sign demo once to generate them, or sign db rotate-keys"` |

### Decision rule

```text
exit 0 → proceed
exit 3 → for each check where status == "fail":
           apply hint, then re-run `sign doctor`
         if a check keeps failing after one retry: surface to a human
```

Side effects: reads filesystem + env. **No writes. Idempotent.**

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

### 6.1 `sign verify` / `sign audit verify`

Walks the request's hash chain, emits a summary, exits with the verdict
class.

```bash
sign verify --request-id req_abc...
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

**Backward compat**: `request export-receipt` + `request verify-receipt`
still emit/consume the older `bundleVersion: 1`. Use it if a downstream
consumer hasn't upgraded.

---

### 6.5 Trust labels — `request verify-signed-pdf --inspect`

The `--inspect` flag's per-signer report now carries a `trust` label and
the summary carries a `worstTrust` so an agent can branch on a single
field.

```bash
sign request verify-signed-pdf --pdf ./signed.pdf --inspect
```

**Label values** (every `signatures[].signers[].trust`):

| Value | Meaning | Decision |
|---|---|---|
| `trusted` | cert chains to a trusted root in `data/local-trust-store/` | accept |
| `untrusted-self-signed` | valid signature, but no trust chain to a known root | accept ONLY if your policy says self-signed is OK |
| `unverified` | chain validation failed (broken intermediate, etc.) | reject |
| `expired` | cert was expired at signing time | reject |
| `unknown` | cert parse error or no cert present | reject |

**Summary field**: `worstTrust` is the lowest-trust label across every
signer. Branch on `worstTrust === "trusted"` for a single-line policy.

Side effects: **read-only**. Idempotent.

---

## 7. Decision recipes

Short "if X then Y" rules covering the common branching points.

### After `sign doctor`

```text
checks[].status == "fail" with name == "writable"
  → permission/disk problem in the calling environment.
    Apply hint; do NOT mutate the user's filesystem unprompted.

checks[].status == "fail" with name == "localSignerKey"
  → safe to run `sign demo` once on a scratch DB to generate keys,
    then `sign doctor` again. NEVER run `sign db rotate-keys`
    without explicit human approval.

checks[].status == "fail" with name == "provider"
  → resolve --provider or SIGN_PROVIDER per §5. Do not pick one
    silently; ask the operator.
```

### After `sign verify` / `audit verify`

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

### After `request verify-signed-pdf --inspect`

```text
summary.worstTrust == "trusted"               → accept.
summary.worstTrust == "untrusted-self-signed" → accept iff policy allows
                                                self-signed; flag otherwise.
otherwise                                     → reject + surface.
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
| `doctor` | env, fs | — | yes |
| `verify` / `audit verify` | DB | — | yes |
| `pdf stamp verify` | PDF | — | yes |
| `audit export` | DB, PDFs | `<out>/` | yes (overwrites in place) |
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
sign doctor > /tmp/doctor.json
DOCTOR_EXIT=$?
if [ $DOCTOR_EXIT -ne 0 ]; then
  # Surface to operator, do not proceed.
  exit $DOCTOR_EXIT
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
sign request verify-signed-pdf --pdf "$PDF" --inspect > /tmp/inspect.json
if [ "$(jq -r '.summary.worstTrust' /tmp/inspect.json)" != "trusted" ]; then
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
