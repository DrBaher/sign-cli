import { asBackend, type DbBackend } from "./db-backend.js";
import type { SqliteDb } from "./db.js";
import { maybeNotifySignerEvent } from "./notify.js";
import { notifyResourceChanged } from "./resource-watch.js";
import { SignCliError } from "./sign-error.js";
import { nowIso, sha256, stableStringify } from "./util.js";

export type AuditChainBreak =
  | { kind: "hash_self_mismatch"; eventId: number; expected: string; actual: string }
  | { kind: "hash_prev_mismatch"; eventId: number; expected: string | null; actual: string | null };

export type AuditVerificationResult = {
  valid: boolean;
  events: number;
  break: AuditChainBreak | null;
};

export function verifyAuditChain(db: SqliteDb | DbBackend, requestId: string): AuditVerificationResult {
  const backend = asBackend(db);
  const rows = backend.prepare(
    `SELECT id, request_id, event_type, payload_json, hash_prev, hash_self, created_at
     FROM audit_events
     WHERE request_id = ?
     ORDER BY id ASC`,
  ).all(requestId) as Array<AuditChainRow>;
  return verifyChainRows(rows);
}

// Async variant — same query, same verification logic, but via prepareAsync
// so it works against the Postgres backend (whose sync prepare() throws).
export async function verifyAuditChainAsync(backend: DbBackend, requestId: string): Promise<AuditVerificationResult> {
  const rows = await backend.prepareAsync(
    `SELECT id, request_id, event_type, payload_json, hash_prev, hash_self, created_at
     FROM audit_events
     WHERE request_id = ?
     ORDER BY id ASC`,
  ).all(requestId) as Array<AuditChainRow>;
  return verifyChainRows(rows);
}

type AuditChainRow = {
  id: number;
  request_id: string;
  event_type: string;
  payload_json: string;
  hash_prev: string | null;
  hash_self: string;
  created_at: string;
};

function verifyChainRows(rows: AuditChainRow[]): AuditVerificationResult {
  let previousHash: string | null = null;
  for (const row of rows) {
    if (row.hash_prev !== previousHash) {
      return {
        valid: false,
        events: rows.length,
        break: {
          kind: "hash_prev_mismatch",
          eventId: row.id,
          expected: previousHash,
          actual: row.hash_prev,
        },
      };
    }
    const expected = sha256(
      stableStringify({
        request_id: row.request_id,
        event_type: row.event_type,
        payload_json: row.payload_json,
        created_at: row.created_at,
        hash_prev: row.hash_prev,
      }),
    );
    if (expected !== row.hash_self) {
      return {
        valid: false,
        events: rows.length,
        break: {
          kind: "hash_self_mismatch",
          eventId: row.id,
          expected,
          actual: row.hash_self,
        },
      };
    }
    previousHash = row.hash_self;
  }

  return { valid: true, events: rows.length, break: null };
}

type AuditEventInput = {
  requestId: string;
  eventType: string;
  payload: unknown;
  now?: Date;
};

const APPEND_SELECT_PREV_SQL =
  `SELECT hash_self
   FROM audit_events
   WHERE request_id = ?
   ORDER BY id DESC
   LIMIT 1`;
const APPEND_INSERT_SQL =
  `INSERT INTO audit_events (request_id, event_type, payload_json, hash_prev, hash_self, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`;

// Compute the next chain entry from the previous hash. Pure — no I/O, no
// notifications. Lifted out so the sync + async append paths share identical
// hashing logic and can't drift.
function buildNextChainEntry(input: AuditEventInput, prevHash: string | null): {
  hashPrev: string | null;
  hashSelf: string;
  createdAt: string;
  payloadJson: string;
} {
  const createdAt = nowIso(input.now);
  const payloadJson = stableStringify(input.payload);
  const hashSelf = sha256(
    stableStringify({
      request_id: input.requestId,
      event_type: input.eventType,
      payload_json: payloadJson,
      created_at: createdAt,
      hash_prev: prevHash,
    }),
  );
  return { hashPrev: prevHash, hashSelf, createdAt, payloadJson };
}

function emitPostAppendNotifications(
  input: AuditEventInput,
  result: { hashSelf: string; createdAt: string },
): void {
  void maybeNotifySignerEvent({
    requestId: input.requestId,
    eventType: input.eventType,
    payload: input.payload,
    hashSelf: result.hashSelf,
    createdAt: result.createdAt,
  });
  notifyResourceChanged(`request://${input.requestId}`);
  notifyResourceChanged(`request://${input.requestId}/audit`);
}

