import test from "node:test";
import assert from "node:assert/strict";
import { searchAuditEvents } from "../lib/audit.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { SignCliError } from "../lib/sign-error.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("searchAuditEvents returns all events when no filters are given (newest first)", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("search-all");
  try {
    createSigningRequest(db, {
      title: "Search me", documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const result = searchAuditEvents(db);
    assert.ok(result.total >= 1);
    // Newest-first ordering: id descending.
    for (let i = 1; i < result.results.length; i += 1) {
      assert.ok(result.results[i - 1].id > result.results[i].id);
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("searchAuditEvents --request-id and --event-type filters compose with AND semantics", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("search-and");
  try {
    const a = createSigningRequest(db, {
      title: "A", documentPath,
      signers: [{ name: "A", email: "a@x.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const b = createSigningRequest(db, {
      title: "B", documentPath,
      signers: [{ name: "B", email: "b@x.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const onlyA = searchAuditEvents(db, { requestId: a.requestId });
    const onlyB = searchAuditEvents(db, { requestId: b.requestId });
    assert.ok(onlyA.results.every((e) => e.requestId === a.requestId));
    assert.ok(onlyB.results.every((e) => e.requestId === b.requestId));

    const created = searchAuditEvents(db, { eventType: "request.created" });
    assert.ok(created.results.every((e) => e.eventType === "request.created"));

    const aCreated = searchAuditEvents(db, { requestId: a.requestId, eventType: "request.created" });
    assert.equal(aCreated.results.length, 1);
    assert.equal(aCreated.results[0].requestId, a.requestId);
  } finally {
    db.close();
    cleanup();
  }
});

test("searchAuditEvents --payload-contains finds matches on the JSON-serialized payload", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("search-payload");
  try {
    createSigningRequest(db, {
      title: "Findable", documentPath,
      signers: [{ name: "Carol", email: "carol@findme.io", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const hits = searchAuditEvents(db, { payloadContains: "carol@findme.io" });
    assert.ok(hits.total >= 1);
    for (const hit of hits.results) {
      assert.match(JSON.stringify(hit.payload), /findme\.io/);
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("searchAuditEvents rejects malformed --since/--until with INVALID_ARGS", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    assert.throws(
      () => searchAuditEvents(db, { since: "yesterday" }),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
    );
    assert.throws(
      () => searchAuditEvents(db, { until: "not-a-date" }),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
    );
  } finally {
    db.close();
    cleanup();
  }
});
