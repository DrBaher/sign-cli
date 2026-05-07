import test from "node:test";
import assert from "node:assert/strict";
import nodePath from "node:path";
import { createSigningRequest, getRequestSnapshot, sendSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("createSigningRequest stores multiple documents and exposes them in the snapshot", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const docA = createDocumentFixture("contract A");
  const docB = createDocumentFixture("contract B");
  try {
    const created = createSigningRequest(db, {
      title: "Multi-doc",
      documentPaths: [docA, docB],
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date(),
    });
    assert.equal(created.documents.length, 2);
    const snapshot = getRequestSnapshot(db, created.requestId);
    assert.equal(snapshot.request.documents.length, 2);
    assert.notEqual(snapshot.request.documents[0].hash, snapshot.request.documents[1].hash);
  } finally {
    db.close();
    cleanup();
  }
});

test("sendSigningRequest threads all document paths to the provider call", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const docA = createDocumentFixture("A");
  const docB = createDocumentFixture("B");
  try {
    const created = createSigningRequest(db, {
      title: "Multi to provider",
      documentPaths: [docA, docB],
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
      now: new Date(),
    });
    let receivedPaths: string[] | null = null;
    await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
      sendRequest: async (input) => {
        receivedPaths = input.documentPaths ?? [input.documentPath];
        return {
          signatureRequestId: "sigreq_multi",
          signatureIds: [],
          statusCode: 200,
          responseBody: {},
        };
      },
    });
    assert.deepEqual(receivedPaths, [docA, docB].map((p) => nodePath.resolve(p)));
  } finally {
    db.close();
    cleanup();
  }
});
