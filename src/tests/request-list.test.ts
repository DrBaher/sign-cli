import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, listSigningRequests } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("listSigningRequests returns rows with provider/signer counts and supports filters", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("list");
  try {
    createSigningRequest(db, {
      title: "Dropbox A",
      documentPath,
      signers: [
        { name: "A", email: "a@x.com", order: 1 },
        { name: "B", email: "b@x.com", order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    createSigningRequest(db, {
      title: "SignWell A",
      documentPath,
      signers: [{ name: "C", email: "c@x.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "signwell",
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    const all = listSigningRequests(db);
    assert.equal(all.length, 2);
    assert.equal(all[0].title, "SignWell A");
    assert.equal(all[0].signers, 1);
    assert.equal(all[1].signers, 2);

    const onlyDropbox = listSigningRequests(db, { provider: "dropbox" });
    assert.equal(onlyDropbox.length, 1);
    assert.equal(onlyDropbox[0].provider, "dropbox");

    const limited = listSigningRequests(db, { limit: 1 });
    assert.equal(limited.length, 1);
  } finally {
    db.close();
    cleanup();
  }
});
