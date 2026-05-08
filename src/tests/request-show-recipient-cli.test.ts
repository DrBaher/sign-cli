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

test("sign request show --recipient strips other signers from approvals + signers_json", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-show-recipient-"));
  const dbPath = path.join(dir, "sign.db");
  const docPath = path.join(dir, "doc.txt");
  writeFileSync(docPath, "alpha");
  const env = {
    SIGN_DB_PATH: dbPath,
    SIGN_LOCAL_STORE_DIR: path.join(dir, "store"),
    SIGN_LOCAL_AUTOCOMPLETE: "false",
    SIGN_ALLOW_ABSOLUTE_DOCS: "1",
  };
  try {
    const created = runCli([
      "request", "create",
      "--title", "Multi",
      "--document", docPath,
      "--signer", "name:Alice,email:alice@example.com,order:1",
      "--signer", "name:Bob,email:bob@example.com,order:2",
      "--provider", "local",
    ], env);
    assert.equal(created.status, 0);
    const requestId = JSON.parse(created.stdout).requestId;

    const result = runCli([
      "request", "show",
      "--request-id", requestId,
      "--recipient", "alice@example.com",
    ], env);
    assert.equal(result.status, 0);
    const snap = JSON.parse(result.stdout);
    assert.equal(snap.recipientView, "alice@example.com");
    // Only Alice in signers_json.
    const signers = JSON.parse(snap.request.signers_json);
    assert.equal(signers.length, 1);
    assert.equal(signers[0].email, "alice@example.com");
    // approvals filtered to the matching signer.
    assert.ok(snap.approvals.length >= 1);
    for (const approval of snap.approvals) {
      assert.equal(approval.signer_email, "alice@example.com");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign request show --recipient errors SIGNER_NOT_RECIPIENT for an email not on the request", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-show-recipient-bad-"));
  const dbPath = path.join(dir, "sign.db");
  const docPath = path.join(dir, "doc.txt");
  writeFileSync(docPath, "alpha");
  const env = {
    SIGN_DB_PATH: dbPath,
    SIGN_LOCAL_STORE_DIR: path.join(dir, "store"),
    SIGN_LOCAL_AUTOCOMPLETE: "false",
    SIGN_ALLOW_ABSOLUTE_DOCS: "1",
  };
  try {
    const created = runCli([
      "request", "create",
      "--title", "Solo",
      "--document", docPath,
      "--signer", "name:Alice,email:alice@example.com,order:1",
      "--provider", "local",
    ], env);
    const requestId = JSON.parse(created.stdout).requestId;

    const result = runCli([
      "request", "show",
      "--request-id", requestId,
      "--recipient", "stranger@example.com",
    ], env);
    assert.notEqual(result.status, 0);
    const closing = result.stderr.indexOf("\n}\n");
    const envelopeText = closing >= 0 ? result.stderr.slice(0, closing + 2) : result.stderr;
    const json = JSON.parse(envelopeText);
    assert.equal(json.error.code, "SIGNER_NOT_RECIPIENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
