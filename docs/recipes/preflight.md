# Pre-production preflight (for agents)

Before any production signing flow, an agent should walk a fixed
preflight pipeline. This recipe is the canonical one — copy the script,
adapt the flags, branch on the exit codes.

The pipeline:

```
  ┌──────────┐    ┌────────────────────┐    ┌──────────────────────┐    ┌───────────────┐
  │  doctor  │ →  │  strict-provider   │ →  │  pdf stamp verify    │ →  │  audit export │
  │          │    │  banner check      │    │  (between sender +   │    │  (handoff)    │
  │          │    │                    │    │   signer)            │    │               │
  └──────────┘    └────────────────────┘    └──────────────────────┘    └───────────────┘
       │                   │                          │                         │
   exit 0/3            exit 0 +                   exit 0 / 3 / 4             exit 0 / 2 / 4
                       known banner
```

Each step is read-only **except** the last one (`audit export`), which is
idempotent per output path. Safe to re-run.

## 0. Environment

```bash
export SIGN_CLI_DB=/var/lib/sign-cli/prod.db
export SIGN_PROVIDER=dropbox
export SIGN_STRICT_PROVIDER=true                 # required for the §2 check
```

## 1. `sign doctor` — fail fast on environment problems

```bash
sign doctor > /tmp/doctor.json
DOCTOR_EXIT=$?
```

Branch:

```bash
if [ $DOCTOR_EXIT -ne 0 ]; then
  # Surface every failing check + its hint.
  jq -r '.checks[] | select(.status=="fail") | "[FAIL] \(.name): \(.message)\n  hint: \(.hint)"' \
    /tmp/doctor.json
  exit $DOCTOR_EXIT       # stop the pipeline; do NOT auto-repair
fi
```

What you get for free:

- `node` and `sqlite` versions confirmed before any DB work
- `provider` resolution made explicit (so step 2's banner check is meaningful)
- `dbPath` + `writable` confirmed before anything tries to insert
- `localSignerKey` confirmed (relevant only for `--provider local`; warn-not-fail otherwise)

**Decision rule**: never proceed past doctor on `exit 3`. Surface and stop.

## 2. Strict-provider sanity check

The banner is printed on stderr by every provider-touching command. With
`SIGN_STRICT_PROVIDER=true`, a mismatch fails before any state mutation.

```bash
# Capture the banner to confirm what the next command will resolve to.
sign request list 2>/tmp/banner.txt > /dev/null
grep -F "[sign] resolved provider: dropbox" /tmp/banner.txt \
  || { echo "banner mismatch — check SIGN_PROVIDER" ; exit 2 ; }
```

For a signing call against an existing request:

```bash
# This will error with STRICT_PROVIDER_MISMATCH if the request was
# created against a different provider.
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

Branch:

```bash
case $EXPORT_EXIT in
  0) ;;
  2) echo "bad flags" ; exit 2 ;;
  4) echo "request id $REQ not found in DB" ; exit 4 ;;
  *) echo "unexpected export failure" ; exit $EXPORT_EXIT ;;
esac
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

The bundle is **bundleVersion 2** — per-signer receipts under
`receipts/<email>.json` are isolated by construction, so you can hand
one signer's file to that signer without leaking another's events.

## 5. Putting it together

Full script — fail-closed, exit-code-driven, no human in the loop until
something actually goes wrong:

```bash
#!/usr/bin/env bash
set -euo pipefail

export SIGN_CLI_DB="${SIGN_CLI_DB:-/var/lib/sign-cli/prod.db}"
export SIGN_PROVIDER="${SIGN_PROVIDER:-dropbox}"
export SIGN_STRICT_PROVIDER=true

REQ="$1"; TOK="$2"; PDF="$3"

# 1. doctor
sign doctor > /tmp/doctor.json || {
  jq '.checks[] | select(.status=="fail")' /tmp/doctor.json
  exit 3
}

# 2. banner sanity
sign request list 2>/tmp/banner.txt > /dev/null
grep -qF "[sign] resolved provider: $SIGN_PROVIDER" /tmp/banner.txt

# 3. stamp verify (coords come from the sender's stamping step)
sign pdf stamp verify --pdf "$PDF" \
  --image-page 1 --image-x 100 --image-y 200 \
  --image-width 150 --image-height 60

# 4. sign (strict-provider will surface mismatches as exit 3)
sign sign --request-id "$REQ" --token "$TOK"

# 5. bundle for handoff
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
