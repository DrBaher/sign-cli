import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("sign audit show --since/--until clamp the time window", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-show-window-"));
  const dbPath = path.join(dir, "sign.db");
  const docPath = path.join(dir, "doc.txt");
  writeFileSync(docPath, "alpha");
  try {
    const created = runCli([
      "request", "create",
      "--title", "Window",
      "--document", docPath,
      "--signer", "name:Alice,email:alice@example.com,order:1",
      "--provider", "local",
      "--auto-approve", "true",
    ], {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_STORE_DIR: path.join(dir, "store"),
      SIGN_LOCAL_AUTOCOMPLETE: "false",
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    });
    const requestId = JSON.parse(created.stdout).requestId;

    // Future-tense --since → 0 events (everything is older than the cutoff).
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const futureRes = runCli(["audit", "show", "--request-id", requestId, "--since", future], { SIGN_DB_PATH: dbPath });
    assert.deepEqual(JSON.parse(futureRes.stdout), []);

    // Past-tense --until → 0 events too.
    const past = new Date(0).toISOString();
    const pastRes = runCli(["audit", "show", "--request-id", requestId, "--until", past], { SIGN_DB_PATH: dbPath });
    assert.deepEqual(JSON.parse(pastRes.stdout), []);

    // Wide window → all events come through.
    const wide = runCli([
      "audit", "show", "--request-id", requestId,
      "--since", new Date(0).toISOString(),
      "--until", new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ], { SIGN_DB_PATH: dbPath });
    const all = JSON.parse(wide.stdout);
    assert.ok(all.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign audit show --since rejects malformed ISO 8601", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-show-window-bad-"));
  try {
    const result = runCli([
      "audit", "show",
      "--request-id", "req-x",
      "--since", "yesterday",
    ], { SIGN_DB_PATH: path.join(dir, "sign.db") });
    assert.notEqual(result.status, 0);
    const closing = result.stderr.indexOf("\n}\n");
    const envelopeText = closing >= 0 ? result.stderr.slice(0, closing + 2) : result.stderr;
    const json = JSON.parse(envelopeText);
    assert.equal(json.error.code, "INVALID_ARGS");
    assert.match(json.error.message, /--since/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
