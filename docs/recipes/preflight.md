# Pre-production preflight (for agents)

Before any production signing flow, an agent should walk a fixed
preflight pipeline. This recipe is the canonical one — copy the script,
adapt the flags, branch on the exit codes.

The pipeline:

```
  ┌──────────────────┐    ┌────────────────────┐    ┌──────────────────────┐    ┌───────────────┐
  │ doctor preflight │ →  │  strict-provider   │ →  │  pdf stamp verify    │ →  │  audit export │
  │ (env + provider) │    │  banner check      │    │  (between sender +   │    │  (handoff)    │
  │                  │    │                    │    │   signer)            │    │               │
  └──────────────────┘    └────────────────────┘    └──────────────────────┘    └───────────────┘
       │                          │                          │                         │
   exit 0/1                  exit 0 + known banner       exit 0 / 3 / 4             exit 0 / 2 / 4
```

Each step is read-only **except** the last one (`audit export`), which is
idempotent per output path. Safe to re-run.

## 0. Environment

```bash
export SIGN_DB_PATH=/var/lib/sign-cli/prod.db          # NOT SIGN_CLI_DB
export SIGN_PROVIDER=dropbox
export SIGN_STRICT_PROVIDER=true                       # required for the §2 check
```

## 1. `sign doctor preflight` — fail fast on environment problems

Note: it's the `doctor preflight` **subcommand**. Bare `sign doctor` is the
legacy env-report and always exits 0.

```bash
sign doctor preflight > /tmp/doctor.json
DOCTOR_EXIT=$?
```

Branch:

```bash
if [ $DOCTOR_EXIT -ne 0 ]; then
  # Surface every failing check + its hint. Note the field is `detail`
  # (not `message`), and the failure status is `failed` (not `fail`).
  jq -r '.checks[] | select(.status=="failed") | "[FAIL] \(.name): \(.detail)\n  hint: \(.hint)"' \
    /tmp/doctor.json
  exit $DOCTOR_EXIT       # stop the pipeline; do NOT auto-repair
fi
```

What you get:

- **Env-health checks** (every provider): `runtime:node_version` (Node ≥ 22), `storage:db_path` (`SIGN_DB_PATH` parent writable; default `./data/sign.db`).
- **Provider-specific checks** (scoped to `SIGN_PROVIDER`):
  - `dropbox`: `env:DROPBOX_SIGN_API_KEY`, `connectivity:dropbox_account`
  - `signwell`: `env:SIGNWELL_API_KEY`, `connectivity:signwell_account`
  - `docusign`: env vars for integration key/user/account/base path + `permissions:docusign_private_key`
  - `local`: `permissions:key_dir`, `permissions:store_dir`, `fixture:canonical_unsigned`

**Decision rule**: never proceed past preflight on `exit 1`. Surface and stop.

## 2. Strict-provider sanity check

The banner is printed on stderr by every provider-touching command. With
`SIGN_STRICT_PROVIDER=true`, a mismatch fails before any state mutation.

The banner does **not** print on read-only inbox queries like `signer list`
— it prints on commands that resolve a provider for an action (`request
send`, `sign sign`, `request status`, `workflow nda`, etc.).

```bash
# This will error with STRICT_PROVIDER_MISMATCH if the request was
# created against a different provider — and the banner prints either way.
sign sign --request-id "$REQ" --token "$TOK" 2>/tmp/err.json
SIGN_EXIT=$?

if [ $SIGN_EXIT -ne 0 ] && grep -q STRICT_PROVIDER_MISMATCH /tmp/err.json; then
  echo "request's provider does not match this script — refusing to sign"
  exit 3
fi
```

**Decision rule**: trust `STRICT_PROVIDER_MISMATCH`. It's the signal that
saves you from signing against the wrong account.

## 3. `pdf stamp verify` — confirm the visible stamp wasn't moved

Use this between "sender stamped" and "signer signs" — anywhere the PDF
crossed a trust boundary.

```bash
EXPECTED_X=100
EXPECTED_Y=200
EXPECTED_W=150
EXPECTED_H=60

sign pdf stamp verify \
  --pdf ./incoming.pdf \
  --image-page 1 \
  --image-x $EXPECTED_X --image-y $EXPECTED_Y \
  --image-width $EXPECTED_W --image-height $EXPECTED_H \
  > /tmp/stamp.json
STAMP_EXIT=$?
```

