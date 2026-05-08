# Migrations & storage backends

## Schema migrations (in-database)

`sign-cli` ships a tiny versioned migrations registry at `src/lib/migrations.ts`. Each migration has an integer `id`, a kebab-case `name`, and a one-shot `up(db)` function. They run automatically on every `openDatabase` (after the baseline `CREATE TABLE` block) and are tracked in the `schema_migrations` table.

```bash
sign db migrate              # apply pending; prints { alreadyApplied, newlyApplied, pending }
sign db migrate --dry-run    # print pending without changing state
```

When you need to add a column or index, append a new entry to the `MIGRATIONS` array — give it the next sequential id. **Never re-number an existing migration**; the `id` is the row key in `schema_migrations`. If you need to amend a shipped migration, write a new one that fixes the prior one.

## Storage backends

Selected via `SIGN_DB_BACKEND` (default `sqlite`). Today's matrix:

| Backend    | Status         | Notes |
|------------|----------------|-------|
| `sqlite`   | production-ready | Default. Single file at `SIGN_DB_PATH` (defaults to `./data/sign.db`). WAL mode, busy timeout 5s. |
| `postgres` | **partial**    | `pg`-backed adapter at `src/lib/db-backend.ts` exposes `prepareAsync`/`execAsync` with `?`→`$N` translation. Sync `prepare`/`exec` still throw — call-site sync→async migration is the remaining gap. |

### Why a stub?

The CLI's call sites today reach for `db.prepare(...).get/all/run` directly on the `node:sqlite` `DatabaseSync` instance. A real Postgres backend means introducing a minimal `prepare(sql).get/all/run` interface that both engines implement, then migrating ~30 call sites. That's its own PR.

The stub serves three purposes:

1. **Surface the design intent** — `SIGN_DB_BACKEND` is now a documented env var, even if only one value works.
2. **Hold the abstraction line** — new code should call `openStorage()` from `src/lib/storage.ts` instead of `openDatabase()` directly, so the eventual switch is a constructor change, not a sweep.
3. **Fail loudly** — `SIGN_DB_BACKEND=postgres` throws `INTERNAL` with a pointer here, instead of silently using SQLite.

### Postgres-readiness checklist (future PR)

- [x] Define `DbBackend` interface with `prepare(sql) → { get, all, run }` shape. (`src/lib/db-backend.ts`)
- [x] Wrap `DatabaseSync` in `SqliteBackend` implementing that interface. (`src/lib/db-backend.ts`)
- [x] Stub `PostgresBackend` returning the adapter — every method throws `INTERNAL` pointing here. (`src/lib/db-backend.ts`)
- [x] Add `openStorageBackend()` in `src/lib/storage.ts` so new code can target the abstract `DbBackend` instead of the concrete `SqliteDb`.
- [ ] Migrate the ~30 `SqliteDb`-typed call sites to `DbBackend` one at a time (start with read-only audit/show paths, leave the lifecycle writes for last).
  - [x] `verifyAuditChain` and `listAuditEvents` accept `SqliteDb | DbBackend` via `asBackend(...)`. All existing call sites still work; new code can pass a `DbBackend` directly.
  - [x] `getRequestRow` (private), `listSigningRequests`, `verifyRequestAuditChain`, `scanAllAuditChains` accept `SqliteDb | DbBackend`.
- [x] Implement real `PostgresBackend` (via the `pg` driver) — `prepareAsync`/`execAsync` are wired through `pg.Pool.query` with on-the-fly `?` → `$N` placeholder translation. Sync `prepare`/`exec` still throw — pg is async-only and the sync→async call-site migration is its own track.
- [ ] Migrate call sites to the async surface (`prepareAsync`/`execAsync`/`asBackend`) so they can target `PostgresBackend` without losing SQLite compatibility.
  - [x] Read-only audit primitives ship async variants: `verifyAuditChainAsync`, `listAuditEventsAsync`, `searchAuditEventsAsync`. SQLite + Postgres both pass the same tests via the placeholder translator.
- [x] Postgres-flavor DDL bootstrap shipped at `src/lib/postgres-bootstrap.ts` and exposed as `sign db migrate-postgres --pg-url …`. Idempotent, includes the PL/pgSQL append-only triggers.
- [ ] Translate the few SQLite-specific PRAGMAs (`journal_mode`, `busy_timeout`) into Postgres equivalents (`statement_timeout`, etc.) — most won't apply.
- [ ] Re-implement the audit-events append-only triggers as Postgres `BEFORE UPDATE/DELETE` triggers + `RAISE EXCEPTION`.
- [ ] Re-run the full test suite against a real Postgres instance in CI.

Until the above lands, run with the default SQLite backend.
