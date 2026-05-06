import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, approveSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("approval token expires after ttl", () => {
  const temp = makeTempDb();
  const db = createDb(temp.dbPath);
  const documentPath = createDocumentFixture();

  try {
    const created = createSigningRequest(db, {
      title: "Expiry Test",
      documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 5,
      now: new Date("2026-05-06T12:00:00.000Z"),
    });

    assert.throws(
      () =>
        approveSigningRequest(db, {
          requestId: created.requestId,
          token: created.tokens[0].token,
          now: new Date("2026-05-06T12:06:00.000Z"),
        }),
      /expired/u,
    );
  } finally {
    temp.cleanup();
  }
});
