import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { shipMetricsLoop } from "../lib/metrics-ship.js";
import { createDb, makeTempDb } from "./helpers.js";

type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

async function withMockServer(
  handler: (req: RecordedRequest) => { status: number; body?: string } | Promise<{ status: number; body?: string }>,
  fn: (url: string, recorded: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const recorded: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    const recordedReq: RecordedRequest = { method: req.method ?? "GET", url: req.url ?? "/", headers, body };
    recorded.push(recordedReq);
    const result = await handler(recordedReq);
    res.statusCode = result.status;
    res.end(result.body ?? "");
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

test("shipMetricsLoop POSTs the rendered Prometheus body once and stops on max-pushes", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await withMockServer(
      () => ({ status: 200 }),
      async (url, recorded) => {
        const events: string[] = [];
        const report = await shipMetricsLoop(db, {
          url,
          maxPushes: 1,
          intervalMs: 10,
          onProgress: (e) => events.push(e.phase),
        });
        assert.equal(report.pushes, 1);
        assert.equal(report.errors, 0);
        assert.equal(report.stoppedReason, "max-pushes");
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].method, "POST");
        assert.match(recorded[0].headers["content-type"] ?? "", /text\/plain/);
        // The body is the Prometheus output — at minimum it should contain a HELP/TYPE line.
        assert.match(recorded[0].body, /sign_/);
        // "render" fires for every snapshot; "push" once per actual POST; "stopped" once at exit.
        assert.deepEqual(events, ["render", "push", "stopped"]);
      },
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("shipMetricsLoop sends Bearer auth and custom headers", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await withMockServer(
      () => ({ status: 200 }),
      async (url, recorded) => {
        await shipMetricsLoop(db, {
          url,
          bearer: "tok-abc",
          headers: { "x-tenant": "acme" },
          maxPushes: 1,
          intervalMs: 10,
        });
        assert.equal(recorded[0].headers.authorization, "Bearer tok-abc");
        assert.equal(recorded[0].headers["x-tenant"], "acme");
      },
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("shipMetricsLoop logs HTTP errors but keeps the loop alive", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    let calls = 0;
    await withMockServer(
      () => {
        calls += 1;
        return { status: calls === 1 ? 500 : 200 };
      },
      async (url) => {
        const phases: string[] = [];
        const report = await shipMetricsLoop(db, {
          url,
          maxPushes: 2,
          intervalMs: 10,
          onProgress: (e) => phases.push(e.phase),
        });
        assert.equal(report.pushes, 2);
        assert.equal(report.errors, 1);
        // Render fires before each push attempt; the first push errors, the second succeeds.
        assert.deepEqual(phases.filter((p) => p !== "stopped"), ["render", "error", "render", "push"]);
      },
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("shipMetricsLoop honors AbortSignal — stoppedReason becomes \"signal\"", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await withMockServer(
      () => ({ status: 200 }),
      async (url) => {
        const controller = new AbortController();
        // Schedule the abort just after the first push completes.
        const promise = shipMetricsLoop(db, {
          url,
          intervalMs: 50,
          maxPushes: 100,
          signal: controller.signal,
          onProgress: (e) => { if (e.phase === "push") setTimeout(() => controller.abort(), 5); },
        });
        const report = await promise;
        assert.equal(report.stoppedReason, "signal");
        assert.ok(report.pushes >= 1);
      },
    );
  } finally {
    db.close();
    cleanup();
  }
});
