# Exit codes & error envelope

Every `sign-cli` command honors the same exit-code semantics. This is the canonical reference — agent code branches on these codes, not on parsed stderr text.

## The map

| Code | Meaning | Typical cause |
|------|---------|---------------|
| `0` | Success | The command did what it said it would. |
| `1` | Generic / unhandled | Bug in `sign-cli` or an unexpected runtime failure. File an issue. |
| `2` | Invalid input | Missing required flag, malformed value, schema violation, ambiguous selector. |
| `3` | Policy / chain / verification failed | Audit chain tampered (`chainValid: false`), pre-sign safety check failed, strict-quality violation, declined-by-policy, signed-by-mismatch. |
| `4` | Not found / out of range | Request id doesn't exist, page index exceeds page count, candidate index out of range, no anchor matches. |

`request watch` adds a parallel `0/2/3/4` for terminal vs. timeout: `0` reached `completed`, `3` declined or chain broke during the watch, `4` timed out before terminal.

## The success envelope

Successful commands print JSON to **stdout**, exit `0`:

```json
{ "ok": true, ...command-specific fields... }
```

Stable command-specific fields are listed per command in [docs/agent-guide.md](../agent-guide.md). Use the `outputSchema` from `sign --catalog json` for the live contract.

## The error envelope

Errors print to **stderr**, exit non-zero:

```json
{
  "ok": false,
  "error": {
    "code": "TOKEN_EXPIRED",
    "message": "Approval token has expired (expired at 2026-05-14T08:00:00Z).",
    "hint": "Re-issue with: sign signer reissue-token --request-id req_... --signer-email alice@acme.com",
    "details": { "signerEmail": "alice@acme.com", "expiredAt": "2026-05-14T08:00:00Z" }
  }
}
```

Stable error codes:

| Code | Class | Notes |
|---|---|---|
| `INVALID_ARGS` | input | Maps to exit `2`. |
| `MISSING_FLAG` | input | Maps to exit `2`. `details.flag` names the missing flag. |
| `TOKEN_EXPIRED` | policy | Exit `3`. `hint` always suggests `signer reissue-token`. |
| `TOKEN_INVALID` | policy | Exit `3`. Token shape valid but doesn't match any stored approval. |
| `NON_LOCAL_PROVIDER` | policy | Exit `3`. `sign` tool called against a non-local provider. |
| `PRE_SIGN_HASH_MISMATCH` | policy | Exit `3`. `--require-hash` didn't match the request's documentSha256. |
| `PRE_SIGN_TITLE_MISMATCH` | policy | Exit `3`. `--require-title` regex didn't match the request title. |
| `STRICT_PROVIDER_MISMATCH` | policy | Exit `3`. Resolved provider differs from request's persisted provider. |
| `CHAIN_TAMPERED` | policy | Exit `3`. `audit verify` found a hash-chain break. `details.breakIndex` names the event. |
| `REQUEST_NOT_FOUND` | not-found | Exit `4`. |
| `AUTO_PLACE_AMBIGUOUS` | input | Exit `2`. Multiple candidates above the confidence threshold. `details.candidates` lists them. |
| `AUTO_PLACE_NO_HIGH_CONFIDENCE` | input | Exit `2`. No candidate ≥ `0.8` confidence. |
| `AUTO_PLACE_PAGE_NOT_FOUND` | input | Exit `2`. `--auto-place page:N` for a page with no candidates. |
| `AUTO_PLACE_INDEX_OUT_OF_RANGE` | input | Exit `2`. |
| `STORAGE_UNWRITABLE` | infra | Exit `1`. Wrap of EACCES/EROFS/EPERM on db init. Hint points at `SIGN_DB_PATH` or a profile `dbPath`. |
| `PROFILE_NOT_FOUND` | input | Exit `2`. |
| `PROFILE_ENV_VAR_UNSET` | input | Exit `2`. `details.var` names the missing env var. |
| `FORBIDDEN_READ_ONLY` | policy | Exit `3`. Mutating call hit `--read-only true`. |

Full list of codes is in [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md); this file lists only the ones agents most commonly branch on.

## Disabling the JSON envelope

`SIGN_ERROR_FORMAT=text` switches errors to plain-text on stderr. Useful for shell scripts that grep error messages directly. The exit code semantics are unchanged.
