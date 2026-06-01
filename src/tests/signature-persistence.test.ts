import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase } from "../lib/db.js";
import { createSigningRequest, getRequestSnapshot, sendEmbeddedSigningRequest, sendSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("openDatabase adds signature_ids_json for existing request tables", () => {
  const { dbPath, cleanup } = makeTempDb();

  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        document_path TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        dropbox_signature_request_id TEXT,
        dropbox_status TEXT,
        signers_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.close();

    const db = openDatabase(dbPath);
    const columns = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;

    assert.equal(columns.some((column) => column.name === "signature_ids_json"), true);
    assert.equal(columns.some((column) => column.name === "provider"), true);
    assert.equal(columns.some((column) => column.name === "provider_request_id"), true);
    assert.equal(columns.some((column) => column.name === "provider_status"), true);
    db.close();
  } finally {
    cleanup();
  }
});

test("sendSigningRequest persists Dropbox signature IDs on the request", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("signature persistence");

  try {
    const created = createSigningRequest(db, {
      title: "Contract",
      provider: "dropbox",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    globalThis.fetch = async () => new Response(JSON.stringify({
      signature_request: {
        signature_request_id: "sigreq_123",
        signatures: [
          { signature_id: "sig_a" },
          { signature_id: "sig_b" },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await sendSigningRequest(db, {
      requestId: created.requestId,
      apiKey: "test-key",
      testMode: true,
      now: new Date("2026-01-01T00:01:00.000Z"),
      sendRequest: async () => ({
        signatureRequestId: "sigreq_123",
        signatureIds: ["sig_a", "sig_b"],
        statusCode: 200,
        responseBody: {
          signature_request: {
            signature_request_id: "sigreq_123",
            signatures: [
              { signature_id: "sig_a" },
              { signature_id: "sig_b" },
            ],
          },
        },
      }),
    });
    const snapshot = getRequestSnapshot(db, created.requestId);

    assert.equal(result.signatureRequestId, "sigreq_123");
    assert.deepEqual(result.signatureIds, ["sig_a", "sig_b"]);
    assert.equal(snapshot.request.provider, "dropbox");
    assert.equal(snapshot.request.provider_request_id, "sigreq_123");
    assert.equal(snapshot.request.provider_status, "sent");
    assert.equal(snapshot.request.dropbox_signature_request_id, "sigreq_123");
    assert.equal(snapshot.request.dropbox_status, "sent");
    assert.deepEqual(snapshot.request.signatureIds, ["sig_a", "sig_b"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("sendEmbeddedSigningRequest persists Dropbox signature IDs on the request", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("embedded persistence");

  try {
    const created = createSigningRequest(db, {
      title: "Embedded Contract",
      provider: "dropbox",
      documentPath,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      tokenTtlMinutes: 60,
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    globalThis.fetch = async () => new Response(JSON.stringify({
      signature_request: {
        signature_request_id: "sigreq_embedded",
        signatures: [
          { signature_id: "sig_embedded_1" },
          { signature_id: "sig_embedded_2" },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await sendEmbeddedSigningRequest(db, {
      requestId: created.requestId,
      apiKey: "test-key",
      clientId: "client_123",
      testMode: true,
      now: new Date("2026-01-01T00:01:00.000Z"),
      createEmbeddedRequest: async () => ({
        signatureRequestId: "sigreq_embedded",
        signatureIds: ["sig_embedded_1", "sig_embedded_2"],
        responseBody: {
          signature_request: {
            signature_request_id: "sigreq_embedded",
            signatures: [
              { signature_id: "sig_embedded_1" },
              { signature_id: "sig_embedded_2" },
            ],
          },
        },
      }),
    });
    const snapshot = getRequestSnapshot(db, created.requestId);

    assert.equal(snapshot.request.provider, "dropbox");
    assert.equal(snapshot.request.provider_request_id, "sigreq_embedded");
    assert.equal(result.signatureRequestId, "sigreq_embedded");
    assert.deepEqual(result.signatureIds, ["sig_embedded_1", "sig_embedded_2"]);
    assert.deepEqual(snapshot.request.signatureIds, ["sig_embedded_1", "sig_embedded_2"]);
  } finally {
    db.close();
    cleanup();
  }
});
