import type { SqliteDb } from "./db.js";
import { nowIso } from "./util.js";

export type IdempotencyHit<T> = { hit: true; value: T };
export type IdempotencyMiss = { hit: false };
export type IdempotencyLookup<T> = IdempotencyHit<T> | IdempotencyMiss;

type Row = { request_id: string | null; response_json: string; created_at: string };

export function lookupIdempotencyKey<T>(
  db: SqliteDb,
  scope: string,
  key: string,
): IdempotencyLookup<T> {
  const row = db.prepare(
    "SELECT request_id, response_json, created_at FROM idempotency_keys WHERE scope = ? AND key = ?",
  ).get(scope, key) as Row | undefined;
  if (!row) return { hit: false };
  try {
    return { hit: true, value: JSON.parse(row.response_json) as T };
  } catch {
    return { hit: false };
  }
}

export function persistIdempotencyKey<T>(
  db: SqliteDb,
  input: { scope: string; key: string; requestId?: string | null; value: T; now?: Date },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (scope, key, request_id, response_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.scope,
    input.key,
    input.requestId ?? null,
    JSON.stringify(input.value),
    nowIso(input.now ?? new Date()),
  );
}
