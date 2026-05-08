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

test("sign request show --hash-only prints just { requestId, documentSha256, chainHead }", { concurrency: false }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-show-hash-only-"));
  const dbPath = path.join(dir, "sign.db");
  const docPath = path.join(dir, "doc.txt");
  writeFileSync(docPath, "alpha");
  try {
    const created = runCli([
      "request", "create",
      "--title", "HashOnly", "--document", docPath,
      "--signer", "name:Alice,email:alice@example.com,order:1",
      "--provider", "local",
      "--auto-approve", "true",
    ], {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_STORE_DIR: path.join(dir, "store"),
      SIGN_LOCAL_AUTOCOMPLETE: "false",
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    });
    assert.equal(created.status, 0);
    const requestId = JSON.parse(created.stdout).requestId;

    const show = runCli([
      "request", "show",
      "--request-id", requestId,
      "--hash-only", "true",
    ], { SIGN_DB_PATH: dbPath });
    assert.equal(show.status, 0);
    const json = JSON.parse(show.stdout);
    // Exactly three keys, no signers / no metrics / no nextSteps.
    assert.deepEqual(Object.keys(json).sort(), ["chainHead", "documentSha256", "requestId"]);
    assert.equal(json.requestId, requestId);
    assert.match(json.documentSha256, /^[0-9a-f]{64}$/);
    assert.match(json.chainHead, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign request show --hash-only on an unknown request errors REQUEST_NOT_FOUND", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-show-hash-only-missing-"));
  try {
    const result = runCli([
      "request", "show",
      "--request-id", "req-doesnt-exist",
      "--hash-only", "true",
    ], { SIGN_DB_PATH: path.join(dir, "sign.db") });
    assert.notEqual(result.status, 0);
    const closing = result.stderr.indexOf("\n}\n");
    const envelopeText = closing >= 0 ? result.stderr.slice(0, closing + 2) : result.stderr;
    const json = JSON.parse(envelopeText);
    assert.equal(json.error.code, "REQUEST_NOT_FOUND");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
