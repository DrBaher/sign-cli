import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("sign db vacuum (sqlite default) reports pages/bytes before/after", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-db-vacuum-"));
  try {
    const result = runCli(["db", "vacuum"], {
      SIGN_DB_PATH: path.join(dir, "sign.db"),
    });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.backend, "sqlite");
    assert.equal(json.ranVacuum, true);
    assert.equal(json.ranOptimize, true);
    assert.equal(typeof json.pageSize, "number");
    assert.ok(json.pageSize > 0);
    assert.ok(json.pagesBefore >= 0);
    assert.ok(json.pagesAfter >= 0);
    assert.equal(json.bytesAfter, json.pagesAfter * json.pageSize);
    assert.equal(json.bytesReclaimed, json.bytesBefore - json.bytesAfter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign db vacuum --backend postgres requires --pg-url", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-db-vacuum-pg-"));
  try {
    const result = runCli(["db", "vacuum", "--backend", "postgres"], {
      SIGN_DB_PATH: path.join(dir, "sign.db"),
      SIGN_PG_URL: "",
    });
    assert.notEqual(result.status, 0);
    // Error envelope ends up on stderr as JSON; pull just that.
    const closing = result.stderr.indexOf("\n}\n");
    const envelopeText = closing >= 0 ? result.stderr.slice(0, closing + 2) : result.stderr;
    const json = JSON.parse(envelopeText);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, "MISSING_FLAG");
    assert.match(json.error.message, /pg-url|SIGN_PG_URL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign db vacuum --backend foo throws INVALID_ARGS", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-db-vacuum-bad-"));
  try {
    const result = runCli(["db", "vacuum", "--backend", "redis"], {
      SIGN_DB_PATH: path.join(dir, "sign.db"),
    });
    assert.notEqual(result.status, 0);
    const closing = result.stderr.indexOf("\n}\n");
    const envelopeText = closing >= 0 ? result.stderr.slice(0, closing + 2) : result.stderr;
    const json = JSON.parse(envelopeText);
    assert.equal(json.error.code, "INVALID_ARGS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
