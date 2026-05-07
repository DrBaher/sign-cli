import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  ingestDocuSignWebhookPayload,
  ingestSignWellWebhookPayload,
  ingestWebhookPayload,
  listAuditEvents,
  listSignerSigningStates,
} from "../lib/signing-service.js";
import { hmacSha256 } from "../lib/util.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

test("Dropbox webhook replay: second ingestion is rejected with replayed=true and no extra state writes", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("dropbox-replay");
  try {
    const created = createSigningRequest(db, {
      title: "Dropbox replay",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "dropbox",
      autoApprove: true,
    });
    const apiKey = "dropbox-key-aaa-bbb";
    const eventTime = "1730000000";
    const eventType = "signature_request_signed";
    const eventHash = createHmac("sha256", apiKey).update(`${eventTime}${eventType}`).digest("hex");
    const payload = {
      event: { event_time: eventTime, event_type: eventType, event_hash: eventHash },
      signature_request: {
        signature_request_id: "drop_replay_1",
        metadata: { request_id: created.requestId },
        signatures: [
          { signer_email_address: "alice@example.com", signer_name: "Alice", signed_at: 1730000010 },
        ],
      },
    } as any;

    const first = ingestWebhookPayload(db, { payload, apiKey });
    assert.equal(first.verified, true);
    assert.equal(first.replayed, false);
    const beforeReplay = listSignerSigningStates(db, created.requestId);
    assert.equal(beforeReplay.length, 1);

    const second = ingestWebhookPayload(db, { payload, apiKey });
    assert.equal(second.verified, true);
    assert.equal(second.replayed, true);
    const afterReplay = listSignerSigningStates(db, created.requestId);
    assert.equal(afterReplay.length, 1, "replay must not duplicate state rows");

    const events = listAuditEvents(db, created.requestId);
    assert.ok(events.some((e) => e.event_type.endsWith(".replay")), "replay must record an audit event");
  } finally {
    db.close();
    cleanup();
  }
});

test("SignWell webhook replay: dedupes via event.hash", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("signwell-replay");
  const secret = "sw-replay-secret";
  try {
    const created = createSigningRequest(db, {
      title: "SignWell replay",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "signwell",
      autoApprove: true,
    });
    const eventType = "document_completed";
    const eventTime = 1730000000;
    const payload: any = {
      event: { type: eventType, time: eventTime, hash: hmacSha256(secret, `${eventTime}${eventType}`) },
      data: {
        object: {
          id: "sw_replay",
          status: "Completed",
          metadata: { request_id: created.requestId },
          recipients: [{ id: "1", signed_at: "2026-05-01T10:00:00Z" }],
        },
      },
    };
    const first = ingestSignWellWebhookPayload(db, { payload, secret });
    assert.equal(first.replayed, false);
    const second = ingestSignWellWebhookPayload(db, { payload, secret });
    assert.equal(second.replayed, true);
  } finally {
    db.close();
    cleanup();
  }
});

test("DocuSign webhook replay: dedupes via raw-body hash", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-ds-replay-"));
  const documentPath = makeFixturePdf(dir);
  const secret = "ds-replay-secret";
  try {
    const created = createSigningRequest(db, {
      title: "DocuSign replay",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "docusign",
      autoApprove: true,
    });
    const payload = {
      event: "envelope-completed",
      data: {
        envelopeSummary: {
          envelopeId: "env-replay",
          status: "completed",
          envelopeMetadata: { request_id: created.requestId },
          recipients: { signers: [{ email: "alice@example.com", name: "Alice", signedDateTime: "2026-05-01T10:00:00Z" }] },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("base64");

    const first = ingestDocuSignWebhookPayload(db, { payload, secret, rawBody, signatureHeader: sig });
    assert.equal(first.replayed, false);
    const second = ingestDocuSignWebhookPayload(db, { payload, secret, rawBody, signatureHeader: sig });
    assert.equal(second.replayed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("Replay protection only kicks in on verified payloads (unverified replays still recorded as failures)", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("replay-unverified");
  try {
    const created = createSigningRequest(db, {
      title: "Replay unverified",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "dropbox",
      autoApprove: true,
    });
    const apiKey = "real-key";
    const payload = {
      event: { event_time: "1730000000", event_type: "x", event_hash: "wrong-hash" },
      signature_request: { signature_request_id: "drop_x", metadata: { request_id: created.requestId } },
    } as any;
    const first = ingestWebhookPayload(db, { payload, apiKey });
    assert.equal(first.verified, false);
    assert.equal(first.replayed, false);
    const second = ingestWebhookPayload(db, { payload, apiKey });
    // Unverified payloads don't claim a dedupe slot, so the second still surfaces as not-a-replay.
    assert.equal(second.verified, false);
    assert.equal(second.replayed, false);
  } finally {
    db.close();
    cleanup();
  }
});
