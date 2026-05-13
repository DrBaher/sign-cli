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

**Stdout** (single JSON document — happy / tampered):

```jsonc
{
  "requestId": "req_abc...",
  "valid": true | false,
  "events": 12,
  "break": null | {
    "kind": "hash_self_mismatch" | "hash_prev_mismatch",
    "eventId": 1,
    "expected": "<sha256>",
    "actual": "<sha256>"
  }
}
```

**Stderr** (only when the request id is not found in the DB — generic
error envelope, exit 1):

```jsonc
{ "ok": false, "error": { "code": "INTERNAL", "message": "Request not found: req_..." } }
```

The happy/tampered shape and the missing-request shape are deliberately
different — **exit code is the primary verdict, JSON is secondary**.
Branch on `$?`, then parse stdout (happy/tampered) or stderr (missing).
Do not assume a top-level `ok` key is present on the happy path.

**Exit codes**

| Code | Condition | Where verdict lives | Meaning for agent |
|---|---|---|---|
| `0` | request found, chain intact | stdout: `valid: true`, `break: null` | proceed |
| `3` | request found, chain tampered | stdout: `valid: false`, `break.kind` names the mismatch | escalate, do **not** auto-repair |
| `1` | request id not found in DB *or* CLI usage error | stderr: `{ ok: false, error.code }` | check `request list`, or fix flags |

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

### 6.4a `sign pdf detect-signature-field` + `sign sign --auto-place`

Auto-detection of where to put a visible signature. Two related surfaces:

**`sign pdf detect-signature-field --pdf <path>`** (stand-alone introspection):

```jsonc
{
  "ok": true,
  "pdf": "./nda.pdf",
  "pageCount": 1,
  "acroFormFields": 0,
  "anchorMatches": 1,
  "candidates": [
    {
      "page": 1, "x": 140, "y": 196, "width": 140, "height": 35,
      "source": "anchor:Signature:",     // or "acroform"
      "confidence": 0.95,                // 0.0–1.0
      "adjustedFrom": "underline-snap",  // none | underline-snap | whitespace-probe | shrink-to-fit
      "anchorText": "Signature:"         // only for anchor sources
    }
  ]
}
```

Exit `0` when candidates were found, exit `2` when none. The JSON is emitted on stdout either way (empty `candidates` array on exit 2).

**`sign sign --auto-place <selector>`** consumes the same detection. The selector value picks how to handle multi-candidate cases:

| Value | Meaning |
|---|---|
| `true` (or `yes` / `1`) | Legacy: require a **unique** high-confidence candidate. Errors `AUTO_PLACE_AMBIGUOUS` when multiple. |
| `first` | Earliest page, top-of-page first (highest y). |
| `last` | Latest page, bottom-of-page first (lowest y). |
| `all` | Multi-stamp — stamp at **every** high-confidence candidate. The same image + options are replayed at each position. |
| `page:N` | The unique candidate on page `N`. Errors `AUTO_PLACE_PAGE_NOT_FOUND` or `AUTO_PLACE_PAGE_AMBIGUOUS`. |
| `index:N` | The `N`-th candidate (0-indexed from the confidence-sorted list). Errors `AUTO_PLACE_INDEX_OUT_OF_RANGE`. |



| Outcome | Exit | Error code | Behavior |
|---|---|---|---|
| Unique candidate with confidence `≥ 0.8` | `0` | — | Uses it. Notice on stderr names source, confidence, adjustment method, rect. |
| Multiple high-confidence candidates | non-zero | `AUTO_PLACE_AMBIGUOUS` | Errors with the full candidate list in `details.candidates`. Caller picks. |
| No high-confidence candidates | non-zero | `AUTO_PLACE_NO_HIGH_CONFIDENCE` | Errors. Low-confidence candidates (if any) in `details.candidates`. |
| No visible-signature flag set | non-zero | `AUTO_PLACE_REQUIRES_VISIBLE_SIG` | Pass `--signature-image` or `--name-signature`. |
| Explicit `--image-*` coords also set | `0` | — | Explicit wins. Notice on stderr: `--auto-place ignored: explicit ... supplied`. |

**Adjustment methods explained**:

