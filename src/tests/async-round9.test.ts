import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningRequest,
  persistRequestProviderMetadataAsync,
} from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("persistRequestProviderMetadataAsync persists provider + provider_request_id + signature_ids on the SqliteBackend", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("persist-provider-async");
  try {
    const r = createSigningRequest(db, {
      title: "Persist async",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    await persistRequestProviderMetadataAsync(backend, {
      requestId: r.requestId,
      provider: "dropbox",
      providerRequestId: "drop-123",
      providerStatus: "sent",
      signatureIds: ["sig-1", "sig-2"],
      now: new Date("2026-05-08T12:00:00Z"),
    });
    const row = db.prepare(
      "SELECT provider, provider_request_id, provider_status, dropbox_signature_request_id, signature_ids_json, updated_at FROM requests WHERE id = ?",
    ).get(r.requestId) as Record<string, unknown>;
    assert.equal(row.provider, "dropbox");
    assert.equal(row.provider_request_id, "drop-123");
    assert.equal(row.provider_status, "sent");
    assert.equal(row.dropbox_signature_request_id, "drop-123"); // dropbox provider mirrors
    assert.deepEqual(JSON.parse(row.signature_ids_json as string), ["sig-1", "sig-2"]);
    assert.equal(row.updated_at, "2026-05-08T12:00:00.000Z");
  } finally {
    db.close();
    cleanup();
  }
});

test("persistRequestProviderMetadataAsync against PostgresBackend uses translated $1..$11 placeholders", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  await persistRequestProviderMetadataAsync(backend, {
    requestId: "req-x",
    provider: "signwell",
    providerRequestId: "sw-1",
    providerStatus: "sent",
    signatureIds: ["sig-x"],
    now: new Date("2026-05-08T12:00:00Z"),
  });
  assert.equal(seen.length, 1);
  for (let i = 1; i <= 11; i += 1) {
    assert.ok(seen[0].text.includes(`$${i}`), `query should reference $${i}`);
  }
  assert.ok(!seen[0].text.includes("?"));
  assert.equal(seen[0].params?.length, 11);
});

test("persistRequestProviderMetadataAsync with provider != dropbox does not populate dropbox_* columns", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("persist-non-dropbox");
  try {
    const r = createSigningRequest(db, {
      title: "Non-dropbox",
      documentPath,
      signers: [{ name: "B", email: "b@x.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "signwell",
    });
    const backend = wrapSqliteDb(db);
    await persistRequestProviderMetadataAsync(backend, {
      requestId: r.requestId,
      provider: "signwell",
      providerRequestId: "sw-99",
      providerStatus: "completed",
      now: new Date("2026-05-08T12:00:00Z"),
    });
    const row = db.prepare(
      "SELECT provider, provider_request_id, dropbox_signature_request_id, dropbox_status FROM requests WHERE id = ?",
    ).get(r.requestId) as Record<string, unknown>;
    assert.equal(row.provider, "signwell");
    assert.equal(row.provider_request_id, "sw-99");
    assert.equal(row.dropbox_signature_request_id, null);
    assert.equal(row.dropbox_status, null);
  } finally {
    db.close();
    cleanup();
  }
});
