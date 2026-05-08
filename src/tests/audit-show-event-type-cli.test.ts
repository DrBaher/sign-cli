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

test("sign audit show --event-type filters to a single event type", { concurrency: false }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-show-event-type-"));
  const dbPath = path.join(dir, "sign.db");
  const docPath = path.join(dir, "doc.txt");
  writeFileSync(docPath, "alpha");
  try {
    const created = runCli([
      "request", "create",
      "--title", "EventType",
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
    assert.equal(created.status, 0);
    const requestId = JSON.parse(created.stdout).requestId;

    // No filter: at least one event for this request_id.
    const all = runCli(["audit", "show", "--request-id", requestId], { SIGN_DB_PATH: dbPath });
    const allEvents = JSON.parse(all.stdout) as Array<{ event_type: string }>;
    assert.ok(allEvents.length >= 1);

    // Filter: only request.created — every row matches.
    const filtered = runCli([
      "audit", "show",
      "--request-id", requestId,
      "--event-type", "request.created",
    ], { SIGN_DB_PATH: dbPath });
    const filteredEvents = JSON.parse(filtered.stdout) as Array<{ event_type: string }>;
    for (const event of filteredEvents) {
      assert.equal(event.event_type, "request.created");
    }
    assert.ok(filteredEvents.length >= 1);
    assert.ok(filteredEvents.length <= allEvents.length);

    // Filter: a non-matching type — empty array.
    const empty = runCli([
      "audit", "show",
      "--request-id", requestId,
      "--event-type", "request.no.such.type",
    ], { SIGN_DB_PATH: dbPath });
    assert.deepEqual(JSON.parse(empty.stdout), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign audit show --event-type accepts multiple types (repeated flag)", { concurrency: false }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-show-event-type-many-"));
  const dbPath = path.join(dir, "sign.db");
  const docPath = path.join(dir, "doc.txt");
  writeFileSync(docPath, "alpha");
  try {
    const created = runCli([
      "request", "create",
      "--title", "Many",
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

    const all = JSON.parse(runCli(["audit", "show", "--request-id", requestId], { SIGN_DB_PATH: dbPath }).stdout) as Array<{ event_type: string }>;
    const distinctTypes = [...new Set(all.map((e) => e.event_type))];
    if (distinctTypes.length < 2) return; // skip if only one event_type for a fresh request

    const filtered = runCli([
      "audit", "show",
      "--request-id", requestId,
      "--event-type", distinctTypes[0],
      "--event-type", distinctTypes[1],
    ], { SIGN_DB_PATH: dbPath });
    const events = JSON.parse(filtered.stdout) as Array<{ event_type: string }>;
    const allow = new Set([distinctTypes[0], distinctTypes[1]]);
    for (const event of events) {
      assert.ok(allow.has(event.event_type));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
