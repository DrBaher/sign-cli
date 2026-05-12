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

test("env-health: runtime:node_version + storage:db_path run on every provider, before provider checks", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preflight-env-"));
  try {
    const r = await withEnv(
      {
        SIGN_DB_PATH: path.join(tmp, "sign.db"),
        SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
        SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      },
      () => runPreflight("local"),
    );
    // Both env-health checks present.
    const node = r.checks.find((c) => c.name === "runtime:node_version");
    const db = r.checks.find((c) => c.name === "storage:db_path");
    assert.ok(node, "runtime:node_version must be in checks[]");
    assert.ok(db, "storage:db_path must be in checks[]");
    // Node version passes (CI runs Node >= 22 since that's the package engine).
    assert.equal(node?.status, "ok");
    assert.equal(db?.status, "ok");
    // Ordering: env-health checks come before provider checks.
    const nodeIdx = r.checks.findIndex((c) => c.name === "runtime:node_version");
    const firstProviderIdx = r.checks.findIndex((c) => c.name.startsWith("permissions:"));
    assert.ok(nodeIdx < firstProviderIdx, "env-health checks should come before provider checks");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("env-health: storage:db_path failed when SIGN_DB_PATH points at an unwritable parent", async () => {
  if (process.getuid && process.getuid() === 0) return; // root bypasses permission denials
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preflight-db-ro-"));
  const roDir = path.join(tmp, "ro");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(roDir, { recursive: true });
  chmodSync(roDir, 0o500);
  try {
    const r = await withEnv(
      {
        SIGN_DB_PATH: path.join(roDir, "sign.db"),
      },
      () => runPreflight("dropbox"), // any provider — env-health runs first
    );
    const db = r.checks.find((c) => c.name === "storage:db_path");
    assert.equal(db?.status, "failed");
    assert.ok(db?.hint && db.hint.includes("SIGN_DB_PATH"), "hint should mention the env var to set");
    assert.equal(r.summary.verdict, "failed");
  } finally {
    chmodSync(roDir, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("env-health: storage:db_path passes for every provider (not just local)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preflight-env-allprov-"));
  try {
    for (const provider of ["dropbox", "signwell", "docusign"] as const) {
      const r = await withEnv(
        { SIGN_DB_PATH: path.join(tmp, `${provider}.db`) },
        () => runPreflight(provider),
      );
      const db = r.checks.find((c) => c.name === "storage:db_path");
      assert.equal(db?.status, "ok", `storage:db_path should be ok for ${provider}, got ${JSON.stringify(db)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
