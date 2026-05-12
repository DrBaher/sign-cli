# Regression testing guide

Per-item manual regression tests for the surfaces shipped in the
`[Unreleased]` block of [`CHANGELOG.md`](../CHANGELOG.md). Use this when
you want to validate a build against expected behavior **outside** the
automated suite (`npm test`).

Tests are exit-code driven. If `set -e` is wired in your shell, every
expected-pass step exits 0; expected-fail steps state the expected
non-zero code in the table below the snippet.

## Setup (once per session)

```bash
cd /path/to/sign-cli
npm install && npm run build

# Sanity: automated suite passes.
npm test         # expect: tests 613, pass 612, fail 0, skipped 1

# Scratch workspace + absolute path to the built CLI.
export TEST=/tmp/sign-regress
rm -rf "$TEST" && mkdir -p "$TEST"
export SIGN=$(realpath dist/cli.js)
```

Conventions used below:

| Convention | Meaning |
|---|---|
| `SIGN_DB_PATH=...` | The DB env var. **Not** `SIGN_CLI_DB` (which the CLI ignores). |
| `echo "exit: $?"` | Always check the exit code — it carries the verdict. |
| `--provider local` | Default for the offline tests so no provider creds are needed. |

---

## Item 1 — strict provider + banner

The banner prints on every command that **resolves a provider for an action**
(`request create`, `request send`, `sign sign`, `request status`,
`workflow nda`, …). It does **not** print on read-only inbox queries like
`signer list` — that's by design.

### 1.1 / 1.2 / 1.3 — banner source on each resolution path

```bash
cd "$TEST" && rm -rf db && mkdir -p db
echo "doc" > doc.txt

# No flag, no env → default source
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" request create \
  --title T --document doc.txt --signer "name:A,email:a@e.com,order:1" \
  --auto-approve true 2>&1 | head -2

# Env set → env source (banner reflects local)
SIGN_DB_PATH=$PWD/db/s.db SIGN_PROVIDER=local node "$SIGN" request create \
  --title T --document doc.txt --signer "name:A,email:a@e.com,order:1" \
  --auto-approve true 2>&1 | head -2

# Flag beats env
SIGN_DB_PATH=$PWD/db/s.db SIGN_PROVIDER=dropbox node "$SIGN" --provider local \
  request create --title T --document doc.txt \
  --signer "name:A,email:a@e.com,order:1" --auto-approve true 2>&1 | head -2
```

Expected banner per run:

| Run | Stderr banner |
|---|---|
| 1.1 | `[sign] resolved provider: dropbox (default — no flag, no SIGN_PROVIDER set)` |
| 1.2 | `[sign] resolved provider: local (via SIGN_PROVIDER env)` |
| 1.3 | `[sign] resolved provider: local (via --provider flag)` |

### 1.4 — strict mismatch

```bash
cd "$TEST" && rm -rf db && mkdir -p db
echo "doc" > doc.txt

OUT=$(SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" --provider dropbox request create \
  --title T --document doc.txt --signer "name:A,email:a@e.com,order:1" 2>&1)
REQ=$(echo "$OUT" | grep -oE 'req_[a-f0-9]+' | head -1)
TOK=$(echo "$OUT" | python3 -c "import json,sys,re; o=json.loads(re.search(r'\{.*\}', sys.stdin.read(), re.DOTALL).group()); print(o['tokens'][0]['token'])")

SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" --provider local --strict-provider true \
  sign --request-id "$REQ" --token "$TOK" 2>&1 | tail -10
echo "exit: $?"
```

Expected: non-zero exit; error code `STRICT_PROVIDER_MISMATCH`; hint mentions
`--provider dropbox` and `--strict-provider`.

---

## Item 2 — `sign audit verify` exit codes

The canonical command is `sign audit verify` — there is no top-level
`sign verify`.

### JSON shape

```json
// happy path
{ "requestId": "req_...", "valid": true,  "events": 1, "break": null }

// tampered chain
{
  "requestId": "req_...",
  "valid": false,
  "events": 1,
  "break": { "kind": "hash_self_mismatch", "eventId": 1, "expected": "...", "actual": "..." }
}

// missing request id — generic error envelope, exit 1 (not 4)
{ "ok": false, "error": { "code": "INTERNAL", "message": "Request not found: req_..." } }
```

