import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("anchorAllAuditChainHeads --since restricts the manifest to chains that advanced after the cutoff", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("anchor-since");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-anchor-since-"));
    try {
      const oldR = createSigningRequest(db, {
        title: "Old", documentPath,
        signers: [{ name: "Old", email: "old@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      // Back-date its single event so the chain looks "stale" relative to the cutoff.
      db.exec("DROP TRIGGER IF EXISTS audit_events_no_update");
      db.prepare("UPDATE audit_events SET created_at = ? WHERE request_id = ?")
        .run("2025-01-01T00:00:00Z", oldR.requestId);
      const newR = createSigningRequest(db, {
        title: "New", documentPath,
        signers: [{ name: "New", email: "new@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });

      const cutoff = "2026-01-01T00:00:00Z";
      const report = await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir, since: cutoff });
      const ids = report.manifest.map((e) => e.requestId);
      assert.ok(ids.includes(newR.requestId), "fresh chain should be anchored");
      assert.ok(!ids.includes(oldR.requestId), "stale chain should be skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("anchorAllAuditChainHeads --since with no matching chains throws a clear error", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("anchor-since-empty");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-anchor-since-empty-"));
    try {
      createSigningRequest(db, {
        title: "Past", documentPath,
        signers: [{ name: "P", email: "p@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const futureCutoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await assert.rejects(
        () => anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir, since: futureCutoff }),
        (err: unknown) => err instanceof Error && /nothing to anchor/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("anchorAllAuditChainHeads --since rejects malformed timestamps before touching the TSA", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await assert.rejects(
      () => anchorAllAuditChainHeads(db, { since: "yesterday" }),
      (err: unknown) => err instanceof Error && /ISO 8601/.test(err.message),
    );
  } finally {
    db.close();
    cleanup();
  }
});
