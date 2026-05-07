import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVerify, X509Certificate } from "node:crypto";
import {
  applyRequestSpecTemplate,
  loadRequestSpec,
} from "../lib/request-spec.js";
import { SignCliError } from "../lib/sign-error.js";
import {
  createSigningRequest,
  exportRequestReceipt,
  listAuditEvents,
  sendSigningRequest,
  signSigningRequest,
  watchSigningRequestStatus,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousKeys = process.env.SIGN_LOCAL_KEY_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_KEY_DIR = path.join(dir, "keys");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousKeys === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previousKeys;
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

test("applyRequestSpecTemplate substitutes {{key}} placeholders and errors on missing params", () => {
  const out = applyRequestSpecTemplate('{"title":"NDA for {{counterparty}}","email":"{{counterparty}}"}', {
    counterparty: "alice@example.com",
  });
  assert.match(out, /alice@example.com/);
  assert.doesNotMatch(out, /\{\{/);

  assert.throws(
    () => applyRequestSpecTemplate('{"title":"{{missing}}"}', {}),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
});

test("loadRequestSpec applies --param substitutions before parsing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-spec-template-"));
  const specPath = path.join(dir, "tpl.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      title: "NDA for {{name}}",
      documentPath: "./doc.pdf",
      signers: [{ name: "{{name}}", email: "{{email}}", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    }),
  );
  try {
    const spec = loadRequestSpec(specPath, { name: "Alice", email: "alice@example.com" });
    assert.equal(spec.title, "NDA for Alice");
    assert.equal(spec.signers[0].name, "Alice");
    assert.equal(spec.signers[0].email, "alice@example.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportRequestReceipt writes manifest.sig + manifest.cert.pem and the signature verifies", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-flow-"));
    const documentPath = makeFixturePdf(dir);
    const outDir = path.join(dir, "receipt-out");
    try {
      // Build a completed request so the bundle includes signed.pdf.
      const created = createSigningRequest(db, {
        title: "Receipt test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens[0].token;
      signSigningRequest(db, { requestId: created.requestId, token: aliceToken });
      // Watch with finalPdf so the bundle has signed.pdf.
      await watchSigningRequestStatus(db, {
        requestId: created.requestId,
        provider: "local",
        intervalMs: 5,
        timeoutMs: 1000,
        fetchFinalPdf: true,
        outPath: path.join(dir, "signed.pdf"),
      });

      const receipt = await exportRequestReceipt(db, { requestId: created.requestId, outDir });
      assert.ok(existsSync(receipt.signaturePath));
      assert.ok(existsSync(receipt.certPath));
      assert.equal(typeof receipt.manifestSha256, "string");
      assert.ok(receipt.signatureBytes > 0);

      // Verify signature against manifest.json bytes.
      const manifestBytes = readFileSync(receipt.manifestPath);
      const sig = readFileSync(receipt.signaturePath);
      const certPem = readFileSync(receipt.certPath, "utf8");
      const cert = new X509Certificate(certPem);
      const verify = createVerify("RSA-SHA256");
      verify.update(manifestBytes);
      assert.equal(verify.verify(cert.publicKey, sig), true, "manifest signature must verify against the embedded cert");

      const events = listAuditEvents(db, created.requestId);
      assert.ok(events.some((e) => e.event_type === "request.receipt_signed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("exportRequestReceipt detects tampered manifest (signature no longer verifies)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-tamper-"));
    const documentPath = makeFixturePdf(dir);
    const outDir = path.join(dir, "receipt-out");
    try {
      const created = createSigningRequest(db, {
        title: "Tamper test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
      const receipt = await exportRequestReceipt(db, { requestId: created.requestId, outDir });

      const original = readFileSync(receipt.manifestPath);
      const tampered = Buffer.concat([original, Buffer.from(" /* tampered */", "utf8")]);
      writeFileSync(receipt.manifestPath, tampered);
      const sig = readFileSync(receipt.signaturePath);
      const certPem = readFileSync(receipt.certPath, "utf8");
      const cert = new X509Certificate(certPem);
      const verify = createVerify("RSA-SHA256");
      verify.update(tampered);
      assert.equal(
        verify.verify(cert.publicKey, sig),
        false,
        "tampered manifest must fail verification",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
