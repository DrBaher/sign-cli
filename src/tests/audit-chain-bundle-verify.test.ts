import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportAuditChainBundle, verifyAuditChainBundle } from "../lib/audit-chain-bundle.js";
import { anchorAllAuditChainHeads } from "../lib/audit-anchor.js";
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

test("verifyAuditChainBundle accepts a freshly-issued bundle (anchor matches, every receipt verifies)", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("verify-bundle-ok");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-bundle-"));
    try {
      createSigningRequest(db, {
        title: "OK", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });
      const out = path.join(dir, "bundle");
      await exportAuditChainBundle(db, { outDir: out });
      const report = await verifyAuditChainBundle(out);
      assert.equal(report.ok, true);
      assert.equal(report.passed, 1);
      assert.equal(report.failed, 0);
      assert.equal(report.anchor.present, true);
      if (report.anchor.present) {
        assert.equal(report.anchor.matches, true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("verifyAuditChainBundle reports anchor digest mismatch when INDEX.json has been doctored", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("verify-bundle-tamper");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-bundle-tamper-"));
    try {
      createSigningRequest(db, {
        title: "Tamper", documentPath,
        signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });
      const out = path.join(dir, "bundle");
      await exportAuditChainBundle(db, { outDir: out });
      // Doctor INDEX.json: blow away the recorded digest.
      const indexPath = path.join(out, "INDEX.json");
      const idx = JSON.parse(readFileSync(indexPath, "utf8"));
      idx.anchor.digestHex = "00".repeat(32);
      writeFileSync(indexPath, JSON.stringify(idx));
      const report = await verifyAuditChainBundle(out);
      assert.equal(report.ok, false);
      if (report.anchor.present) assert.equal(report.anchor.matches, false);
      assert.ok(report.errors.some((e) => /anchor digest mismatch/.test(e)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("verifyAuditChainBundle returns ok:false with a clear error when INDEX.json is missing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-bundle-empty-"));
  try {
    const report = await verifyAuditChainBundle(dir);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => /INDEX\.json missing/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