| Method | Confidence | When |
|---|---|---|
| `none` | `1.0` | AcroForm `/Sig` widget — rectangle taken verbatim from the PDF. |
| `underline-snap` | `0.95` | Anchor immediately followed on the same baseline by an underscore run (`____`) or dashes. Snaps to the run's width. |
| `below-anchor-probe` | `0.85` | Anchor alone on its line + vertical whitespace below. Rectangle placed BELOW the anchor, left-aligned with it. French/European convention: "Signature" on its own line, sign below. |
| `whitespace-probe` | `0.75` (or `0.60` if narrow) | Anchor followed by empty space on the same line; uses the gap up to the next text or page right margin. English-form convention. |
| `shrink-to-fit` | `0.50` | Default 180×50 rect iteratively shrunk by 10% until no text overlap. Rejected entirely if width drops below 60pt. |

**Strategy ordering**: `underline-snap` → (if anchor is alone on its line) `below-anchor-probe` first → `whitespace-probe` → (else) `below-anchor-probe` as fallback → `shrink-to-fit`. The "alone on line" check switches the heuristic between **English** ("Signature: \_\_\_\_\_\_\_" — fill in to the right) and **European** ("Signature" alone — sign below) conventions.

**Page-width clamp**: right-side strategies (`whitespace-probe`, `shrink-to-fit`) clamp their right edge to `pageWidth − 36pt` so anchors near the page-right margin can't produce rectangles that run off the page.

