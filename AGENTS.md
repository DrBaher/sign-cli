# Agents

Drive `sign-cli` from an LLM or non-interactive client. This is the quickstart; the full canonical reference is [docs/agent-guide.md](docs/agent-guide.md).

## Output contract

- **Success**: JSON to **stdout**, exit `0`.
- **Failure**: `{ ok: false, error: { code, message, hint?, details? } }` to **stderr**, non-zero exit.
- Toggle to plain text: `SIGN_ERROR_FORMAT=text`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `2` | Invalid input (missing/malformed flag, schema fail) |
| `3` | Policy / chain / verification failed |
| `4` | Not found / out of range |

Full code table and the failure-mode → recovery map: [docs/reference/exit-codes.md](docs/reference/exit-codes.md).

## Discovery

Never hardcode tool names, flag lists, or counts — call these at startup:

```bash
sign --catalog json    # full CLI command + flag inventory
sign mcp tools         # live MCP tool catalog (with inputSchema/outputSchema)
sign --version
```

## The signing asymmetry

The whole architecture is built around one rule: **the agent does every step except the signing gesture**. `sign` (CLI / MCP tool / `POST /v1/sign`) requires a per-signer token that's scoped to one email, TTL-bounded, single-use. The requester (which can be the agent) holds and DMs the token to the human signer; the signer pastes it into `sign sign --token ...`. The agent never sees signer tokens.

Pre-sign safety checks (`--require-hash`, `--require-title`, `--require-signer-email`) throw structured errors *before* any state mutation, so an agent computing a hash earlier can refuse to sign if the document was swapped in flight.

## Read-only mode

For sandboxed agents that should inspect and track but not mutate:

```bash
sign mcp serve --read-only true \
  --tool request_show --tool audit_verify --tool pdf_detect_signature_field
sign serve --read-only true --rate-limit 5
```

Mutating tools/routes return `FORBIDDEN_READ_ONLY` (exit `3` / HTTP 403). The set is in `READ_ONLY_BLOCKED_TOOLS` and `READ_ONLY_BLOCKED_ROUTES` in the source.

## Failure → recovery

| Symptom | Diagnose | Recover |
|---|---|---|
| `MISSING_FLAG` / `INVALID_ARGS` | `sign <cmd> --help` (or `sign --catalog json` for machine-readable) | Fix the flag. |
| `TOKEN_EXPIRED` | `request show --request-id <id>` shows the expired approval | `sign signer reissue-token --request-id <id> --signer-email <email>` |
| `STRICT_PROVIDER_MISMATCH` | The resolved provider differs from the request's persisted one | Re-run with `--provider <persisted-one>` or unset `--strict-provider`. |
| `CHAIN_TAMPERED` / `audit verify` exit `3` | `audit show --request-id <id>` for the timeline | Stop. The DB has been tampered with. See [docs/reference/audit-chain.md](docs/reference/audit-chain.md). |
| `AUTO_PLACE_AMBIGUOUS` | `details.candidates` lists every candidate | Re-call with `--auto-place first` / `last` / `page:N` / `index:N`. |
| `STORAGE_UNWRITABLE` | `details.path` names the unwritable directory | Set `SIGN_DB_PATH` or a profile `dbPath` to a writable location. |
| `FORBIDDEN_READ_ONLY` | Mutating call against `--read-only true` | If sandboxing is intentional, escalate to a human. Otherwise re-invoke without `--read-only`. |
| Path "escapes the working directory" | Path-traversal guard rejected the input/output path | If intentional, set `SIGN_ALLOW_ABSOLUTE_DOCS=1`. Otherwise use a CWD-relative path. |

## Profiles for credential isolation

Named profiles bundle `provider` + `dbPath` + `credentials` under a name. The credentials block uses `{{env:VAR}}` references that resolve from the shell at call time — secrets never live in the profile file.

```bash
sign --profile prod request show --request-id <id>
# or implicitly via a project-level sign-profile.json (git/npm-style upward discovery)
```

See [docs/reference/profiles.md](docs/reference/profiles.md) for the full resolution order and project-discovery rules.

## Preflight

Run before doing anything that mutates state:

```bash
sign doctor preflight --provider <provider>
```

Structured per-check report; exit `0` if `verdict: "ok"`, `1` if any check failed. Branch on `checks[].name` for self-recovery. Env-health checks (`runtime:node_version`, `storage:db_path`) always run; provider-scoped checks layer on top.

## See also

- [docs/agent-guide.md](docs/agent-guide.md) — canonical agent reference (per-command schemas, side effects, idempotency).
- [docs/recipes/](docs/recipes/) — task-oriented agent recipes (preflight, agent-loop-mcp, weekly anchor, auditor handoff).
- [docs/reference/](docs/reference/) — concept deep-dives.
- [CHANGELOG.md](CHANGELOG.md) — what landed and when.
