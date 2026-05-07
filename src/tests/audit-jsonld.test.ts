import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderAuditChainAsJsonLd } from "../lib/audit-jsonld.js";
import {
  createSigningRequest,
  exportAuditChainAsJsonLd,
  listAuditEvents,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-jsonld-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

test("renderAuditChainAsJsonLd produces a JSON-LD document with stable @context + URN @ids", () => {
  const out = renderAuditChainAsJsonLd({
    request: { id: "req_abc", title: "NDA", status: "completed", provider: "local", documentSha256: "abc" },
    signers: [{ email: "alice@example.com", name: "Alice", order: 1 }],
    signedBy: [{ email: "alice@example.com", name: "Alice", signedAt: "2026-05-07T12:00:00Z" }],
    events: [
      { id: 1, event_type: "request.created", payload_json: '{"title":"NDA"}', hash_prev: null, hash_self: "h1", created_at: "2026-05-07T11:00:00Z" },
      { id: 2, event_type: "request.signed_by_signer", payload_json: '{"signerEmail":"alice@example.com"}', hash_prev: "h1", hash_self: "h2", created_at: "2026-05-07T12:00:00Z" },
    ],
  });
  assert.equal(out["@type"], "Request");
  assert.equal(out["@id"], "urn:sign-cli:request:req_abc");
  assert.ok(out["@context"]);
  assert.equal(out.events.length, 2);
  assert.equal(out.events[0]["@type"], "ProvChainEvent");
  assert.equal(out.events[0]["@id"], "urn:sign-cli:event:req_abc:1");
  assert.equal(out.events[1].hashPrev, "h1");
  assert.equal(out.signers[0]["@type"], "Signer");
  assert.ok(out.signedBy);
  assert.equal(out.signedBy?.[0].email, "alice@example.com");
});

test("exportAuditChainAsJsonLd writes a valid JSON file and records audit.exported_jsonld", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-jsonld-flow-"));
    const documentPath = makeFixturePdf(dir);
    const outPath = path.join(dir, "audit.jsonld");
    try {
      const created = createSigningRequest(db, {
        title: "JSON-LD test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });

      const result = await exportAuditChainAsJsonLd(db, { requestId: created.requestId, outPath });
      assert.equal(result.outPath, outPath);
      assert.ok(result.bytes > 0);

      const written = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(written["@type"], "Request");
      assert.equal(written.requestId, created.requestId);
      assert.ok(Array.isArray(written.events));
      assert.equal(typeof written.generatedAt, "string");

      const events = listAuditEvents(db, created.requestId);
      assert.ok(events.some((e) => e.event_type === "audit.exported_jsonld"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("renderAuditChainAsJsonLd handles malformed payload_json by returning the raw string", () => {
  const out = renderAuditChainAsJsonLd({
    request: { id: "req_x", title: "x", status: "x", provider: null, documentSha256: null },
    signers: [],
    signedBy: null,
    events: [
      { id: 99, event_type: "weird", payload_json: "not-json", hash_prev: null, hash_self: "h", created_at: "2026-01-01T00:00:00Z" },
    ],
  });
  assert.equal(out.events[0].payload, "not-json");
});