Note: the top-level key is **`valid`** (not `chainValid`). The happy path
has no `ok` field — exit code 0 is the success signal.

### Walkthrough

```bash
cd "$TEST" && rm -rf db && mkdir -p db
echo "v" > vdoc.txt

OUT=$(SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" --provider local request create \
  --title V --document vdoc.txt --signer "name:A,email:a@e.com,order:1" \
  --auto-approve true 2>&1)
REQ=$(echo "$OUT" | grep -oE 'req_[a-f0-9]+' | head -1)

# Happy path → exit 0, valid: true
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" audit verify --request-id "$REQ" | \
  jq -r '"valid=\(.valid) events=\(.events)"'
echo "exit: $?"

# Naive sqlite UPDATE → fails (exit 19 / runtime error). The audit_events
# table has BEFORE UPDATE / BEFORE DELETE triggers that RAISE(ABORT). This
# is a defense-in-depth signal worth checking: the audit chain cannot be
# silently rewritten via a stray UPDATE.
sqlite3 $PWD/db/s.db \
  "UPDATE audit_events SET payload_json='{}' WHERE id = (SELECT id FROM audit_events LIMIT 1);" 2>&1
echo "(should print: Runtime error: audit_events is append-only; UPDATE not permitted (19))"

# Real tamper, for exercising the audit-chain verification logic: use the
# documented `withAuditTamperingAllowed` helper to drop the triggers
# temporarily, mutate a row, then re-install. (This is the same pattern
# the unit tests use.)
DB=$PWD/db/s.db node -e "
  import('$PWD/../dist/lib/db.js').then(m => {
    const db = m.openDatabase(process.env.DB);
    m.withAuditTamperingAllowed(db, () => {
      db.exec(\"UPDATE audit_events SET payload_json='{}' WHERE id = (SELECT id FROM audit_events LIMIT 1);\");
    });
  });
"

# Tampered → exit 3, valid: false, break.kind = hash_self_mismatch
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" audit verify --request-id "$REQ" | \
  jq -r '"valid=\(.valid) break=\(.break.kind)"'
echo "exit: $?"

# Missing request id → exit 1 (NOT 4), generic error envelope on stderr
# (Note: 2>&1 because the error envelope is written to stderr; happy &
#  tampered envelopes go to stdout.)
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" audit verify --request-id req_nonexistent 2>&1
echo "exit: $?"
```

| Step | Expected exit | Expected JSON |
|---|---|---|
| Happy path | `0` | `"valid": true`, `"break": null` (stdout) |
| Naive sqlite `UPDATE` on `audit_events` | `19` (from sqlite) | `Runtime error: audit_events is append-only; UPDATE not permitted` |
| Tampered chain (after `withAuditTamperingAllowed`) | `3` | `"valid": false`, `"break.kind": "hash_self_mismatch"` (stdout) |
| Missing request id | `1` | `{ "ok": false, "error": { "code": "INTERNAL", ... } }` (**stderr**) |

> Important: adjust the `$PWD/../dist/lib/db.js` path in the node one-liner to
> point at your `sign-cli` build (e.g. `/path/to/sign-cli/dist/lib/db.js`).
> The helper is exported precisely so doc / test code can exercise the
> verification logic without committing a backdoor in the runtime path.

---

## Item 3 — `sign pdf stamp verify`

Tolerance is ±1 PDF point per coordinate.

