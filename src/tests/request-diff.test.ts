import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffRequests } from "../lib/request-diff.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function makeFixturePdf(dir: string, content: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from(content, "latin1"));
  return documentPath;
}

test("diffRequests returns identical:true for two requests with the same shape", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-req-diff-same-"));
  const docA = makeFixturePdf(dir, "%PDF-1.4\n%same\n%%EOF");
  try {
    const a = createSigningRequest(db, {
      title: "Mutual NDA",
      documentPath: docA,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    const b = createSigningRequest(db, {
      title: "Mutual NDA",
      documentPath: docA,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    const result = diffRequests(db, a.requestId, b.requestId);
    assert.equal(result.identical, true);
    assert.equal(result.fieldDiffs.length, 0);
    assert.equal(result.signerDiff.added.length, 0);
    assert.equal(result.signerDiff.removed.length, 0);
    assert.equal(result.documentChanged, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("diffRequests detects title + signer + document changes", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-req-diff-changes-"));
  const docA = path.join(dir, "a.pdf");
  const docB = path.join(dir, "b.pdf");
  writeFileSync(docA, Buffer.from("%PDF-1.4\n%aaa\n%%EOF", "latin1"));
  writeFileSync(docB, Buffer.from("%PDF-1.4\n%bbb (different content)\n%%EOF", "latin1"));
  try {
    const before = createSigningRequest(db, {
      title: "NDA round 1",
      documentPath: docA,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    const after = createSigningRequest(db, {
      title: "NDA round 2",
      documentPath: docB,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Carol", email: "carol@example.com", order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    const result = diffRequests(db, before.requestId, after.requestId);
    assert.equal(result.identical, false);
    assert.ok(result.fieldDiffs.find((d) => d.field === "title"));
    assert.equal(result.signerDiff.removed.find((s) => s.email === "bob@example.com")?.email, "bob@example.com");
    assert.equal(result.signerDiff.added.find((s) => s.email === "carol@example.com")?.email, "carol@example.com");
    assert.equal(result.signerDiff.same.find((s) => s.email === "alice@example.com")?.email, "alice@example.com");
    assert.equal(result.documentChanged, true);
    assert.notEqual(result.documentSha256.before, result.documentSha256.after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("diffRequests reports documentChanged=false when only signers change", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-req-diff-signer-only-"));
  const documentPath = makeFixturePdf(dir, "%PDF-1.4\n%constant\n%%EOF");
  try {
    const before = createSigningRequest(db, {
      title: "Same doc",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    const after = createSigningRequest(db, {
      title: "Same doc",
      documentPath,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    const result = diffRequests(db, before.requestId, after.requestId);
    assert.equal(result.documentChanged, false);
    assert.equal(result.signerDiff.added.length, 1);
    assert.equal(result.identical, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});
