// End-to-end smoke for the Postgres async path. Exercises:
//
//   bootstrapPostgresSchema          (DDL: CREATE TABLE IF NOT EXISTS …)
//   manual INSERT INTO requests      (the only INSERT we don't yet have an
//                                     async wrapper for)
//   appendAuditEventAsync × 3        (chain extension)
//   verifyAuditChainAsync            (valid: true)
//   listAuditEventsAsync             (count + ordering)
//   searchAuditEventsAsync           (event_type filter)
//
// The point: prove the async surface works against a real PostgresBackend
// for one full chain. Doesn't replace the CLI's full lifecycle (sync) — it
// validates the abstraction we've been building.
//
// Doesn't try to be exhaustive; the per-helper tests already cover edge
// cases. This module is the integration probe.

import type { DbBackend } from "./db-backend.js";
import { bootstrapPostgresSchema } from "./postgres-bootstrap.js";
import {
  appendAuditEventAsync,
  searchAuditEventsAsync,
  verifyAuditChainAsync,
} from "./audit.js";
import { listAuditEventsAsync } from "./signing-service.js";
import { SignCliError } from "./sign-error.js";

export type PostgresSmokeStep = {
  name: string;
  ok: boolean;
  durationMs: number;
  note?: string;
};

export type PostgresSmokeReport = {
  ok: boolean;
  steps: PostgresSmokeStep[];
  requestId: string;
};

export async function runPostgresSmoke(
  backend: DbBackend,
  opts: { requestId?: string; now?: Date } = {},
): Promise<PostgresSmokeReport> {
  if (backend.kind !== "postgres") {
    throw new SignCliError({
      code: "INVALID_ARGS",
      message: `runPostgresSmoke requires a PostgresBackend; got kind="${backend.kind}".`,
    });
  }
  const requestId = opts.requestId ?? `smk-${Date.now().toString(36)}`;
  const now = opts.now ?? new Date();
  const steps: PostgresSmokeStep[] = [];
  let allOk = true;

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const started = Date.now();
    try {
      const value = await fn();
      steps.push({ name, ok: true, durationMs: Date.now() - started });
      return value;
    } catch (error) {
      allOk = false;
      steps.push({
        name, ok: false, durationMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  await step("bootstrap-schema", () => bootstrapPostgresSchema(backend));
  await step("insert-request", async () => {
    await backend.prepareAsync(
      `INSERT INTO requests
       (id, title, document_path, document_hash, status, signers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      requestId,
      "postgres-smoke",
      "/tmp/no-such-doc.pdf",
      "0".repeat(64),
      "created",
      JSON.stringify([{ name: "Smoke", email: "smoke@example.com", order: 1 }]),
      now.toISOString(),
      now.toISOString(),
    );
  });
  await step("append-audit-event-1", () =>
    appendAuditEventAsync(backend, { requestId, eventType: "request.created", payload: { title: "smoke" }, now }),
  );
  await step("append-audit-event-2", () =>
    appendAuditEventAsync(backend, { requestId, eventType: "request.sent", payload: { provider: "test" }, now: new Date(now.getTime() + 1000) }),
  );
  await step("append-audit-event-3", () =>
    appendAuditEventAsync(backend, { requestId, eventType: "request.signed", payload: { signerEmail: "smoke@example.com" }, now: new Date(now.getTime() + 2000) }),
  );
  await step("verify-chain", async () => {
    const result = await verifyAuditChainAsync(backend, requestId);
    if (!result.valid) throw new Error(`audit chain broken: ${result.break?.kind}`);
    if (result.events !== 3) throw new Error(`expected 3 events, got ${result.events}`);
  });
  await step("list-audit-events", async () => {
    const events = await listAuditEventsAsync(backend, requestId);
    if (events.length !== 3) throw new Error(`listAuditEventsAsync returned ${events.length} rows`);
    if (events[0].event_type !== "request.created") {
      throw new Error(`first event should be request.created, got ${events[0].event_type}`);
    }
  });
  await step("search-audit-events", async () => {
    const result = await searchAuditEventsAsync(backend, { requestId, eventType: "request.signed" });
    if (result.total !== 1) throw new Error(`searchAuditEventsAsync filter returned ${result.total} rows`);
  });

  return { ok: allOk, steps, requestId };
}
