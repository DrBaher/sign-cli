import type { SqliteDb } from "./db.js";
import { nowIso, sha256, stableStringify } from "./util.js";

type AuditEventInput = {
  requestId: string;
  eventType: string;
  payload: unknown;
  now?: Date;
};

export function appendAuditEvent(db: SqliteDb, input: AuditEventInput): {
  hashPrev: string | null;
  hashSelf: string;
  createdAt: string;
} {
  const previous = db
    .prepare(
      `SELECT hash_self
       FROM audit_events
       WHERE request_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(input.requestId) as { hash_self?: string } | undefined;

  const hashPrev = previous?.hash_self ?? null;
  const createdAt = nowIso(input.now);
  const payloadJson = stableStringify(input.payload);
  const hashSelf = sha256(
    stableStringify({
      request_id: input.requestId,
      event_type: input.eventType,
      payload_json: payloadJson,
      created_at: createdAt,
      hash_prev: hashPrev,
    }),
  );

  db.prepare(
    `INSERT INTO audit_events (request_id, event_type, payload_json, hash_prev, hash_self, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.requestId, input.eventType, payloadJson, hashPrev, hashSelf, createdAt);

  return { hashPrev, hashSelf, createdAt };
}
