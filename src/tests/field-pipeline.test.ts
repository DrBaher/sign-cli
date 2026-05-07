import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningRequest,
  getRequestSnapshot,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { parseFieldSpec } from "../lib/field-placement.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("createSigningRequest persists fields in fields_json", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("fields-store");
  try {
    const fields = [parseFieldSpec("signer:1,page:1,x:100,y:120,type:signature")];
    const created = createSigningRequest(db, {
      title: "Fields",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      fields,
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date(),
    });
    const snapshot = getRequestSnapshot(db, created.requestId);
    assert.equal(snapshot.request.fields.length, 1);
    assert.equal(snapshot.request.fields[0].x, 100);
  } finally {
    db.close();
    cleanup();
  }
});

test("createSigningRequest rejects fields that reference unknown signer or out-of-range doc", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("fields-validate");
  try {
    assert.throws(() => createSigningRequest(db, {
      title: "Bad signer",
      documentPath,
      signers: [{ name: "A", email: "a@b.com", order: 1 }],
      fields: [parseFieldSpec("signer:9,page:1,x:1,y:1")],
      tokenTtlMinutes: 30,
    }), /no --signer with that order/);

    assert.throws(() => createSigningRequest(db, {
      title: "Bad doc",
      documentPath,
      signers: [{ name: "A", email: "a@b.com", order: 1 }],
      fields: [parseFieldSpec("signer:1,doc:5,page:1,x:1,y:1")],
      tokenTtlMinutes: 30,
    }), /out of range/);
  } finally {
    db.close();
    cleanup();
  }
});

test("Dropbox send forwards form_fields_per_document JSON when fields are present", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("dropbox-fields");
  const originalFetch = globalThis.fetch;
  try {
    const created = createSigningRequest(db, {
      title: "Dropbox fields",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      fields: [parseFieldSpec("signer:1,page:1,x:50,y:60,type:signature,width:200,height:30")],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    let capturedFormFields: any = null;
    globalThis.fetch = (async (_url: string, init?: any) => {
      const formData = init?.body as FormData;
      const value = formData?.get?.("form_fields_per_document");
      capturedFormFields = typeof value === "string" ? JSON.parse(value) : null;
      return new Response(JSON.stringify({
        signature_request: {
          signature_request_id: "sigreq_x",
          signatures: [{ signature_id: "sig_1" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }) as any;
    }) as any;

    await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
    });

    assert.ok(capturedFormFields, "form_fields_per_document should be set when fields are provided");
    assert.equal(capturedFormFields.length, 1);
    assert.equal(capturedFormFields[0].length, 1);
    assert.equal(capturedFormFields[0][0].signer, 0);
    assert.equal(capturedFormFields[0][0].type, "signature");
    assert.equal(capturedFormFields[0][0].x, 50);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});
