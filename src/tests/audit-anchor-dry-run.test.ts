import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  anchorAllAuditChainHeads,
  previewAnchorAllAuditChainHeads,
} from "../lib/audit-anchor.js";
import { createSigningRequest, listAuditEvents } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("previewAnchorAllAuditChainHeads computes the same digest the real anchor would, without TSA or artifacts", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("anchor-dry-run");
  try {
    createSigningRequest(db, {
      title: "Preview", documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const eventCountBefore = listAuditEvents(db, "*").length;
    const preview = previewAnchorAllAuditChainHeads(db);
    assert.match(preview.digestHex, /^[0-9a-f]{64}$/);
    assert.equal(preview.manifest.length, 1);
    assert.ok(preview.manifestBytes > 0);
    assert.equal(preview.since, null);
    // No audit events appended (dry-run is read-only).
    const eventCountAfter = listAuditEvents(db, "*").length;
    assert.equal(eventCountBefore, eventCountAfter);
  } finally {
    db.close();
    cleanup();
  }
});

test("preview's digest matches a subsequent real anchor's digest when state is unchanged between them", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/timestamp-reply");
      res.end(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const tsaUrl = `http://127.0.0.1:${port}/tsa`;
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("anchor-dry-run-match");
  try {
    createSigningRequest(db, {
      title: "Match", documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const preview = previewAnchorAllAuditChainHeads(db);
    const real = await anchorAllAuditChainHeads(db, {
      tsaUrl,
      outDir: "/tmp/anchor-dryrun-match-" + Date.now(),
    });
    // Real anchor APPENDS audit.anchored events, so re-running preview AFTER
    // would see a different head — but the FIRST anchor of unchanged state
    // matches the preview's digest.
    assert.equal(preview.digestHex, real.digestHex);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanup();
  }
});

test("previewAnchorAllAuditChainHeads --since rejects malformed timestamps before any DB scan", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    assert.throws(
      () => previewAnchorAllAuditChainHeads(db, { since: "not-a-date" }),
      (err: unknown) => err instanceof Error && /ISO 8601/.test(err.message),
    );
  } finally {
    db.close();
    cleanup();
  }
});
