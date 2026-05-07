import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningRequest,
  getRequestSnapshot,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

test("createSigningRequest stores template id + prefills and skips document upload", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const created = createSigningRequest(db, {
      title: "NDA",
      templateId: "tmpl_abc",
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1, role: "Buyer" },
      ],
      prefills: [{ name: "purchase_price", value: "1000" }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(created.templateId, "tmpl_abc");
    assert.equal(created.documents.length, 0);

    const snap = getRequestSnapshot(db, created.requestId);
    assert.equal(snap.request.template_id, "tmpl_abc");
    assert.equal(snap.request.documents.length, 0);
    assert.equal(snap.request.prefills.length, 1);
    assert.equal(snap.request.prefills[0].name, "purchase_price");
  } finally {
    db.close();
    cleanup();
  }
});

test("createSigningRequest rejects template requests without role on every signer", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    assert.throws(() => createSigningRequest(db, {
      title: "NDA",
      templateId: "tmpl_abc",
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
    }), /need role:<name>/);
  } finally {
    db.close();
    cleanup();
  }
});

test("createSigningRequest forbids combining --template-id and --document", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    assert.throws(() => createSigningRequest(db, {
      title: "NDA",
      templateId: "tmpl_abc",
      documentPath: "/tmp/does-not-exist.pdf",
      signers: [{ name: "Alice", email: "alice@example.com", order: 1, role: "Buyer" }],
      tokenTtlMinutes: 30,
    }), /cannot be combined/);
  } finally {
    db.close();
    cleanup();
  }
});

test("Dropbox template send hits send_with_template with template_id and signer roles", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const originalFetch = globalThis.fetch;
  try {
    const created = createSigningRequest(db, {
      title: "Dropbox template",
      templateId: "tmpl_dbx",
      signers: [{ name: "Alice", email: "alice@example.com", order: 1, role: "Signer" }],
      prefills: [{ name: "amount", value: "42" }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
    });

    let calledUrl: string | null = null;
    let formSnapshot: Record<string, string> | null = null;
    globalThis.fetch = (async (url: string, init?: any) => {
      calledUrl = String(url);
      const formData = init?.body as FormData;
      formSnapshot = {};
      formData.forEach((value, key) => { formSnapshot![key] = String(value); });
      return new Response(JSON.stringify({
        signature_request: {
          signature_request_id: "sigreq_tmpl",
          signatures: [{ signature_id: "sig_1" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }) as any;
    }) as any;

    const sent = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
    });

    assert.match(calledUrl ?? "", /signature_request\/send_with_template/);
    assert.equal(formSnapshot!.template_id, "tmpl_dbx");
    assert.equal(formSnapshot!["signers[0][role]"], "Signer");
    assert.equal(formSnapshot!["signers[0][email_address]"], "alice@example.com");
    assert.equal(formSnapshot!["custom_fields[0][name]"], "amount");
    assert.equal(formSnapshot!["custom_fields[0][value]"], "42");
    assert.equal(sent.signatureRequestId, "sigreq_tmpl");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});

test("SignWell template send posts to /document_templates/documents with role-keyed recipients", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const originalFetch = globalThis.fetch;
  try {
    const created = createSigningRequest(db, {
      title: "SignWell template",
      templateId: "tmpl_sw",
      signers: [{ name: "Alice", email: "alice@example.com", order: 1, role: "Buyer" }],
      prefills: [{ name: "purchase_price", value: "1000" }],
      tokenTtlMinutes: 30,
      provider: "signwell",
      autoApprove: true,
    });

    let calledUrl: string | null = null;
    let body: any = null;
    globalThis.fetch = (async (url: string, init?: any) => {
      calledUrl = String(url);
      body = init?.body ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({
        id: "doc_tmpl",
        status: "Sent",
        recipients: [{ id: "1" }],
      }), { status: 200, headers: { "content-type": "application/json" } }) as any;
    }) as any;

    const sent = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "signwell",
      apiKey: "k",
      testMode: true,
    });

    assert.match(calledUrl ?? "", /\/document_templates\/documents$/);
    assert.deepEqual(body.template_ids, ["tmpl_sw"]);
    assert.deepEqual(body.recipients, { Buyer: { name: "Alice", email: "alice@example.com" } });
    assert.deepEqual(body.placeholders, { purchase_price: "1000" });
    assert.equal(sent.signatureRequestId, "doc_tmpl");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});