```bash
cd "$TEST"
python3 -c "import base64; open('tiny.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='))"
cp /path/to/sign-cli/fixtures/canonical-unsigned-v1.pdf base.pdf

# Stamp at (100, 200) 150x60
node "$SIGN" pdf stamp --pdf base.pdf --image tiny.png \
  --image-page 1 --image-x 100 --image-y 200 --image-width 150 --image-height 60 \
  --out stamped.pdf

# Same position → exit 0
node "$SIGN" pdf stamp verify --pdf stamped.pdf \
  --image-page 1 --image-x 100 --image-y 200 --image-width 150 --image-height 60
echo "exit: $?"

# Wrong position → exit 3, found{} reports actual
node "$SIGN" pdf stamp verify --pdf stamped.pdf \
  --image-page 1 --image-x 400 --image-y 500 --image-width 150 --image-height 60
echo "exit: $?"

# Unstamped fixture → exit 4 verdict missing
node "$SIGN" pdf stamp verify --pdf base.pdf \
  --image-page 1 --image-x 100 --image-y 200 --image-width 150 --image-height 60
echo "exit: $?"

# Page out of range → exit 4
node "$SIGN" pdf stamp verify --pdf stamped.pdf \
  --image-page 99 --image-x 100 --image-y 200 --image-width 150 --image-height 60
echo "exit: $?"

# 0.5pt drift within tolerance → exit 0
node "$SIGN" pdf stamp verify --pdf stamped.pdf \
  --image-page 1 --image-x 100.5 --image-y 199.7 --image-width 150 --image-height 60
echo "exit: $?"
```

Expected: `0`, `3`, `4`, `4`, `0`.

---

## Item 4 — canonical unsigned PDF fixture

```bash
cd /path/to/sign-cli
ls -la fixtures/canonical-unsigned-v1.pdf
head -c 5 fixtures/canonical-unsigned-v1.pdf   # → %PDF-

EXPECTED=$(sha256sum fixtures/canonical-unsigned-v1.pdf | cut -d' ' -f1)
node dist/scripts/generate-canonical-unsigned-pdf.js
ACTUAL=$(sha256sum fixtures/canonical-unsigned-v1.pdf | cut -d' ' -f1)
[ "$EXPECTED" = "$ACTUAL" ] && echo "reproducible: OK" || echo "MISMATCH"

node -e 'import("./dist/lib/fixtures.js").then(m => console.log(m.canonicalUnsignedPdfPath()))'
```

Expected: file exists, `%PDF-` magic, regeneration produces identical
sha256, accessor returns an absolute path.

---

## Item 6 — `sign doctor preflight`

Note: the **subcommand**. Bare `sign doctor` is the legacy env-report and
always exits 0.

### 6.1 Happy path

```bash
cd "$TEST" && rm -rf db && mkdir -p db
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" doctor preflight --provider local
echo "exit: $?"
```

Expected: exit `0`, JSON with `{ provider: "local", summary: { verdict: "ok" }, checks: [...] }`. `checks[].name` should include:

| Check | Source |
|---|---|
| `runtime:node_version` | env-health (every provider) |
| `storage:db_path` | env-health (every provider) |
| `permissions:key_dir` | local provider |
| `permissions:store_dir` | local provider |
| `fixture:canonical_unsigned` | local provider |

### 6.2 Force a failure — unwritable DB path

```bash
mkdir -p "$TEST/ro" && chmod 0500 "$TEST/ro"

SIGN_DB_PATH=$TEST/ro/s.db node "$SIGN" doctor preflight --provider local
echo "exit: $?"

chmod 0700 "$TEST/ro"   # cleanup
```

Expected: exit `1`. In the output:
- `summary.verdict == "failed"`
- A check with `name: "storage:db_path"` has `status: "failed"`
- Its `hint` mentions `SIGN_DB_PATH`

### 6.3 Field-shape sanity

```bash
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" doctor preflight --provider local | \
  jq -e '
    .provider and
    (.summary | (.passed != null and .failed != null and .skipped != null and (.verdict == "ok" or .verdict == "failed"))) and
    (.checks | length > 0) and
    (.checks[] | (.name and (.status == "ok" or .status == "failed" or .status == "skipped") and .detail))
  ' && echo "shape: OK"
```

Expected: prints `shape: OK`.

---

## Item 7 — `sign workflow nda`

Already passes all 4 variations. Quick re-verify:

```bash
cd "$TEST" && rm -rf db && mkdir -p db

# Happy path
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" workflow nda \
  --values /path/to/sign-cli/fixtures/templates/mutual-nda.example.json \
  --party-a-email alice@example.com --party-b-email bob@example.com \
  --out ./nda.pdf | jq -r '.title, .templateUsed'
head -c 5 nda.pdf   # → %PDF-

# Same email → rejected
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" workflow nda \
  --values /path/to/sign-cli/fixtures/templates/mutual-nda.example.json \
  --party-a-email same@e.com --party-b-email same@e.com \
  --out ./out.pdf
echo "exit: $?"   # expect non-zero
```

