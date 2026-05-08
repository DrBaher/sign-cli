import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportAuditChainBundle } from "../lib/audit-chain-bundle.js";
import { anchorAllAuditChainHeads } from "../lib/audit-anchor.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { verifyRequestReceiptBundle } from "../lib/receipt-verify.js";
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

test("exportAuditChainBundle writes INDEX.json + per-request receipts that pass verifyRequestReceiptBundle", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("chain-bundle");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-chain-bundle-"));
    try {
      const r1 = createSigningRequest(db, {
        title: "R1", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const r2 = createSigningRequest(db, {
        title: "R2", documentPath,
        signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      // Issue an anchor so the bundle has something to seal.
      const anchored = await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });

      const out = path.join(dir, "bundle");
      const report = await exportAuditChainBundle(db, { outDir: out });
      assert.ok(existsSync(report.indexPath));
      const index = JSON.parse(readFileSync(report.indexPath, "utf8"));
      assert.equal(index.version, 1);
      assert.equal(index.requests.length, 2);
      const ids = index.requests.map((e: { requestId: string }) => e.requestId).sort();
      assert.deepEqual(ids, [r1.requestId, r2.requestId].sort());

      // Anchor block carried over.
      assert.ok(report.anchor);
      assert.equal(report.anchor!.digestHex, anchored.digestHex);
      assert.ok(existsSync(report.anchor!.tsrPath));
      assert.ok(existsSync(report.anchor!.manifestPath));

      // Per-request receipt bundles round-trip through verifyRequestReceiptBundle.
      for (const entry of report.requests) {
        const verdict = verifyRequestReceiptBundle(entry.receiptDir);
        assert.equal(verdict.ok, true, `receipt for ${entry.requestId} should verify`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("exportAuditChainBundle --request-id restricts the bundle to a single request", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("chain-bundle-restrict");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-chain-bundle-restrict-"));
  try {
    const r1 = createSigningRequest(db, {
      title: "Keep", documentPath,
      signers: [{ name: "A", email: "a@x.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    createSigningRequest(db, {
      title: "Skip", documentPath,
      signers: [{ name: "B", email: "b@x.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const out = path.join(dir, "bundle");
    const report = await exportAuditChainBundle(db, { outDir: out, requestIds: [r1.requestId] });
    assert.equal(report.requests.length, 1);
    assert.equal(report.requests[0].requestId, r1.requestId);
    // Anchor block is null since we never issued an anchor in this test.
    assert.equal(report.anchor, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});
