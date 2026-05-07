import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function runCli(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; status: number } {
  const cliPath = path.resolve("dist", "cli.js");
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, SIGN_DB_PATH: path.join(os.tmpdir(), "sign-policy-try.db"), ...extraEnv },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status ?? 1 };
  }
}

test("sign signer policy try evaluates a synthetic context against a spec file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-try-"));
  const specPath = path.join(dir, "policy.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      rules: [
        { match: { titlePattern: "addendum" }, action: "decline", reason: "addendum" },
        { match: { titlePattern: "^Mutual NDA" }, action: "sign" },
      ],
    }),
  );
  try {
    const ndaResult = runCli([
      "signer", "policy", "try",
      "--spec", specPath,
      "--title", "Mutual NDA – round 2",
      "--document-sha256", "abc",
      "--signer-email", "alice@example.com",
    ]);
    assert.equal(ndaResult.status, 0);
    const nda = JSON.parse(ndaResult.stdout);
    assert.equal(nda.decision.action, "sign");
    assert.equal(nda.ctx.title, "Mutual NDA – round 2");

    const addResult = runCli([
      "signer", "policy", "try",
      "--spec", specPath,
      "--title", "Risky addendum",
      "--document-sha256", "abc",
      "--signer-email", "alice@example.com",
    ]);
    const add = JSON.parse(addResult.stdout);
    assert.equal(add.decision.action, "decline");
    assert.equal(add.decision.reason, "addendum");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign signer policy try --snapshot reads context from a request show JSON file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-try-snap-"));
  const specPath = path.join(dir, "policy.json");
  const snapPath = path.join(dir, "snap.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      rules: [{ match: { titlePattern: "^Mutual NDA" }, action: "sign" }, { match: "any", action: "decline" }],
    }),
  );
  writeFileSync(
    snapPath,
    JSON.stringify({
      request: {
        title: "Mutual NDA via snapshot",
        document_hash: "deadbeef",
        signers_json: JSON.stringify([{ name: "Alice", email: "alice@example.com", order: 1 }]),
      },
      signedBy: null,
    }),
  );
  try {
    const result = runCli([
      "signer", "policy", "try",
      "--spec", specPath,
      "--snapshot", snapPath,
    ]);
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.ctx.title, "Mutual NDA via snapshot");
    assert.equal(out.ctx.documentSha256, "deadbeef");
    assert.equal(out.ctx.signerEmail, "alice@example.com");
    assert.equal(out.decision.action, "sign");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
