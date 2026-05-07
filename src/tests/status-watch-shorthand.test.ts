import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// End-to-end shorthand check: `sign request status --watch true` should hit
// the same exit-code contract as `sign request watch`. We exercise the
// already-built dist/cli.js as a subprocess so the parser dispatch is real.

function withScopedEnv(envOverrides: Record<string, string | undefined>, fn: () => void): void {
  const originals: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(envOverrides)) {
    originals.push([key, process.env[key]]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("`request status --watch true` reuses the request-watch code path (exit code 0 on completion)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-watch-shorthand-"));
  const dbPath = path.join(dir, "sign.db");
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  const cliPath = path.resolve("dist", "cli.js");
  const env = {
    ...process.env,
    SIGN_DB_PATH: dbPath,
    SIGN_LOCAL_STORE_DIR: path.join(dir, "store"),
    SIGN_LOCAL_KEY_DIR: path.join(dir, "keys"),
    SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    // Default autocomplete=true so the watch terminates after the first poll.
    SIGN_LOCAL_AUTOCOMPLETE: "true",
  };
  try {
    const createOut = execFileSync(
      process.execPath,
      [
        cliPath, "request", "create",
        "--title", "Watch shorthand",
        "--document", documentPath,
        "--signer", "name:Alice,email:alice@example.com,order:1",
        "--provider", "local",
        "--auto-approve", "true",
      ],
      { env, encoding: "utf8" },
    );
    const created = JSON.parse(createOut);
    execFileSync(
      process.execPath,
      [cliPath, "request", "send", "--request-id", created.requestId, "--provider", "local"],
      { env, encoding: "utf8" },
    );

    // Run the shorthand. Should exit 0 (terminal=completed).
    const watchOut = execFileSync(
      process.execPath,
      [
        cliPath, "request", "status",
        "--request-id", created.requestId,
        "--provider", "local",
        "--watch", "true",
        "--interval-ms", "5",
        "--timeout-ms", "1000",
      ],
      { env, encoding: "utf8" },
    );
    const watchResult = JSON.parse(watchOut);
    assert.equal(watchResult.terminal, "completed");
    assert.equal(watchResult.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`request status` (no --watch) still does a one-shot poll", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-watch-oneshot-"));
  const dbPath = path.join(dir, "sign.db");
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  const cliPath = path.resolve("dist", "cli.js");
  const env = {
    ...process.env,
    SIGN_DB_PATH: dbPath,
    SIGN_LOCAL_STORE_DIR: path.join(dir, "store"),
    SIGN_LOCAL_KEY_DIR: path.join(dir, "keys"),
    SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    SIGN_LOCAL_AUTOCOMPLETE: "false",
  };
  try {
    const createOut = execFileSync(
      process.execPath,
      [
        cliPath, "request", "create",
        "--title", "One-shot status",
        "--document", documentPath,
        "--signer", "name:Alice,email:alice@example.com,order:1",
        "--provider", "local",
        "--auto-approve", "true",
      ],
      { env, encoding: "utf8" },
    );
    const created = JSON.parse(createOut);
    execFileSync(
      process.execPath,
      [cliPath, "request", "send", "--request-id", created.requestId, "--provider", "local"],
      { env, encoding: "utf8" },
    );

    // No --watch → one poll, returns the snapshot, exits 0 immediately.
    const statusOut = execFileSync(
      process.execPath,
      [cliPath, "request", "status", "--request-id", created.requestId, "--provider", "local"],
      { env, encoding: "utf8" },
    );
    const status = JSON.parse(statusOut);
    // The one-shot shape is { request, remoteStatus } — no terminal/exitCode.
    assert.equal(status.terminal, undefined);
    assert.ok(status.request);
    assert.equal(status.request.id, created.requestId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pacify the unused-variable check in strict modes.
void withScopedEnv;
