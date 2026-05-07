import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractDocuSignSigners,
  getDocuSignEnvelopeSummary,
  parseDocuSignWebhookBody,
  verifyDocuSignCallback,
} from "../lib/docusign-webhook.js";
import {
  createSigningRequest,
  ingestDocuSignWebhookPayload,
  getRequestSnapshot,
  listSignerSigningStates,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

test("verifyDocuSignCallback accepts both base64 and hex HMAC headers", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ hello: "world" });
  const expected = createHmac("sha256", secret).update(body).digest();
  assert.equal(verifyDocuSignCallback(secret, body, expected.toString("base64")), true);
  assert.equal(verifyDocuSignCallback(secret, body, expected.toString("hex")), true);
  assert.equal(verifyDocuSignCallback(secret, body, ["bogus", expected.toString("base64")]), true);
  assert.equal(verifyDocuSignCallback(secret, body, "wrong-sig"), false);
  assert.equal(verifyDocuSignCallback(secret, body, null), false);
});

test("parseDocuSignWebhookBody parses JSON content-types and rejects others", () => {
  const payload = parseDocuSignWebhookBody('{"event":"envelope-completed"}');
  assert.equal(payload.event, "envelope-completed");
  const parsedJson = parseDocuSignWebhookBody('{"event":"x"}', "application/json; charset=utf-8");
  assert.equal(parsedJson.event, "x");
  assert.throws(
    () => parseDocuSignWebhookBody("<xml/>", "application/xml"),
    /Unsupported DocuSign callback content-type/,
  );
});

test("extractDocuSignSigners + getDocuSignEnvelopeSummary read the canonical Connect 2.x shape", () => {
  const payload = {
    event: "envelope-completed",
    data: {
      envelopeId: "env-1",
      envelopeSummary: {
        envelopeId: "env-1",
        status: "completed",
        envelopeMetadata: { request_id: "req_123" },
        recipients: {
          signers: [
            { email: "alice@example.com", name: "Alice", status: "completed", signedDateTime: "2026-05-01T10:00:00Z" },
            { email: "bob@example.com", name: "Bob", status: "sent", signedDateTime: null },
          ],
        },
      },
    },
  };
  const summary = getDocuSignEnvelopeSummary(payload);
  assert.equal(summary.envelopeId, "env-1");
  assert.equal(summary.status, "completed");
  assert.equal(summary.metadataRequestId, "req_123");
  const signers = extractDocuSignSigners(payload);
  assert.equal(signers.length, 2);
  assert.equal(signers[0].email, "alice@example.com");
});

test("ingestDocuSignWebhookPayload writes signer_signing_states for verified signers with signedDateTime", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-docusign-flow-"));
  const documentPath = makeFixturePdf(dir);
  try {
    const created = createSigningRequest(db, {
      title: "DocuSign parity",
      documentPath,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "docusign",
      autoApprove: true,
    });
    db.prepare("UPDATE requests SET status = ?, provider_request_id = ? WHERE id = ?")
      .run("sent", "env-xyz", created.requestId);

    const secret = "ds-secret-12345";
    const payload = {
      event: "envelope-completed",
      data: {
        envelopeId: "env-xyz",
        envelopeSummary: {
          envelopeId: "env-xyz",
          status: "completed",
          envelopeMetadata: { request_id: created.requestId },
          recipients: {
            signers: [
              { email: "alice@example.com", name: "Alice", status: "completed", signedDateTime: "2026-05-01T10:00:00Z" },
              { email: "bob@example.com", name: "Bob", status: "sent", signedDateTime: null },
            ],
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("base64");

    const result = ingestDocuSignWebhookPayload(db, {
      payload,
      secret,
      rawBody,
      signatureHeader: sig,
    });
    assert.equal(result.verified, true);
    assert.equal(result.requestId, created.requestId);

    const states = listSignerSigningStates(db, created.requestId);
    assert.equal(states.length, 1, "only Alice should land — Bob has signedDateTime=null");
    assert.equal(states[0].email, "alice@example.com");
    assert.equal(states[0].source, "docusign");

    const snap = getRequestSnapshot(db, created.requestId);
    assert.equal(snap.signedBy?.[0].email, "alice@example.com");
    assert.equal(snap.signedBy?.[0].source, "docusign");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("ingestDocuSignWebhookPayload rejects a wrong HMAC signature (verified=false, no state writes)", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-docusign-bad-"));
  const documentPath = makeFixturePdf(dir);
  try {
    const created = createSigningRequest(db, {
      title: "DocuSign HMAC reject",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "docusign",
      autoApprove: true,
    });
    const payload = {
      event: "envelope-completed",
      data: {
        envelopeSummary: {
          envelopeId: "env-1",
          status: "completed",
          envelopeMetadata: { request_id: created.requestId },
          recipients: { signers: [{ email: "alice@example.com", name: "Alice", signedDateTime: "2026-05-01T10:00:00Z" }] },
        },
      },
    };
    const result = ingestDocuSignWebhookPayload(db, {
      payload,
      secret: "right-secret",
      rawBody: JSON.stringify(payload),
      signatureHeader: "wrong-sig",
    });
    assert.equal(result.verified, false);
    const states = listSignerSigningStates(db, created.requestId);
    assert.equal(states.length, 0, "unverified webhooks must not write state rows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});
