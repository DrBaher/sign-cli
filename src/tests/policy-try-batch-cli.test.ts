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
      env: { ...process.env, SIGN_DB_PATH: path.join(os.tmpdir(), "sign-policy-try-batch.db"), ...extraEnv },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const decode = (v: Buffer | string | undefined) => (Buffer.isBuffer(v) ? v.toString("utf8") : (v ?? ""));
    return { stdout: decode(err.stdout), stderr: decode(err.stderr), status: err.status ?? 1 };
  }
}

test("sign signer policy try --batch evaluates a JSON array of contexts and emits a per-row decisions[] array", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-try-batch-"));
  const specPath = path.join(dir, "policy.json");
  const batchPath = path.join(dir, "contexts.json");
  writeFileSync(specPath, JSON.stringify({
    rules: [
      { match: { titlePattern: "^NDA " }, action: "sign" },
      { match: { signerEmail: "vip@example.com" }, action: "sign" },
      { match: "any", action: "report" },
    ],
  }));
  writeFileSync(batchPath, JSON.stringify([
    { label: "nda-alice", title: "NDA Acme", documentSha256: "aa", signerEmail: "alice@example.com" },
    { label: "msa-vip", title: "MSA", documentSha256: "bb", signerEmail: "vip@example.com" },
    { label: "other-bob", title: "Other", documentSha256: "cc", signerEmail: "bob@example.com" },
  ]));
  try {
    const result = runCli([
      "signer", "policy", "try",
      "--spec", specPath,
      "--batch", batchPath,
    ]);
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.spec, specPath);
    assert.equal(json.total, 3);
    assert.equal(json.sign, 2);
    assert.equal(json.report, 1);
    assert.equal(json.decline, 0);
    assert.equal(json.errored, 0);
    assert.equal(json.decisions.length, 3);
    assert.equal(json.decisions[0].label, "nda-alice");
    assert.equal(json.decisions[0].decision.action, "sign");
    assert.equal(json.decisions[2].decision.action, "report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign signer policy try --batch records per-row expectation failures as decline (one bad row doesn't poison the batch)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-try-batch-error-"));
  const specPath = path.join(dir, "policy.json");
  const batchPath = path.join(dir, "contexts.json");
  // expectations.signerEmail forces a mismatch on row 2.
  writeFileSync(specPath, JSON.stringify({
    expectations: { signerEmail: "trusted@example.com" },
    rules: [{ match: "any", action: "sign" }],
  }));
  writeFileSync(batchPath, JSON.stringify([
    { title: "Trusted", documentSha256: "aa", signerEmail: "trusted@example.com" },
    { title: "Bad", documentSha256: "bb", signerEmail: "stranger@example.com" },
  ]));
  try {
    const result = runCli([
      "signer", "policy", "try",
      "--spec", specPath,
      "--batch", batchPath,
    ]);
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    // POLICY_VIOLATION from expectations is thrown; we surface as errored=1.
    assert.equal(json.total, 2);
    assert.equal(json.sign, 1);
    assert.equal(json.errored, 1);
    const errored = json.decisions.find((d: { error: unknown }) => d.error !== null);
    assert.ok(errored);
    assert.equal(errored.decision, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign signer policy try --batch rejects a non-array JSON file with INVALID_SPEC", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-try-batch-bad-"));
  const specPath = path.join(dir, "policy.json");
  const batchPath = path.join(dir, "contexts.json");
  writeFileSync(specPath, JSON.stringify({ rules: [{ match: "any", action: "sign" }] }));
  writeFileSync(batchPath, JSON.stringify({ title: "single object — not an array" }));
  try {
    const result = runCli([
      "signer", "policy", "try",
      "--spec", specPath,
      "--batch", batchPath,
    ]);
    assert.notEqual(result.status, 0);
    const closing = result.stderr.indexOf("\n}\n");
    const envelopeText = closing >= 0 ? result.stderr.slice(0, closing + 2) : result.stderr;
    const json = JSON.parse(envelopeText);
    assert.equal(json.error.code, "INVALID_SPEC");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
