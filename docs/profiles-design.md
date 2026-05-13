# Profiles — Design Document

Status: **Implemented** in this PR. All open questions from the original
proposal are resolved; this doc now reflects the locked behavior.

For usage examples and the CLI surface, see `docs/agent-guide.md` §6.7.

---

## 1. Motivation

`sign-cli` users currently pass the same five-to-ten flags on every
invocation:

```
sign --provider dropbox --strict-provider true \
  request create --signer-email alice@... --token-ttl-minutes 60 ...
sign --provider dropbox verify --request-id req_... ...
sign --provider dropbox audit export --request-id req_... --out ./b/
```

…or set the equivalent env vars in their shell rc:

```
export SIGN_PROVIDER=dropbox
export SIGN_STRICT_PROVIDER=true
export DROPBOX_SIGN_API_KEY=...
export SIGN_CLI_DB=~/.sign-cli/prod.db
```

This is painful in two specific ways:

1. **Multi-environment workflows are clumsy.** A developer switching
   between a local sandbox (`local` provider, ephemeral DB) and a prod
   account (`dropbox`, real DB, strict mode) has to remember which env
   vars to unset/reset. Mistakes here are quiet — running a `request
   create` against the wrong DB only surfaces when verify or audit gets
   weird answers.

2. **Onboarding is harder than it should be.** A new user has to read
   the provider docs, the `--strict-provider` docs from Item 1, the
   `SIGN_CLI_DB` docs, and decide which combination matches their
   intent. A profile gives that combination a name they can hand to
   teammates.

Profiles solve both: a **named bundle of defaults** that you can
activate with one flag (or env var, or by default for the current
project).

## 2. Goals & non-goals

**Goals**

- One named bundle covers: provider, strict-provider, DB path, default
  token TTL, default signer-email, log mode, and provider-specific
  credentials.
- Resolution order is **predictable and documented**: CLI flag wins,
  then env, then project file, then user file, then built-in defaults.
- `sign doctor` (Item 6) reports the active profile and where each
  value came from.
- Existing flags + env vars keep working unchanged. Profiles are
  additive; no breaking change.
- Listed via `sign profile list`, inspected via `sign profile show`,
  selected via `--profile <name>` or `SIGN_PROFILE=<name>`.

**Non-goals**