Expected: happy path prints `Mutual NDA — Alpha Inc. & Beta GmbH` and `bundled`; same-email rejected with non-zero exit and an emails-must-differ error.

---

## Item 8 — `audit export` bundleVersion 2

For per-signer events to be **non-empty**, the request must actually be
signed — not just auto-approved. Auto-approved-but-never-signed requests
have empty per-signer arrays (by design, not a bug).

### Full signer round-trip

```bash
cd "$TEST" && rm -rf db && mkdir -p db
echo "doc" > doc.txt

OUT=$(SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" --provider local request create \
  --title T --document doc.txt \
  --signer "name:Alice,email:alice@e.com,order:1" \
  --signer "name:Bob,email:bob@e.com,order:2" \
  --auto-approve true 2>&1)
REQ=$(echo "$OUT" | grep -oE 'req_[a-f0-9]+' | head -1)
ALICE_TOK=$(echo "$OUT" | python3 -c "import json,sys,re; o=json.loads(re.search(r'\{.*\}', sys.stdin.read(), re.DOTALL).group()); print([t['token'] for t in o['tokens'] if t['signer']['email']=='alice@e.com'][0])")
BOB_TOK=$(echo "$OUT" | python3 -c "import json,sys,re; o=json.loads(re.search(r'\{.*\}', sys.stdin.read(), re.DOTALL).group()); print([t['token'] for t in o['tokens'] if t['signer']['email']=='bob@e.com'][0])")

SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" --provider local request send --request-id "$REQ" > /dev/null
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" sign --request-id "$REQ" --token "$ALICE_TOK" > /dev/null
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" sign --request-id "$REQ" --token "$BOB_TOK"   > /dev/null

# Export the v2 handoff bundle
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" audit export --request-id "$REQ" --out ./bundle
ls bundle/ bundle/receipts/
jq '.bundleVersion, (.files | length)' bundle/manifest.json
```

Expected bundle layout (per [`docs/architecture.md` §6](architecture.md)):

```
bundle/
  README.md
  audit.json
  manifest.json          (bundleVersion: 2)
  original.pdf
  receipts/
    alice@e.com.json
    bob@e.com.json
```

> Note: the `audit export` bundle does **not** include a `signed.pdf`. It
> exports the original document + the per-signer audit-event receipts so
> the chain can be re-verified independently — the signed PDF itself is a
> separate artifact fetched via `request fetch-final --out signed.pdf`.
> The manifest's `files` array lists exactly: `audit.json`, `original.pdf`,
> `receipts/<email>.json` (one per signer), and `README.md`. The
> `manifest.json` itself is not listed in its own `files` array (it's the
> manifest of the others).

### Per-signer isolation

```bash
echo "=== Alice's signerEmails ==="
python3 -c "import json; r=json.load(open('bundle/receipts/alice@e.com.json')); print(set(json.loads(e['payload_json']).get('signerEmail') for e in r['events']))"

echo "=== Bob's signerEmails ==="
python3 -c "import json; r=json.load(open('bundle/receipts/bob@e.com.json')); print(set(json.loads(e['payload_json']).get('signerEmail') for e in r['events']))"
```

Expected: Alice's set is exactly `{'alice@e.com'}`; Bob's is exactly `{'bob@e.com'}`.

### Manifest integrity

```bash
python3 - <<'PY'
import json, hashlib, pathlib, sys
b = pathlib.Path("./bundle")
m = json.loads((b / "manifest.json").read_text())
for f in m["files"]:
    actual = hashlib.sha256((b / f["name"]).read_bytes()).hexdigest()
    if actual != f["sha256"]:
        print(f"MISMATCH {f['name']}")
        sys.exit(3)
print("manifest sha256s: OK")
PY
```

Expected: `manifest sha256s: OK`.

### Cryptographically-signed receipt (separate command)

