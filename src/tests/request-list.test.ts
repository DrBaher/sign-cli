import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, listSigningRequests } from "../lib/signing-service.js";
import { renderRequestsTable } from "../lib/request-table.js";
import { SignCliError } from "../lib/sign-error.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("listSigningRequests returns rows with provider/signer counts and supports filters", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("list");
  try {
    createSigningRequest(db, {
      title: "Dropbox A",
      documentPath,
      signers: [
        { name: "A", email: "a@x.com", order: 1 },
        { name: "B", email: "b@x.com", order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    createSigningRequest(db, {
      title: "SignWell A",
      documentPath,
      signers: [{ name: "C", email: "c@x.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "signwell",
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    const all = listSigningRequests(db);
    assert.equal(all.length, 2);
    assert.equal(all[0].title, "SignWell A");
    assert.equal(all[0].signers, 1);
    assert.equal(all[1].signers, 2);

    const onlyDropbox = listSigningRequests(db, { provider: "dropbox" });
    assert.equal(onlyDropbox.length, 1);
    assert.equal(onlyDropbox[0].provider, "dropbox");

    const limited = listSigningRequests(db, { limit: 1 });
    assert.equal(limited.length, 1);
  } finally {
    db.close();
    cleanup();
  }
});

test("listSigningRequests --since filters out rows created before the cutoff", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("since");
  try {
    const old = createSigningRequest(db, {
      title: "Old", documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const fresh = createSigningRequest(db, {
      title: "Fresh", documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    const rows = listSigningRequests(db, { since: "2026-04-01T00:00:00Z" });
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(fresh.requestId), "fresh row should be present");
    assert.ok(!ids.includes(old.requestId), "old row should be filtered out");
  } finally {
    db.close();
    cleanup();
  }
});

test("listSigningRequests rejects --since values that don't parse as a timestamp", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    assert.throws(
      () => listSigningRequests(db, { since: "yesterday" }),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("renderRequestsTable lays out columns and reports an empty body", () => {
  const empty = renderRequestsTable([]);
  assert.match(empty, /^ID/);
  assert.match(empty, /\(no rows\)/);

  const rendered = renderRequestsTable([
    { id: "req-1", title: "Test", status: "completed", provider: "local", signers: 2, createdAt: "2026-05-01T12:00:00Z" },
  ]);
  const lines = rendered.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ID\s+TITLE\s+STATUS\s+PROVIDER\s+SIGNERS\s+CREATED/);
  assert.match(lines[1], /req-1\s+Test\s+completed\s+local\s+2\s+2026-05-01T12:00:00Z/);
});

test("renderRequestsTable truncates long values and renders null provider as em-dash", () => {
  const rendered = renderRequestsTable([
    {
      id: "req-with-a-very-long-identifier-string-here-and-more",
      title: "A very long title that should be truncated to fit the column width",
      status: "sent",
      provider: null,
      signers: 999,
      createdAt: "2026-05-01T00:00:00Z",
    },
  ]);
  assert.match(rendered, /…/);
  assert.match(rendered, /—/);
});
