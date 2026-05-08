import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("sign signer policy run-watch --report streams an NDJSON line per entry + a summary line on exit", { concurrency: false }, async () => {
  // We don't need a fully-loaded inbox — exit on timeout (no new entries) so
  // the only line in the report is the summary line. That alone proves:
  //   1. The report file is created
  //   2. NDJSON shape: each line is a complete JSON object
  //   3. The summary line carries succeeded/failed/skipped/exitReason
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-watch-report-"));
  const dbPath = path.join(dir, "sign.db");
  const tokensPath = path.join(dir, "tokens.json");
  const specPath = path.join(dir, "policy.json");
  const reportPath = path.join(dir, "out.ndjson");
  writeFileSync(tokensPath, "{}");
  writeFileSync(specPath, JSON.stringify({ rules: [{ match: "any", action: "report" }] }));
  try {
    const result = runCli([
      "signer", "policy", "run-watch",
      "--tokens-file", tokensPath,
      "--spec", specPath,
      "--report", reportPath,
      "--timeout-seconds", "1",
      "--interval-seconds", "5",
    ], {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_STORE_DIR: path.join(dir, "store"),
      SIGN_LOCAL_AUTOCOMPLETE: "false",
    });
    assert.equal(result.status, 4, "no new entries → timeout exit code 4");
    assert.ok(existsSync(reportPath), "report file should exist");
    const lines = readFileSync(reportPath, "utf8").trim().split("\n").filter(Boolean);
    // Empty inbox → no entry lines; just the summary.
    assert.equal(lines.length, 1);
    const summary = JSON.parse(lines[0]);
    assert.equal(summary.summary, true);
    assert.equal(summary.exitReason, "timeout");
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, 0);
    assert.match(summary.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
