import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPreflight, preflightExitCode } from "../lib/preflight.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
}

test("preflightExitCode: ok→0, failed→1", () => {
  assert.equal(preflightExitCode("ok"), 0);
  assert.equal(preflightExitCode("failed"), 1);
});

test("local preflight: writable temp dirs + canonical fixture → verdict=ok, exit=0", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preflight-ok-"));
  try {
    const r = await withEnv(
      {
        SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
        SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      },
      () => runPreflight("local"),
    );
    assert.equal(r.summary.verdict, "ok", `expected verdict=ok, got ${JSON.stringify(r)}`);
    assert.equal(r.summary.failed, 0);
    assert.ok(r.checks.find((c) => c.name === "permissions:key_dir" && c.status === "ok"));
    assert.ok(r.checks.find((c) => c.name === "permissions:store_dir" && c.status === "ok"));
    assert.ok(r.checks.find((c) => c.name === "fixture:canonical_unsigned" && c.status === "ok"));
    assert.equal(preflightExitCode(r.summary.verdict), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("local preflight: read-only key dir → verdict=failed with hint", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preflight-ro-"));
  const ro = path.join(tmp, "ro-keys");
  // Skip if running as root — chmod won't deny root, and this test would
  // pass spuriously. Most CI runs non-root; locally devs vary.
  if (process.getuid && process.getuid() === 0) {
    rmSync(tmp, { recursive: true, force: true });
    return;
  }
  // Make a read-only directory so the write probe fails. mkdir + chmod 0o500
  // (r-x for owner, no write).
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ro, { recursive: true });
  chmodSync(ro, 0o500);
  try {
    const r = await withEnv(
      {
        SIGN_LOCAL_KEY_DIR: ro,
        SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      },
      () => runPreflight("local"),
    );
    assert.equal(r.summary.verdict, "failed");
    const failed = r.checks.find((c) => c.name === "permissions:key_dir");
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.hint && failed.hint.includes("SIGN_LOCAL_KEY_DIR"), "failure hint should mention env var");
  } finally {
    chmodSync(ro, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dropbox preflight: missing API key → env check fails, connectivity is skipped (not failed twice)", async () => {
  const r = await withEnv({ DROPBOX_SIGN_API_KEY: undefined }, () => runPreflight("dropbox"));
  assert.equal(r.summary.verdict, "failed");
  const env = r.checks.find((c) => c.name === "env:DROPBOX_SIGN_API_KEY");
  const conn = r.checks.find((c) => c.name === "connectivity:dropbox_account");
  assert.equal(env?.status, "failed");
  assert.equal(conn?.status, "skipped", "connectivity should be skipped when env is missing — avoid double-counting the same root cause");
  assert.equal(r.summary.failed, 1, "exactly one failure (env), not two");
});

test("signwell preflight: missing API key → env fail + connectivity skip", async () => {
  const r = await withEnv({ SIGNWELL_API_KEY: undefined }, () => runPreflight("signwell"));
  assert.equal(r.summary.verdict, "failed");
  assert.equal(r.checks.find((c) => c.name === "env:SIGNWELL_API_KEY")?.status, "failed");
  assert.equal(r.checks.find((c) => c.name === "connectivity:signwell_account")?.status, "skipped");
});

test("docusign preflight: missing env vars → multiple env failures + missing key path absent", async () => {
  const r = await withEnv(
    {
      DOCUSIGN_INTEGRATION_KEY: undefined,
      DOCUSIGN_USER_ID: undefined,
      DOCUSIGN_ACCOUNT_ID: undefined,
      DOCUSIGN_BASE_PATH: undefined,
      DOCUSIGN_PRIVATE_KEY_PATH: undefined,
    },
    () => runPreflight("docusign"),
  );
  assert.equal(r.summary.verdict, "failed");
  assert.equal(r.summary.failed, 5, "all five DocuSign env vars should fail");
  // No key-path-existence check should be added when DOCUSIGN_PRIVATE_KEY_PATH is unset.
  assert.equal(r.checks.find((c) => c.name === "permissions:docusign_private_key"), undefined);
});

test("docusign preflight: env vars set + bad key path → permissions check reports the missing file", async () => {
  const r = await withEnv(
    {
      DOCUSIGN_INTEGRATION_KEY: "x",
      DOCUSIGN_USER_ID: "x",
      DOCUSIGN_ACCOUNT_ID: "x",
      DOCUSIGN_BASE_PATH: "x",
      DOCUSIGN_PRIVATE_KEY_PATH: "/tmp/nonexistent-preflight-key.pem",
    },
    () => runPreflight("docusign"),
  );
  const keyCheck = r.checks.find((c) => c.name === "permissions:docusign_private_key");
  assert.equal(keyCheck?.status, "failed");
  assert.ok(keyCheck?.detail.includes("does not exist"));
});
