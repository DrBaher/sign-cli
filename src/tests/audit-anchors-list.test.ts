import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { anchorAllAuditChainHeads, listStoredAnchors } from "../lib/audit-anchor.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

async function withMockTsa(fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/timestamp-reply");
      res.end(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await fn(`http://127.0.0.1:${port}/tsa`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("listStoredAnchors returns the anchors written by anchorAllAuditChainHeads, newest first", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("anchors-list");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-anchors-list-"));
    try {
      createSigningRequest(db, {
        title: "Anchored", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const a = await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });
      // Run a second anchor to confirm ordering by created_at DESC.
      await new Promise((r) => setTimeout(r, 5));
      const b = await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });

      const anchors = listStoredAnchors(db);
      assert.equal(anchors.length, 2);
      // Newest first.
      assert.equal(anchors[0].digestHex, b.digestHex);
      assert.equal(anchors[1].digestHex, a.digestHex);
      // Metadata round-trips.
      assert.equal(anchors[0].tsaUrl, b.tsaUrl);
      assert.equal(anchors[0].coveredRequests, 1);
      assert.equal(anchors[0].manifestPath, b.manifestPath);
      assert.equal(typeof anchors[0].contentHash, "string");
      assert.equal(typeof anchors[0].createdAt, "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("listStoredAnchors returns an empty array when no anchors have been issued", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    assert.deepEqual(listStoredAnchors(db), []);
  } finally {
    db.close();
    cleanup();
  }
});
