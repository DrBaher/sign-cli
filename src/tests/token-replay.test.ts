import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, approveSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("approval token cannot be replayed", () => {
  const temp = makeTempDb();
  const db = createDb(temp.dbPath);
  const documentPath = createDocumentFixture();

  try {
    const created = createSigningRequest(db, {
      title: "Replay Test",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      now: new Date("2026-05-06T12:00:00.000Z"),
    });

    approveSigningRequest(db, {
      requestId: created.requestId,
      token: created.tokens[0].token,
      now: new Date("2026-05-06T12:10:00.000Z"),
    });

    assert.throws(
      () =>
        approveSigningRequest(db, {
          requestId: created.requestId,
          token: created.tokens[0].token,
          now: new Date("2026-05-06T12:11:00.000Z"),
        }),
      /already been used/u,
    );
  } finally {
    temp.cleanup();
  }
});