- Profiles are **not** a secrets store. They live in plaintext JSON
  under a user-readable path (we'll set `0600` on the user file). For
  high-value secrets users should still keep `DROPBOX_SIGN_API_KEY`
  etc. in their shell rc or a separate secrets manager.
- No remote/team profiles in this proposal. Profiles are local files.
  (Teams can check a project profile into the repo; see §4.2.)
- No profile inheritance / nested profiles. Each profile is flat.
- No interactive profile editor in this proposal — `sign profile set`
  is single-key (`sign profile set --name prod --key provider --value
  dropbox`); a future PR can add a TUI if there's demand.

## 3. What is a profile?

A profile is a JSON object with a fixed schema:

```jsonc
{
  "version": 1,
  "provider": "dropbox" | "docusign" | "signwell" | "local",
  "strictProvider": true,
  "dbPath": "/Users/alice/.sign-cli/prod.db",
  "defaultTokenTtlMinutes": 60,
  "defaultSignerEmail": "alice@example.com",
  "logMode": "pretty" | "json" | "silent",
  "credentials": {
    "DROPBOX_SIGN_API_KEY": "{{env:DROPBOX_SIGN_API_KEY_PROD}}",
    "DROPBOX_SIGN_TEST_MODE": "false"
  }
}
```

Every field except `version` is optional. Missing fields mean "fall
through to the next layer" (see §5).

The `credentials` block is intentionally a key→value map of standard
env-var names. At resolution time, those names are merged into
`process.env` for the duration of the command. `{{env:OTHER_VAR}}`
expands to the value of `OTHER_VAR` in the host shell so users can
reference shell-managed secrets without baking them into the profile
file.

### Reserved field constraints

- `provider` must be one of `SIGN_PROVIDERS` (typo'd values fail
  loudly at load time, not at request time).
- `strictProvider` is a boolean — string `"true"` is also accepted to
  match the existing CLI/env coercion.
- `defaultTokenTtlMinutes` must be a positive integer.
- `dbPath` may use `~` for the user's home dir.

## 4. Storage

### 4.1 User profiles file

`~/.config/sign-cli/profiles.json` (XDG-compliant; falls back to
`~/.sign-cli/profiles.json` on platforms without `$XDG_CONFIG_HOME`).
Permissions are set to `0600` on creation. Shape:

```jsonc
{
  "version": 1,
  "defaultProfile": "dev",
  "profiles": {
    "dev":  { /* profile object */ },
    "prod": { /* profile object */ }
  }
}
```

`defaultProfile` is the name used when no other layer (flag, env,
project file) says otherwise.

### 4.2 Project profile file

`./sign-profile.json` in the current working directory (no recursion
up the tree — explicit is better than magic). When present, this
file's profile is layered **on top of** the user profile selected by
`--profile`/env/default. Shape is **a single profile object** (no
named map, no `defaultProfile` — the file *is* the profile):

```jsonc
{
  "version": 1,
  "provider": "local",
  "dbPath": ".sign-cli.db"
}
```

This is the "check this into your repo so teammates inherit the same
defaults" mechanism. Anything secret stays in the user file or in
`{{env:...}}` references.

## 5. Resolution order

For any single value (e.g. `provider`), the **first source that
produces a value wins**:

| Priority | Source | Example |
|---|---|---|
| 1 (highest) | CLI flag | `--provider dropbox` |
| 2 | Env var | `SIGN_PROVIDER=dropbox` |
| 3 | Project profile (`./sign-profile.json`) | `{ "provider": "local" }` |
| 4 | User profile selected by `--profile` / `SIGN_PROFILE` / `defaultProfile` | `profiles.dev.provider = "local"` |
| 5 (lowest) | Built-in default | `dropbox` |

This is the **same** spirit as the Item 1 resolution
(`flag > env > default`), just with two more layers slotted in
between env and default. Importantly: **the project file outranks
the user file**, because the project file is the "this is what THIS
codebase needs" statement.

For the `credentials` block specifically, the layer that produced
`provider` ALSO contributes its credentials. We do not merge
credentials across layers — that would silently mix prod and dev
secrets, which is exactly the failure mode profiles are meant to
prevent. (See §8 Open Questions for an alternative.)

## 6. CLI surface

```
sign profile list
  → lists named profiles, marks the default, marks the active one if
    --profile / SIGN_PROFILE / project file selected something.

sign profile show [--name <name>]
  → prints the resolved profile + per-field provenance (what layer
    each value came from). Without --name, shows the active profile
    for the current cwd.

sign profile use <name>
  → sets `defaultProfile` in the user file. No effect on a session
    that already passes --profile or SIGN_PROFILE.

sign profile set --name <name> --key <key> --value <value>
sign profile unset --name <name> --key <key>
  → single-key edits to the user file. Schema-validated before write.

sign profile delete --name <name>
  → with confirmation, unless --yes is passed.

sign profile init [--name <name>] [--provider <p>] [--db <path>]
  → creates a profile interactively-ish (defaults filled from prompts
    or flags). Useful for `sign doctor` to suggest after preflight
    warnings.
```

And a **global** `--profile <name>` flag accepted by every existing
command, with `SIGN_PROFILE` as the env equivalent.

## 7. Interactions with existing surface

- **Item 1 (provider banner + strict-provider).** The banner already
  prints the resolved provider + source. With profiles, the source
  string gains a fourth value: `via profile <name>` or `via
  project sign-profile.json`. `--strict-provider` semantics don't
  change: it's checked at request-load time against the persisted
  provider for that request, regardless of how the active provider
  was resolved.

- **Item 2 (verify summary).** Unaffected. Exit codes don't depend on
  profiles.

- **Item 6 (`sign doctor`).** Preflight gains a new "profile" section:
  active profile name, source, the resolved provider + dbPath +
  strictProvider, and a warning if `--profile` references a name
  that doesn't exist in the user file. If a project file exists
  and overrides values from the user profile, doctor highlights the
  overrides explicitly.

- **`SIGN_CLI_DB`.** When a profile sets `dbPath`, that's the
  user-file source. `SIGN_CLI_DB` (env, layer 2) still outranks it.
  This means existing env-driven users see no change.

- **Hosted providers' credential env vars (`DROPBOX_SIGN_API_KEY` etc.).**
  These continue to be consulted by their respective adapters; a
  profile's `credentials` block writes into `process.env` BEFORE the
  adapter looks. So a user can either set the env var directly (as
  today) or have a profile inject it — same final behavior at the
  adapter boundary.

## 8. Edge cases

- **Profile names with weird characters.** Names are restricted to
  `[A-Za-z0-9._-]` to dodge filesystem and shell issues.
- **`--profile <name>` where `<name>` doesn't exist.** Exit 1 with a
  clear "no profile named <X>; available: <list>". No silent fallback.
- **Profile sets `provider: dropbox`, but `--provider local` flag
  passed.** Flag wins (layer 1 > layer 4). No warning by default;
  `sign doctor` can surface the divergence.
- **Project file selects `local`, user has `--strict-provider true`
  globally, but is now running against a request created on
  `dropbox`.** The strict-provider check fires the same way it does
  today — strict-provider is about request↔CLI agreement, not about
  the profile.
- **Profile sets `dbPath` and that file doesn't exist.** Same
  behavior as today when `SIGN_CLI_DB` points at a nonexistent file:
  sqlite creates it (the harness already handles fresh-DB cases).
- **Concurrent edits to the profiles file.** The `set`/`unset`/`use`
  commands take an advisory file lock and re-read before writing.

## 9. Migration

Profiles are additive. Existing users do nothing. The recommended
migration is:

```
# 1. Capture current setup
sign doctor                            # tells you what's resolved today

# 2. Initialize a profile from those values
sign profile init --name prod \
  --provider dropbox \
  --db ~/.sign-cli/prod.db

# 3. Optionally select it as the default
sign profile use prod

# 4. Optionally drop the env-var noise from your shell rc
# (env vars still work; the profile just makes them unnecessary)
```

For team workflows: check `sign-profile.json` into the repo with the
provider + dbPath that matches the project, and let each developer
keep their secrets in their user profile or shell env.

## 10. Implementation plan (sketch)

This is the planned breakdown when implementation lands:

1. **`src/lib/profiles.ts`** — load/save user and project profile
   files, validate against the schema, resolve a single value across
   layers (`resolve(key) → { value, source }`).
2. **Wire into existing flag/env resolution** — `selectedProvider`,
   `strictProvider`, `dbPath` look at the profile layer after env.
   Each call site already returns a `{value, source}` shape (Item 1
   pattern); profiles add new `source` strings.
3. **CLI handlers** — `sign profile {list,show,use,set,unset,delete,init}`.
4. **`sign doctor` integration** — Item 6 adds a profile section.
5. **Banner integration** — Item 1's banner prints the new source
   strings.
6. **Tests** — resolution-order matrix (every layer × every field),
   profile validation errors, `{{env:...}}` expansion, file-lock
   contention, etc.

Estimated diff: ~600 lines library + ~250 lines CLI + ~500 lines
tests. Single PR, no migration script needed.

## 11. Resolved decisions (was: Open questions)

This section originally listed open questions in the proposal. Each was
decided as follows:

1. **Credentials merging across layers → NO MERGE (atomic profiles).**
   The layer that resolved `provider` is the only one that contributes
   credentials. This matches the semantic model of `kubectl` contexts
   and `aws-cli` profiles. Cross-profile credential reuse is achieved
   via `{{env:VAR}}` references that point at shell-managed secrets —
   every profile can refer to the same env var, but no profile silently
   inherits another's secrets. This closes the "stale dev credentials
   sneak into prod" failure mode flagged in §5.

2. **`SIGN_PROFILE` vs `--profile` precedence → flag > env.** Matches
   every other flag/env pair in the CLI (`SIGN_PROVIDER`,
   `SIGN_STRICT_PROVIDER`, etc.).

3. **Schema versioning → migrate in place.** A chain of `vN → vN+1`
   migration functions is invoked lazily at load time. Writes back the
   migrated version on next save. `sign profile migrate` runs the
   chain explicitly when needed. Newer-than-known versions warn but
   load known fields (forward-compat for older CLIs reading newer
   files).

4. **`sign profile show --json` → yes, in v1.** Agent-first CLI;
   everything has a structured output path. The default `show` is also
   JSON (consistent with the rest of the CLI); a future human-friendly
   `--format text` could be added if needed.

5. **`sign profile init --project` → yes.** When passed, writes
   `./sign-profile.json` (the single-profile-object shape) instead of
   adding to the user file. Useful for repo-scoped configs that should
   be checked in.

## 11a. Additional resolved decisions (not in the original proposal)

These came up during scope review and were locked in alongside the five above:

6. **Project-file lookup is recursive (CWD upward).** The proposal
   originally said "no recursion." We switched to an upward walk
   matching git / npm / pnpm / cargo — when developers `cd src/`, the
   project's `sign-profile.json` is still found. The walk stops at
   `$HOME` or the filesystem root, whichever comes first. Hard cap at
   64 hops to defend against pathological filesystems.

7. **Unset `{{env:VAR}}` references error loudly.** When a profile
   references `{{env:DROPBOX_SIGN_API_KEY_PROD}}` and that variable is
   not set in the environment at load time, we throw
   `PROFILE_ENV_VAR_UNSET` with a clear hint naming the missing var.
   The alternative — silently expanding to `""` — would defer the
   "wrong credentials" failure to adapter-time with a confusing error
   message that doesn't mention the profile at all.

8. **Credentials are redacted by default in `sign profile show`.**
   Output shows credential `keys` only (the env-var names). Pass
   `--show-secrets true` to also include `values` (the resolved
   post-`{{env:}}`-expansion strings). Matches `aws sts`, `gh auth`,
   `kubectl config view` conventions.

9. **`logMode` field dropped from v1.** The proposal had it but the
   semantics across commands were under-specified (the provider banner
   already has its own resolution; no other command consumed it).
   Easier to add back when there's a concrete cross-command binding.

10. **`SIGN_PROFILES_FILE` env var added.** Allows users to override
    the profile-file location without restructuring XDG. Matches
    `AWS_CONFIG_FILE` / `KUBECONFIG`. Used heavily in tests; useful
    for advanced setups.

## 12. Out of scope / future

- A profile-aware `sign export-config --bundle ./onboarding/` that
  packages a user profile + a documented set of env vars for
  teammates.
- Profile-scoped audit DBs vs single shared DB (Item 5 of the
  feedback already mentions multi-DB workflows; profiles unblock
  this but the multi-DB story is its own design).
- Secrets-manager integration (Vault, 1Password, etc.) via a
  `{{secret:vault://path}}` syntax. Same expansion machinery as
  `{{env:...}}`.

---

**Next step:** review this doc; comment on the **Open Questions** in
§11. Once those are settled, the implementation PR drops following
the §10 sketch.