`audit export` does not produce a detached `.sig` / `.cert.pem`. For a
bundle that re-verifies **without trusting your DB**, use `request
receipt` (bundleVersion 1) and `request verify-receipt`:

```bash
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" request receipt --request-id "$REQ" --out ./signed-receipt
ls signed-receipt/   # manifest.json + manifest.sig + manifest.cert.pem + audit.json

SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" request verify-receipt --bundle ./signed-receipt | \
  jq -r '"ok=\(.ok) manifestVerified=\(.manifestVerified)"'
echo "exit: $?"
```

Expected: `ok=true manifestVerified=true`, exit `0`.

---

## `sign sign --name-signature` — render name as visible text

For when the signer has no image but wants a visible stamp. Renders the name in italic Helvetica at the given position. Mutually exclusive with `--signature-image`.

```bash
cd "$TEST" && rm -rf db && mkdir -p db
cp /path/to/sign-cli/fixtures/canonical-unsigned-v1.pdf doc.pdf

OUT=$(SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" --provider local request create \
  --title "Name-sig test" --document doc.pdf \
  --signer "name:Baher Al Hakim,email:baher@e.com,order:1" \
  --auto-approve true 2>&1)
REQ=$(echo "$OUT" | grep -oE 'req_[a-f0-9]+' | head -1)
TOK=$(echo "$OUT" | python3 -c "import json,sys,re; o=json.loads(re.search(r'\{.*\}', sys.stdin.read(), re.DOTALL).group()); print(o['tokens'][0]['token'])")

SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" --provider local request send --request-id "$REQ" > /dev/null

# Render the name as a visible italic signature in the lower-right corner.
# (Adjust coords to fit your document — these are points from the lower-left.)
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" sign --request-id "$REQ" --token "$TOK" \
  --name-signature "Baher Al Hakim" \
  --image-page 1 --image-x 360 --image-y 100 --image-width 180 --image-height 50
echo "exit: $?"

# Negative: both flags set → SIGN_VISIBLE_SIG_BOTH
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" sign --request-id "$REQ" --token bogus \
  --signature-image ./tiny.png --name-signature "X" \
  --image-page 1 --image-x 100 --image-y 200 --image-width 100 --image-height 50 2>&1 | tail -5
echo "(should contain SIGN_VISIBLE_SIG_BOTH)"

# Negative: --name-signature with no position → useful error with hint
SIGN_DB_PATH=$PWD/db/s.db node "$SIGN" sign --request-id "$REQ" --token bogus \
  --name-signature "X" 2>&1 | tail -5
echo "(should mention --image-page/--image-x/...)"
```

| Step | Expected |
|---|---|
| Happy path | exit `0`; visible italic "Baher Al Hakim" rendered on page 1 |
| Both flags | non-zero exit, error code `SIGN_VISIBLE_SIG_BOTH` |
| No position | non-zero exit, error mentions the position flags |