Branch:

```bash
case $STAMP_EXIT in
  0)
    # verdict "ok" — proceed
    ;;
  3)
    # verdict "wrong_position" — `found` carries the actual coords
    jq '.found' /tmp/stamp.json
    echo "stamp moved; refusing to sign"
    exit 3
    ;;
  4)
    # verdict "missing" or "out_of_range"
    jq -r '.verdict' /tmp/stamp.json
    echo "stamp missing or page invalid; refusing to sign"
    exit 4
    ;;
esac
```

**Decision rule**: fail closed. A stamp that moved is the same signal as
a tampered document — refuse to proceed.

## 4. `audit export` — produce the handoff bundle

After every sign action completes, capture the bundle. This is the only
step that writes anything outside `/tmp`.

```bash
sign audit export --request-id "$REQ" --out "./bundles/$REQ"
EXPORT_EXIT=$?
```

Confirm the bundle integrity (manifest hashes match the files on disk):

```bash
python3 - <<'PY'
import json, hashlib, pathlib, sys
b = pathlib.Path("./bundles/$REQ")
m = json.loads((b / "manifest.json").read_text())
for f in m["files"]:
    actual = hashlib.sha256((b / f["name"]).read_bytes()).hexdigest()
    if actual != f["sha256"]:
        print(f"MISMATCH {f['name']}: expected {f['sha256']} got {actual}")
        sys.exit(3)
print("manifest verified")
PY
```

The bundle is **bundleVersion 2**. Per-signer receipts under
`receipts/<email>.json` are filtered by `payload.signerEmail`, so each
signer's file contains only their events.

Important caveat: per-signer event arrays are only populated by
signer-action events (`request.signed_by_signer`, `request.signer_declined`,
`request.signer_fetched_document`). If the request was auto-approved but
never actually signed (e.g. you ran `--auto-approve true` and stopped),
the per-signer receipts will be empty — that's correct, not a bug.

**Want a cryptographically-signed bundle that a third party can re-verify
without trusting your DB?** Use `sign request receipt` instead (or in
addition). That produces a v1 bundle with detached `manifest.sig` +
`manifest.cert.pem`:

```bash
sign request receipt --request-id "$REQ" --out ./receipt/
sign request verify-receipt --bundle ./receipt/
# → exits 0 with `manifestVerified: true` when the manifest's RSA
#   signature verifies against the embedded cert
```

## 5. Putting it together

Full script — fail-closed, exit-code-driven, no human in the loop until
something actually goes wrong:

```bash
#!/usr/bin/env bash
set -euo pipefail

export SIGN_DB_PATH="${SIGN_DB_PATH:-/var/lib/sign-cli/prod.db}"
export SIGN_PROVIDER="${SIGN_PROVIDER:-dropbox}"
export SIGN_STRICT_PROVIDER=true

REQ="$1"; TOK="$2"; PDF="$3"

# 1. preflight (env-health + provider-config)
sign doctor preflight > /tmp/doctor.json || {
  jq '.checks[] | select(.status=="failed")' /tmp/doctor.json
  exit 1
}

# 2. stamp verify (coords come from the sender's stamping step)
sign pdf stamp verify --pdf "$PDF" \
  --image-page 1 --image-x 100 --image-y 200 \
  --image-width 150 --image-height 60

# 3. sign — strict-provider surfaces account mismatches as non-zero
sign sign --request-id "$REQ" --token "$TOK"

# 4. bundle for handoff
sign audit export --request-id "$REQ" --out "./bundles/$REQ"
```

Every command exits non-zero on a problem, so `set -e` is enough — no
manual `$?` checks needed once the pipeline is wired this way.

## Further reading

- [`docs/agent-guide.md`](../agent-guide.md) — the canonical agent
  reference (output schemas, exit-code map, decision rules).
- [`docs/recipes/agent-loop-mcp.md`](agent-loop-mcp.md) — same idea, but
  driving the surface over MCP/stdio instead of CLI.
- [`docs/architecture.md`](../architecture.md) — what the boxes are.
