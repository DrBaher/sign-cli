import { asBackend, type DbBackend } from "./db-backend.js";
import type { SqliteDb } from "./db.js";
import { maybeNotifySignerEvent } from "./notify.js";
import { notifyResourceChanged } from "./resource-watch.js";
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
  ).all(requestId) as Array<{
    id: number;
    request_id: string;
    event_type: string;
    payload_json: string;
    hash_prev: string | null;
    hash_self: string;
    created_at: string;
  }>;

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

  void maybeNotifySignerEvent({
    requestId: input.requestId,
    eventType: input.eventType,
    payload: input.payload,
    hashSelf,
    createdAt,
  });

  notifyResourceChanged(`request://${input.requestId}`);
  notifyResourceChanged(`request://${input.requestId}/audit`);

  return { hashPrev, hashSelf, createdAt };
}
