import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { anchorAllAuditChainHeads, verifyAnchorManifest } from "../lib/audit-anchor.js";
import { appendAuditEvent } from "../lib/audit.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { dropAuditAppendOnlyTriggers, installAuditAppendOnlyTriggers } from "../lib/db.js";
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

test("verifyAnchorManifest reports matches when the anchor was just issued (heads will then move with audit.anchored events appended after manifest snapshot)", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("verify-anchor-match");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-anchor-"));
    try {
      createSigningRequest(db, {
        title: "R", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const anchored = await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });
      // Manifest file is what we'd ship to an auditor — load it back and verify.
      const manifest = JSON.parse(readFileSync(anchored.manifestPath, "utf8"));
      const report = verifyAnchorManifest(db, manifest);
      // Anchor APPENDED audit.anchored to each chain, so heads moved past the
      // manifest's anchored hash. Outcome should be "shifted" — the anchored
      // hash is still present earlier in the chain.
      assert.equal(report.total, 1);
      assert.equal(report.shifted, 1);
      assert.equal(report.tampered, 0);
      assert.equal(report.missing, 0);
      assert.equal(report.digestHex, anchored.digestHex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("verifyAnchorManifest flags a request as tampered when its history was rewritten", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("verify-anchor-tamper");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-anchor-tamper-"));
    try {
      const r = createSigningRequest(db, {
        title: "T", documentPath,
        signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const anchored = await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });
      const manifest = JSON.parse(readFileSync(anchored.manifestPath, "utf8"));

      // Simulate tampering: drop the append-only triggers, blow away the chain,
      // re-install triggers. Now the anchored hashSelf is GONE.
      dropAuditAppendOnlyTriggers(db);
      db.prepare("DELETE FROM audit_events WHERE request_id = ?").run(r.requestId);
      installAuditAppendOnlyTriggers(db);
      // Append a single fresh event so head exists but doesn't match.
      appendAuditEvent(db, { requestId: r.requestId, eventType: "synthetic", payload: { rewritten: true } });

      const report = verifyAnchorManifest(db, manifest);
      assert.equal(report.tampered, 1);
      assert.equal(report.matches, 0);
      assert.equal(report.shifted, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("verifyAnchorManifest flags requests that no longer exist as missing", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const manifest = [{ requestId: "req-doesnt-exist", hashSelf: "abc" }];
    const report = verifyAnchorManifest(db, manifest);
    assert.equal(report.missing, 1);
    assert.equal(report.results[0].outcome, "missing");
  } finally {
    db.close();
    cleanup();
  }
});

test("verifyAnchorManifest digestHex is invariant under input order (manifest is sorted before hashing)", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const a = verifyAnchorManifest(db, [
      { requestId: "req-2", hashSelf: "h2" },
      { requestId: "req-1", hashSelf: "h1" },
    ]);
    const b = verifyAnchorManifest(db, [
      { requestId: "req-1", hashSelf: "h1" },
      { requestId: "req-2", hashSelf: "h2" },
    ]);
    assert.equal(a.digestHex, b.digestHex);
  } finally {
    db.close();
    cleanup();
  }
});