To verify the text actually rendered into the signed PDF (pdf-lib hex-encodes content stream text, so a raw `grep` won't find it):

```bash
node -e "
import('./dist/lib/pdf-image-stamp.js').then(async () => {
  const { readFileSync } = await import('node:fs');
  const { PDFDocument, decodePDFRawStream } = await import('pdf-lib');
  const pdf = await PDFDocument.load(readFileSync('./signed.pdf'));
  const Contents = pdf.getPage(0).node.Contents();
  let s = '';
  for (const ref of Contents.asArray()) {
    s += Buffer.from(decodePDFRawStream(pdf.context.lookup(ref)).decode()).toString('latin1');
  }
  const hex = Buffer.from('Baher Al Hakim','latin1').toString('hex').toUpperCase();
  console.log('rendered:', s.includes(hex));
});"
```

---

## Item 10 — trust labels

The enum has 4 values, defined at `src/lib/pdf-signature.ts:128`:

| Label | Meaning |
|---|---|
| `self_signed_local` | issuer == subject AND issuer matches this CLI's built-in local signer subject |
| `self_signed_other` | issuer == subject, but not from this CLI |
| `ca_signed` | issuer != subject |
| `unknown` | cert parse error or absent |

```bash
# Using the bundle/signed.pdf produced in Item 8
node "$SIGN" request verify-signed-pdf --pdf bundle/signed.pdf | \
  jq -r '.signatures[].signers[].trust'
```

Expected: every entry is `self_signed_local` (the local provider's
built-in cert). For any third-party PDF, the value will be `ca_signed`
(legitimate CA chain) or `self_signed_other` (unknown self-signed).

---

## End-to-end smoke

Fail-closed pipeline that exercises every shipped surface in one run:

```bash
cd "$TEST" && rm -rf e2e && mkdir -p e2e && cd e2e

SIGN_DB_PATH=$PWD/s.db node "$SIGN" doctor preflight --provider local > /tmp/doctor.json
[ $? -eq 0 ] || { jq '.checks[] | select(.status=="failed")' /tmp/doctor.json ; exit 1 ; }

# Render NDA + create request in one shot
OUT=$(SIGN_DB_PATH=$PWD/s.db node "$SIGN" --provider local workflow nda \
  --values /path/to/sign-cli/fixtures/templates/mutual-nda.example.json \
  --party-a-email alice@e.com --party-b-email bob@e.com \
  --out ./nda.pdf --auto-approve true 2>&1)
REQ=$(echo "$OUT" | grep -oE 'req_[a-f0-9]+' | head -1)
ALICE=$(echo "$OUT" | python3 -c "import json,sys,re; o=json.loads(re.search(r'\{.*\}', sys.stdin.read(), re.DOTALL).group()); print([t['token'] for t in o['request']['tokens'] if t['signer']['email']=='alice@e.com'][0])")
BOB=$(echo "$OUT" | python3 -c "import json,sys,re; o=json.loads(re.search(r'\{.*\}', sys.stdin.read(), re.DOTALL).group()); print([t['token'] for t in o['request']['tokens'] if t['signer']['email']=='bob@e.com'][0])")

# Send + both sign
SIGN_DB_PATH=$PWD/s.db node "$SIGN" --provider local request send --request-id "$REQ" > /dev/null
SIGN_DB_PATH=$PWD/s.db node "$SIGN" sign --request-id "$REQ" --token "$ALICE" > /dev/null
SIGN_DB_PATH=$PWD/s.db node "$SIGN" sign --request-id "$REQ" --token "$BOB"   > /dev/null

# Two bundle types
SIGN_DB_PATH=$PWD/s.db node "$SIGN" audit export      --request-id "$REQ" --out ./bundle-v2 > /dev/null
SIGN_DB_PATH=$PWD/s.db node "$SIGN" request receipt   --request-id "$REQ" --out ./bundle-v1 > /dev/null

SIGN_DB_PATH=$PWD/s.db node "$SIGN" request verify-receipt --bundle ./bundle-v1 | \
  jq -r '"v1: ok=\(.ok) manifestVerified=\(.manifestVerified)"'

SIGN_DB_PATH=$PWD/s.db node "$SIGN" audit verify --request-id "$REQ" | jq -r '"chain: ok=\(.ok)"'
```

Expected final two lines:

```
v1: ok=true manifestVerified=true
chain: ok=true
```

---

## What's NOT a regression

A few things in earlier reports looked like bugs but are actually
expected behavior:

| Observation | Why it's expected |
|---|---|
| Banner doesn't print on `signer list` | Read-only inbox queries don't resolve a provider for an action. Banner prints on mutating commands. |
| Per-signer receipt event arrays empty | Signer-action events (`request.signed_by_signer`, etc.) only fire on `sign sign`. Auto-approve does not. |
| `verify-receipt` returns `manifestVerified: false` on a v2 audit-export bundle | v2 has no `manifest.sig` — `verify-receipt` is for v1 bundles only (from `request receipt`). |

## Further reading

- [`docs/agent-guide.md`](agent-guide.md) — canonical agent reference (exit-code map, output schemas, decision rules).
- [`docs/recipes/preflight.md`](recipes/preflight.md) — narrative version of the smoke flow, with `set -e` script template.
- [`CHANGELOG.md`](../CHANGELOG.md) — what each item ships.
- `sign --catalog json` — machine-readable command + flag inventory.
