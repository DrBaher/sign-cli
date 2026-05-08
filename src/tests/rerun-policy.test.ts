import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, rerunPolicyForRequest } from "../lib/signing-service.js";
import type { PolicySpec } from "../lib/policy-engine.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

const SPEC: PolicySpec = {
  rules: [
    { match: { titlePattern: "^NDA " }, action: "sign" },
    { match: { signerEmail: "blocked@example.com" }, action: "decline", reason: "blocked address" },
    { match: "any", action: "report" },
  ],
};

test("rerunPolicyForRequest pulls title + document_hash from the DB and decides accordingly", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("rerun-policy");
  try {
    const created = createSigningRequest(db, {
      title: "NDA Acme",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const result = rerunPolicyForRequest(db, { requestId: created.requestId, spec: SPEC });
    assert.equal(result.requestId, created.requestId);
    assert.equal(result.ctx.title, "NDA Acme");
    assert.equal(result.ctx.signerEmail, "alice@example.com");
    assert.equal(result.decision.action, "sign");
  } finally {
    db.close();
    cleanup();
  }
});

test("rerunPolicyForRequest --signer-email override flips a context-specific decision", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("rerun-policy-override");
  try {
    const created = createSigningRequest(db, {
      title: "Generic Agreement",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    // Default signer (alice) → falls through to "report" rule.
    const def = rerunPolicyForRequest(db, { requestId: created.requestId, spec: SPEC });
    assert.equal(def.decision.action, "report");
    // Override to blocked@example.com → matches the decline rule.
    const overridden = rerunPolicyForRequest(db, {
      requestId: created.requestId,
      spec: SPEC,
      signerEmail: "blocked@example.com",
    });
    assert.equal(overridden.decision.action, "decline");
    assert.equal(overridden.decision.reason, "blocked address");
  } finally {
    db.close();
    cleanup();
  }
});

test("rerunPolicyForRequest does not mutate request state — running it twice yields identical output", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("rerun-policy-pure");
  try {
    const created = createSigningRequest(db, {
      title: "Stable",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const a = rerunPolicyForRequest(db, { requestId: created.requestId, spec: SPEC });
    const b = rerunPolicyForRequest(db, { requestId: created.requestId, spec: SPEC });
    assert.deepEqual(a, b);
  } finally {
    db.close();
    cleanup();
  }
});