**Debugging zero candidates**: pass `--verbose true` to `sign pdf detect-signature-field` to dump the raw pdfjs text items per page plus page dimensions. This tells you exactly what text pdfjs extracted (and where it's positioned) so you can decide whether the gap is a missing anchor pattern, an embedded-font-without-ToUnicode problem (text comes through as glyph indices), or a signature line drawn as path operators rather than text (pdfjs's `getTextContent` doesn't see those).

**Safety contract**: a candidate is never emitted if its rectangle overlaps any non-whitespace text on the page. By the time the JSON reaches the caller, the rectangle is safe to stamp. This is the explicit fix for the silent-overlap-with-body-text failure mode from earlier builds.

**Caveats**:

- Anchor patterns are English-only (`Signature:`, `Sign here:`, `Signed by:`, `Initial:`, `X____`). Non-English documents need AcroForm `/Sig` fields or explicit `--image-*` coords.
- Dependency: pulls in `pdfjs-dist` for text-position extraction. The `detect` command and `--auto-place` are the only paths that need it; the rest of the CLI never imports it. A `postinstall` hook (`scripts/trim-pdfjs-dist.mjs`) drops the non-legacy build, viewer assets, image/WASM decoders, CJK cmaps, standard fonts, and all sourcemaps, bringing the installed footprint from ~36 MB to **~7.5 MB**. The trim is idempotent and only ever touches our own copy (skips if pdfjs-dist is hoisted out of our `node_modules` tree as a peer of a consuming project).
- The detector does **not** parse PDF content streams for line operators — underline detection uses underscore-character runs in the text items (which catches the common `_______` pattern but misses underlines drawn as path operators).

Side effects: read-only. Idempotent.

---

### 6.5 Visible signatures on `sign sign`

By default `sign sign` produces only the invisible PAdES envelope. For a visible stamp on the page, pass **one** of:

| Flag | Visible result | When to use |
|---|---|---|
| `--signature-image <path \| data-url>` | The image (PNG/JPG/SVG/data-URL) drawn at the resolved position | You have a real handwritten-signature image |
| `--name-signature <text>` | The text rendered in italic + underline (pdf-lib StandardFonts.HelveticaOblique) | You don't have an image; just want the name as a signature |
| `--name-signature true` | Same as above, but uses `--signer-name <text>` as the rendered string | Agent flows where the signer name is already a flag |

Both paths use the **same position resolution**:
1. `--image-page/--image-x/--image-y/--image-width/--image-height` (explicit), OR
2. The `--field signer:N,page,x,y,width,height,type:signature` placement the sender set at `request create` time

If neither resolves a position and a visible-signature flag was passed, the command errors with a hint explaining both options.

Mutual exclusion: passing **both** `--signature-image` and `--name-signature` errors with `code: "SIGN_VISIBLE_SIG_BOTH"`. Pick one.

**Aspect ratio & auto-crop** (PR A):

- `--preserve-aspect-ratio` (default `true`) shrinks the image to fit inside the rectangle (top-left aligned) so it's never stretched. Pass `false` to restore the legacy stretch-to-fill behavior.
- `--signature-image-auto-crop true` (PNG only) trims white/transparent margins around the ink and replaces near-white opaque pixels with transparent ones — removes the white-rectangle-around-signature look from scanned-on-paper signature photos. Silent no-op on JPG/SVG or unsupported PNG subsets (16-bit, interlaced, palette).

**Quality warnings**: every visible-signature flow (`sign sign --signature-image`, `sign pdf stamp`) emits a `warnings` array with these codes when they apply:

| Code | When |
|---|---|
| `STAMP_OFF_PAGE` | Rectangle extends past page bounds (severity: `error`) |
| `STAMP_OUTSIZED_VS_TEXT` | Stamp height > 5× the median body-text line height on the page |
| `STAMP_OVERLAPS_TEXT` | Stamp rectangle intersects one or more text bboxes |
| `ASPECT_RATIO_DISTORTED` | Drawn aspect differs from the image's natural aspect by >5% — only fires when `--preserve-aspect-ratio false` was used |

Pass `--strict-quality true` to `sign pdf stamp` to exit non-zero (code `3`) when any warning fires. Default is advisory: warnings appear in the JSON output and the command still exits `0`.

**Important caveats**:

- Neither produces a "cursive forged-handwriting" look. `--name-signature` renders in italic Helvetica — recognizable as a signature stamp, not a forgery of someone's hand. For a real cursive look, prepare an SVG/PNG of the signature and pass it via `--signature-image`.
- The stamp is part of the **signed bytes** (placed before PAdES sealing), so any post-signing tamper breaks the cryptographic verification.
- Default placement may overlap existing text on a pre-formatted document. The CLI does **not** auto-detect a safe rectangle — pass explicit `--image-*` coords, or have the sender place a SignatureField with `--field` at create time.

Side effects: writes to the signed PDF (the same write the rest of `sign sign` does). Per-signer state: each token signs at most once, so this is **not** idempotent — use `--idempotency-key` if you need retry safety.

---

### 6.4c `sign document` — one-shot end-to-end signing

Single command that goes from DOCX (or PDF) input to a sealed PDF on disk.

```bash
sign document contract.docx \
  --signer "Baher Al Hakim" \
  --signature-image baher.png \
  --auto-place first \
  --out signed.pdf
```

What runs under the hood, in order:

1. **DOCX → PDF** if the input extension matches `.docx`, `.doc`, `.odt`, or `.rtf`. Delegated to the bundled [`docx2pdf-cli`](https://github.com/DrBaher/docx2pdf-cli) companion CLI, which auto-selects an available backend (LibreOffice, Pages, Word, Gotenberg, ConvertAPI, textutil-cups). PDF inputs skip this step. The integration is intentionally **thin** — `sign document` does not re-export `docx2pdf-cli`'s flags. For backend control or batch conversion, run `docx2pdf` directly first.
2. **Auto-place detection** runs over the (converted) PDF to find the signature anchor rectangle. Default selector is `first` (top-most anchor) — most one-shot flows have a single `Signature:` line. Pass `--auto-place all|last|page:N|index:N` to override.
3. **Stamp + PAdES seal** using a **temp database** scoped to this invocation (audit events, signer records, key material all live in `/tmp/sign-document-<random>/` and are removed when the command exits). The user's main `./data/sign.db` is **not touched**.
4. **Verify** — runs `verifyRequestAuditChain` on the temp DB before exit; `verify.chainValid` is included in the JSON output.
5. **Copy** the sealed PDF to the path specified by `--out` and clean up the temp dir.

Flags:

| Flag | Required | Notes |
|---|---|---|
| `<input>` (positional) | yes | `.docx`/`.doc`/`.odt`/`.rtf`/`.pdf` |
| `--signer "<name>"` | yes | Full name (used on the signature cert) |
| `--out <path>` | yes | Output sealed PDF |
| `--signature-image` *or* `--name-signature` | one required | Visible-signature input |
| `--auto-place <selector>` | optional (default `first`) | Same selectors as `sign sign --auto-place` |
| `--image-page/--image-x/--image-y/--image-width/--image-height` | optional | Override auto-place |
| `--signer-email <email>` | optional | Defaults to `<slugified-name>@local.invalid` |
| `--title <text>` | optional | Defaults to the input filename |
| `--preserve-aspect-ratio` | default `true` | Same semantics as `sign sign` |
| `--signature-image-auto-crop` | default `false` | Same semantics as `sign sign` |

JSON output:

```jsonc
{
  "ok": true,
  "input": "contract.docx",
  "output": "signed.pdf",
  "bytes": 18696,
  "converted": true,             // false when input was already a PDF
  "converterBackend": "libreoffice",  // present when converted: true
  "signedAt": "2026-05-13T14:33:08.043Z",
  "placements": [{ "page": 1, "x": 140, "y": 196, "width": 140, "height": 35 }],
  "warnings": [],                // same quality codes as pdf stamp
  "verify": { "chainValid": true, "events": 4, "signers": 1 }
}
```

**Side effects**: writes the sealed PDF to `--out`. Creates and removes a temp dir for the signing-flow state. **Does not** mutate the user's main DB. **Does** invoke the `docx2pdf` subprocess when the input is a word-processing file.

**Caveats**:

- `docx2pdf-cli` needs a backend available in your environment. Run `npx docx2pdf --doctor` to see which backends are installed. On Linux you typically need LibreOffice. On macOS you can use Pages or Word natively.
- The PAdES envelope is sealed with a fresh per-call signer key (in the temp key dir). For cross-call audit chain continuity, use the multi-step `request create` / `request send` / `sign sign` flow instead — `sign document` is for one-shot self-sign use cases where you just need a sealed PDF.
- Multi-page documents and multi-anchor PDFs work — `--auto-place all` stamps at every signature anchor.

---

### 6.4b `sign pdf detect-date-field` + `sign pdf stamp-text`

Sibling pair of the signature-field detection/stamping commands, but for **date** fields.

**`sign pdf detect-date-field --pdf <path>`** — returns date-anchor candidates as JSON. Recognized labels: `Date:` (colon required), `Date de signature:`, `Date d'effet:`, `Date d'entrée en vigueur:`. Each candidate has `category: "date"` and an `alreadyFilled: boolean` flag. The flag is `true` when a recognizable date string sits near the anchor — numeric (`12/05/2026`, `2026-05-12`), French textual (`12 mai 2026`), or English textual (`May 12, 2026`).

**`sign pdf stamp-text --pdf <path> --text "<string>" --out <path>`** — sibling of `pdf stamp` for plain text instead of images. Used for stamping dates (or any other non-signature text). Supports `--auto-place` with the full selector set; filtered to date candidates. Default behavior: **skip `alreadyFilled` candidates**. Pass `--overwrite-filled true` to include them.

```bash
# Auto-fill every blank date field; leaves "Date d'effet: 12 mai 2026" alone
sign pdf stamp-text --pdf contract.pdf --text "$(date +'%-d %B %Y')" \
  --auto-place all --out filled.pdf

# Force overwrite even when a date is already filled
sign pdf stamp-text --pdf contract.pdf --text "today" \
  --auto-place all --overwrite-filled true --out filled.pdf
```

When the date pool is empty because every candidate was `alreadyFilled`, the error hint explicitly points at `--overwrite-filled` rather than the generic "no candidates" message.

**Category split**: `sign pdf detect-signature-field` returns **signature** candidates only; `sign pdf detect-date-field` returns **date** candidates only. `sign sign --auto-place` is signature-only; `sign pdf stamp-text --auto-place` is date-only. A PDF with one Signature: anchor + two Date: anchors no longer breaks `sign sign --auto-place true` with `AUTO_PLACE_AMBIGUOUS` (the date anchors are filtered out before the selector runs).

**Rendering**: `stampPlainTextOnPdf` uses pdf-lib's `StandardFonts.Helvetica` (regular), black text, no underline, left-aligned. Auto-sizes to fit the rectangle width. This is different from `sign sign --name-signature` which renders italic + underline + signature-blue to communicate "signature, not body text."

Side effects: writes to the output PDF. **No** DB interaction, **no** signing-request state mutation, **no** audit events. Safe to run repeatedly.

---

### 6.5a `sign preview` — draft stamp without sealing

Stamps a signature image (or rendered name) onto a PDF and writes the output **without** producing a PAdES envelope. Use this to iterate on placement before committing to a sealed PDF — once the preview looks right, run `sign sign` with the same flags to produce the real signed file.

```bash
sign preview --pdf doc.pdf --signature-image sig.png \
  --auto-place all --out preview.pdf
```

Flag surface mirrors `sign sign` for the stamping side:

| Flag | Notes |
|---|---|
| `--pdf` | Source PDF (required) |
| `--out` | Output preview PDF path (required) |
| `--signature-image` *or* `--name-signature` | One of them required; mutually exclusive |
| `--auto-place <selector>` | Same selectors as `sign sign --auto-place` (true / first / last / all / page:N / index:N) |
| `--image-page/--image-x/--image-y/--image-width/--image-height` | Explicit position, overrides `--auto-place` |
| `--preserve-aspect-ratio` | Default `true` |
| `--signature-image-auto-crop` | Default `false`; PNG-only auto-crop |

Output JSON declares `sealed: false` and lists every `position` that received a stamp (one entry per stamp; `--auto-place all` produces multiple). Quality warnings (`STAMP_OFF_PAGE`, `STAMP_OUTSIZED_VS_TEXT`, etc.) are surfaced the same way they are on `pdf stamp`.

Side effects: writes the output PDF. **No** DB interaction, **no** request state mutation, **no** audit-chain events. Safe to run repeatedly against the same source.

---

### 6.6 Trust labels — `request verify-signed-pdf`

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

### 6.7 Profiles — named bundles of provider + DB + credentials defaults

A **profile** captures provider, dbPath, strict-provider, default token TTL, default signer email, and a credentials block in one named bundle. Activate it with `--profile <name>` / `SIGN_PROFILE=<name>`, or via `defaultProfile` in the user file, or implicitly via a `sign-profile.json` checked into the project root.

**Resolution order** for any field (provider, dbPath, etc.) is `flag > env > project profile > user profile > built-in default`. Profiles are additive — existing flag-and-env-driven invocations see no change.

**Storage**:
- User file: `$XDG_CONFIG_HOME/sign-cli/profiles.json` (mode `0600`), shape `{ version, defaultProfile?, profiles: { <name>: <profile> } }`. Override path via `SIGN_PROFILES_FILE`.
- Project file: `sign-profile.json`, discovered by walking **upward from CWD** until `$HOME` / filesystem root. Single-profile shape (no map).

**Schema** (v1):

```jsonc
{
  "version": 1,
  "provider": "dropbox" | "docusign" | "signwell" | "local",
  "strictProvider": true,
  "dbPath": "~/.sign-cli/prod.db",
  "defaultTokenTtlMinutes": 60,
  "defaultSignerEmail": "alice@example.com",
  "credentials": {
    "DROPBOX_SIGN_API_KEY": "{{env:DROPBOX_SIGN_API_KEY_PROD}}",
    "DROPBOX_SIGN_TEST_MODE": "false"
  }
}
```

**`{{env:VAR}}` expansion** happens at load time. The file persists the literal reference; the in-memory profile gets the resolved value. An **unset env var errors loudly** (`PROFILE_ENV_VAR_UNSET`) with a hint naming the missing variable.

**Atomic credentials** — the layer that resolved `provider` is the only one that contributes credentials. Switching profiles can never silently inherit the previous profile's secrets.

**CLI surface**:

| Command | What |
|---|---|
| `sign profile list` | Lists profiles + active source |
| `sign profile show [--name <n>] [--show-secrets true]` | Resolved view with per-field provenance. Credentials redacted by default. |
| `sign profile use --name <n>` | Sets `defaultProfile` in the user file |
| `sign profile set --name <n> --key <k> --value <v>` | Single-key edit (re-validates) |
| `sign profile unset --name <n> --key <k>` | Removes a key |
| `sign profile delete --name <n> --yes true` | Removes a profile |
| `sign profile init --name <n> [--provider <p>] [--db <path>] [--set-default true]` | Creates a user profile |
| `sign profile init --project true [--provider <p>]` | Writes `./sign-profile.json` instead |

**Credentials format on set**: use `--key credentials.<NAME>` with a value that may contain `{{env:VAR}}` references:

```bash
sign profile set --name prod --key credentials.DROPBOX_SIGN_API_KEY \
  --value '{{env:DROPBOX_SIGN_API_KEY_PROD}}'
```

**Error codes**:

| Code | Cause |
|---|---|
| `PROFILE_NOT_FOUND` | `--profile <name>` / `SIGN_PROFILE` named a profile that doesn't exist; hint lists available names |
| `PROFILE_ALREADY_EXISTS` | `sign profile init` on a name that's already present |
| `PROFILE_ENV_VAR_UNSET` | `{{env:VAR}}` reference but the var is unset in the environment |
| `INVALID_PROFILE` | Schema validation failed (unknown field, bad provider, bad type, etc.) |
| `INVALID_PROFILE_NAME` | Name contains chars outside `[A-Za-z0-9._-]` |

**Provider banner**: when a profile resolves `provider`, the stderr banner reads `[sign] resolved provider: dropbox (via project sign-profile.json)` or `(via active profile)` so the source is visible.

**Side effects**: `init` / `set` / `unset` / `use` / `delete` write to the user file (mode `0600`); `init --project true` writes `./sign-profile.json`. All others are read-only. No DB interaction.

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
- [`docs/regression-testing.md`](regression-testing.md) — per-item
  manual regression tests for everything in this guide, with the
  expected exit codes + output for each command. Use it to validate
  a build before relying on the contract here.
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
