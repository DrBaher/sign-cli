import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportAuditChainBundle } from "../lib/audit-chain-bundle.js";
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

function runCli(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
  const cliPath = path.resolve("dist", "cli.js");
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const decode = (v: Buffer | string | undefined) => (Buffer.isBuffer(v) ? v.toString("utf8") : (v ?? ""));
    return { stdout: decode(err.stdout), stderr: decode(err.stderr), status: err.status ?? 1 };
  }
}

test("sign audit verify-chain-bundle --report streams one NDJSON line per per-request result + a summary line", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("verify-bundle-report");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-bundle-report-"));
    try {
      // Two requests so the report has more than just a summary.
      createSigningRequest(db, {
        title: "R1", documentPath,
        signers: [{ name: "A", email: "a@x.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      createSigningRequest(db, {
        title: "R2", documentPath,
        signers: [{ name: "B", email: "b@x.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });
      const bundleDir = path.join(dir, "bundle");
      await exportAuditChainBundle(db, { outDir: bundleDir });
      const reportPath = path.join(dir, "verify.ndjson");

      const result = runCli([
        "audit", "verify-chain-bundle",
        "--bundle", bundleDir,
        "--report", reportPath,
      ], { SIGN_DB_PATH: dbPath });
      assert.equal(result.status, 0);
      assert.ok(existsSync(reportPath));
      const lines = readFileSync(reportPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 3); // 2 row lines + 1 summary
      const parsed = lines.map((l) => JSON.parse(l));
      // Row lines have requestId + ok
      assert.ok(parsed[0].requestId);
      assert.equal(typeof parsed[0].ok, "boolean");
      // Summary line carries discriminant + counters
      const summary = parsed[parsed.length - 1];
      assert.equal(summary.summary, true);
      assert.equal(summary.passed, 2);
      assert.equal(summary.failed, 0);
      assert.equal(summary.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("sign audit verify-chain-bundle without --report still prints the JSON envelope on stdout", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-bundle-noreport-"));
  try {
    // Empty bundle dir → ok:false but the command must still emit JSON to stdout.
    const result = runCli([
      "audit", "verify-chain-bundle",
      "--bundle", dir,
    ], { SIGN_DB_PATH: path.join(dir, "sign.db") });
    assert.equal(result.status, 3);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, false);
    assert.ok(json.errors.some((e: string) => /INDEX\.json missing/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