export function appendAuditEvent(db: SqliteDb, input: AuditEventInput): {
  hashPrev: string | null;
  hashSelf: string;
  createdAt: string;
} {
  const previous = db.prepare(APPEND_SELECT_PREV_SQL).get(input.requestId) as { hash_self?: string } | undefined;
  const entry = buildNextChainEntry(input, previous?.hash_self ?? null);
  db.prepare(APPEND_INSERT_SQL).run(
    input.requestId,
    input.eventType,
    entry.payloadJson,
    entry.hashPrev,
    entry.hashSelf,
    entry.createdAt,
  );
  emitPostAppendNotifications(input, entry);
  return { hashPrev: entry.hashPrev, hashSelf: entry.hashSelf, createdAt: entry.createdAt };
}

// Async sibling — same chain-hashing logic, runs the SELECT + INSERT through
// prepareAsync so it works against PostgresBackend. Sync + async share
// buildNextChainEntry so the chain head is computed identically regardless of
// which path appends the event.
export async function appendAuditEventAsync(
  backend: DbBackend,
  input: AuditEventInput,
): Promise<{ hashPrev: string | null; hashSelf: string; createdAt: string }> {
  const previous = await backend.prepareAsync(APPEND_SELECT_PREV_SQL).get(input.requestId) as { hash_self?: string } | undefined;
  const entry = buildNextChainEntry(input, previous?.hash_self ?? null);
  await backend.prepareAsync(APPEND_INSERT_SQL).run(
    input.requestId,
    input.eventType,
    entry.payloadJson,
    entry.hashPrev,
    entry.hashSelf,
    entry.createdAt,
  );
  emitPostAppendNotifications(input, entry);
  return { hashPrev: entry.hashPrev, hashSelf: entry.hashSelf, createdAt: entry.createdAt };
}

// Cross-request log-style search over audit_events. All filters are AND'd.
// payloadContains does a substring match on the JSON-serialized payload — not a
// JSON-path query, but enough to grep for an email / token-hint / request id
// without each call site building its own LIKE clause.
export type AuditSearchHit = {
  id: number;
  requestId: string;
  eventType: string;
  createdAt: string;
  hashSelf: string;
  payload: unknown;
};

export type AuditSearchResult = {
  total: number;
  results: AuditSearchHit[];
};

export function searchAuditEvents(
  db: SqliteDb | DbBackend,
  opts: {
    requestId?: string;
    eventType?: string;
    since?: string;
    until?: string;
    payloadContains?: string;
    limit?: number;
  } = {},
): AuditSearchResult {
  const backend = asBackend(db);
  const { sql, params } = buildAuditSearchQuery(opts);
  const rows = backend.prepare(sql).all(...params) as AuditSearchSqlRow[];
  return { total: rows.length, results: rows.map(rowToHit) };
}

// Async variant of searchAuditEvents — same query, runs through prepareAsync
// so it works against PostgresBackend.
export async function searchAuditEventsAsync(
  backend: DbBackend,
  opts: {
    requestId?: string;
    eventType?: string;
    since?: string;
    until?: string;
    payloadContains?: string;
    limit?: number;
  } = {},
): Promise<AuditSearchResult> {
  const { sql, params } = buildAuditSearchQuery(opts);
  const rows = await backend.prepareAsync(sql).all(...params) as AuditSearchSqlRow[];
  return { total: rows.length, results: rows.map(rowToHit) };
}

type AuditSearchSqlRow = {
  id: number;
  request_id: string;
  event_type: string;
  payload_json: string;
  hash_self: string;
  created_at: string;
};

function buildAuditSearchQuery(opts: {
  requestId?: string;
  eventType?: string;
  since?: string;
  until?: string;
  payloadContains?: string;
  limit?: number;
}): { sql: string; params: unknown[] } {
  for (const key of ["since", "until"] as const) {
    const value = opts[key];
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new SignCliError({
        code: "INVALID_ARGS",
        message: `--${key} must be an ISO 8601 timestamp; got ${JSON.stringify(value)}.`,
      });
    }
  }
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.requestId) { where.push("request_id = ?"); params.push(opts.requestId); }
  if (opts.eventType) { where.push("event_type = ?"); params.push(opts.eventType); }
  if (opts.since) { where.push("datetime(created_at) >= datetime(?)"); params.push(opts.since); }
  if (opts.until) { where.push("datetime(created_at) <= datetime(?)"); params.push(opts.until); }
  if (opts.payloadContains) { where.push("instr(payload_json, ?) > 0"); params.push(opts.payloadContains); }
  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0
    ? Math.min(Number(opts.limit), 5000)
    : 1000;
  const sql = `SELECT id, request_id, event_type, payload_json, hash_self, created_at
     FROM audit_events
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY id DESC
     LIMIT ${limit}`;
  return { sql, params };
}

function rowToHit(row: AuditSearchSqlRow): AuditSearchHit {
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { payload = row.payload_json; }
  return {
    id: row.id,
    requestId: row.request_id,
    eventType: row.event_type,
    createdAt: row.created_at,
    hashSelf: row.hash_self,
    payload,
  };
}
