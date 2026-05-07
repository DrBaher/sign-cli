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
      env: { ...process.env, SIGN_DB_PATH: path.join(os.tmpdir(), "sign-policy-diff-cli.db"), ...extraEnv },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const decode = (v: Buffer | string | undefined) => (Buffer.isBuffer(v) ? v.toString("utf8") : (v ?? ""));
    return { stdout: decode(err.stdout), stderr: decode(err.stderr), status: err.status ?? 1 };
  }
}

test("sign signer policy diff with --snapshot reports the action flip between two specs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-diff-"));
  const beforePath = path.join(dir, "before.json");
  const afterPath = path.join(dir, "after.json");
  const snapshotPath = path.join(dir, "snap.json");
  writeFileSync(beforePath, JSON.stringify({
    rules: [{ match: { titlePattern: "^NDA " }, action: "sign" }, { match: "any", action: "report" }],
  }));
  writeFileSync(afterPath, JSON.stringify({
    rules: [{ match: { titlePattern: "^NDA " }, action: "decline", reason: "no more autos" }, { match: "any", action: "report" }],
  }));
  writeFileSync(snapshotPath, JSON.stringify({
    request: {
      id: "req-1",
      title: "NDA Acme",
      document_hash: "ff",
      signers_json: JSON.stringify([{ email: "alice@example.com", name: "Alice", order: 1 }]),
    },
  }));
  try {
    const result = runCli([
      "signer", "policy", "diff",
      "--before", beforePath,
      "--after", afterPath,
      "--snapshot", snapshotPath,
    ]);
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.before, beforePath);
    assert.equal(json.after, afterPath);
    assert.equal(json.total, 1);
    assert.equal(json.changed, 1);
    assert.equal(json.results[0].before.action, "sign");
    assert.equal(json.results[0].after.action, "decline");
    assert.equal(json.flipped.decline, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign signer policy diff errors when neither --snapshot nor --inbox is given", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-diff-"));
  const beforePath = path.join(dir, "before.json");
  const afterPath = path.join(dir, "after.json");
  writeFileSync(beforePath, JSON.stringify({ rules: [{ match: "any", action: "sign" }] }));
  writeFileSync(afterPath, JSON.stringify({ rules: [{ match: "any", action: "decline" }] }));
  try {
    const result = runCli([
      "signer", "policy", "diff",
      "--before", beforePath,
      "--after", afterPath,
    ]);
    assert.notEqual(result.status, 0);
    // The error envelope is emitted as JSON on stderr; node's experimental warnings
    // can also land there, so cut off everything after the outermost closing brace.
    const outerClose = result.stderr.indexOf("\n}\n");
    const envelopeText = outerClose >= 0 ? result.stderr.slice(0, outerClose + 2) : result.stderr;
    const json = JSON.parse(envelopeText);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, "MISSING_FLAG");
    assert.match(json.error.message, /--snapshot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
