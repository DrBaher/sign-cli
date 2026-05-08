import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { shipMetricsLoop } from "../lib/metrics-ship.js";
import { createDb, makeTempDb } from "./helpers.js";

type RecordedRequest = { method: string; body: string; headers: Record<string, string> };

async function withMockServer(
  fn: (url: string, recorded: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const recorded: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    recorded.push({ method: req.method ?? "GET", body: Buffer.concat(chunks).toString("utf8"), headers });
    res.statusCode = 200;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await fn(`http://127.0.0.1:${port}/metrics`, recorded);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("shipMetricsLoop --batch-size 3 POSTs once per 3 renders, with the body bundling all 3 snapshots", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await withMockServer(async (url, recorded) => {
      const events: string[] = [];
      const report = await shipMetricsLoop(db, {
        url,
        intervalMs: 5,
        batchSize: 3,
        maxPushes: 6, // 6 renders → 2 batches → 2 POSTs
        onProgress: (e) => events.push(e.phase),
      });
      assert.equal(report.pushes, 6);
      assert.equal(report.errors, 0);
      assert.equal(recorded.length, 2);
      // Both batches contain a BATCH BOUNDARY comment per snapshot.
      for (const r of recorded) {
        const boundaries = r.body.match(/# BATCH BOUNDARY/g) ?? [];
        assert.equal(boundaries.length, 3, "batched body should have one boundary line per snapshot");
        // Each snapshot still contains real Prometheus content (sign_*).
        const matches = r.body.match(/sign_/g) ?? [];
        assert.ok(matches.length >= 3, "each batched snapshot should still contain Prometheus metrics");
      }
      // Render events outnumber push events.
      const renders = events.filter((p) => p === "render").length;
      const pushes = events.filter((p) => p === "push").length;
      assert.equal(renders, 6);
      assert.equal(pushes, 2);
    });
  } finally {
    db.close();
    cleanup();
  }
});

test("shipMetricsLoop with batch-size 1 (default) keeps the single-snapshot body unchanged", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await withMockServer(async (url, recorded) => {
      await shipMetricsLoop(db, {
        url,
        intervalMs: 5,
        maxPushes: 1,
      });
      assert.equal(recorded.length, 1);
      // No BATCH BOUNDARY lines for un-batched bodies.
      assert.ok(!recorded[0].body.includes("# BATCH BOUNDARY"));
    });
  } finally {
    db.close();
    cleanup();
  }
});

test("shipMetricsLoop flushes the buffer on max-pushes even if it isn't full", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await withMockServer(async (url, recorded) => {
      // batchSize 5, maxPushes 2 — buffer never fills, but the final flush
      // still POSTs the partial batch so we don't lose data on shutdown.
      const report = await shipMetricsLoop(db, {
        url,
        intervalMs: 5,
        batchSize: 5,
        maxPushes: 2,
      });
      assert.equal(report.pushes, 2);
      assert.equal(recorded.length, 1, "partial buffer should be flushed on max-pushes");
      const boundaries = recorded[0].body.match(/# BATCH BOUNDARY/g) ?? [];
      assert.equal(boundaries.length, 2, "flushed body should contain both buffered snapshots");
    });
  } finally {
    db.close();
    cleanup();
  }
});
