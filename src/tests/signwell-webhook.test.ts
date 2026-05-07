import test from "node:test";
import assert from "node:assert/strict";
import { hmacSha256 } from "../lib/util.js";
import {
  extractSignWellRecipientIds,
  getSignWellWebhookDocument,
  normalizeSignWellEventType,
  parseSignWellWebhookBody,
  verifySignWellCallback,
} from "../lib/signwell-webhook.js";
import { createSigningRequest, getRequestSnapshot, ingestSignWellWebhookPayload } from "../lib/signing-service.js";
import { handleSignWellWebhookHttpRequest } from "../lib/webhook-http.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

const baseDoc = {
  id: "doc_abc",
  status: "Completed",
  recipients: [
    { id: "recipient_1", status: "completed" },
    { id: "recipient_2", status: "completed" },
  ],
};

const basePayload = {
  event: { type: "document_completed", time: 1730000000 },
  data: { object: baseDoc },
};

test("normalizeSignWellEventType maps SignWell event names to taxonomy", () => {
  assert.equal(normalizeSignWellEventType("document_completed"), "completed");
  assert.equal(normalizeSignWellEventType("document_signed"), "signed");
  assert.equal(normalizeSignWellEventType("document_declined"), "declined");
  assert.equal(normalizeSignWellEventType("document_expired"), "declined");
  assert.equal(normalizeSignWellEventType("document_canceled"), "declined");
  assert.equal(normalizeSignWellEventType("document_bounced"), "error");
  assert.equal(normalizeSignWellEventType("document_sent"), "sent");
  assert.equal(normalizeSignWellEventType(undefined), "unknown");
});

test("verifySignWellCallback honors event.hash and signature header", () => {
  const secret = "shh";
  const expected = hmacSha256(secret, `${basePayload.event.time}${basePayload.event.type}`);

  assert.equal(verifySignWellCallback(secret, { ...basePayload, event: { ...basePayload.event, hash: expected } }), true);
  assert.equal(verifySignWellCallback(secret, basePayload, expected), true);
  assert.equal(verifySignWellCallback(secret, basePayload, "wrong"), false);
  assert.equal(verifySignWellCallback(secret, { event: { type: "x" } } as any), false);
});

test("parseSignWellWebhookBody reads JSON bodies", () => {
  const parsed = parseSignWellWebhookBody(JSON.stringify(basePayload), "application/json; charset=utf-8");
  assert.equal(parsed.event?.type, "document_completed");
});

test("getSignWellWebhookDocument prefers data.object then document", () => {
  assert.deepEqual(getSignWellWebhookDocument(basePayload), baseDoc);
  assert.deepEqual(getSignWellWebhookDocument({ document: baseDoc } as any), baseDoc);
  assert.equal(getSignWellWebhookDocument({} as any), null);
});

test("extractSignWellRecipientIds returns ids", () => {
  assert.deepEqual(extractSignWellRecipientIds(baseDoc as any), ["recipient_1", "recipient_2"]);
  assert.deepEqual(extractSignWellRecipientIds(null), []);
});

test("ingestSignWellWebhookPayload updates request when verified", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("sw-webhook");
  const secret = "live-secret";
  try {
    const created = createSigningRequest(db, {
      title: "SignWell webhook test",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "signwell",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const payload = {
      event: {
        type: "document_completed",
        time: 1730000000,
        hash: hmacSha256(secret, "1730000000document_completed"),
      },
      data: {
        object: {
          id: "doc_signed",
          status: "Completed",
          recipients: [{ id: "recipient_1" }],
          metadata: { request_id: created.requestId },
        },
      },
    };

    const result = ingestSignWellWebhookPayload(db, { payload, secret });
    const snapshot = getRequestSnapshot(db, created.requestId);

    assert.equal(result.verified, true);
    assert.equal(result.requestId, created.requestId);
    assert.equal(result.eventType, "document_completed");
    assert.equal(result.normalizedEventType, "completed");
    assert.equal(snapshot.request.provider, "signwell");
    assert.equal(snapshot.request.provider_request_id, "doc_signed");
    assert.equal(snapshot.request.provider_status, "completed");
    assert.deepEqual(snapshot.request.signatureIds, ["recipient_1"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("ingestSignWellWebhookPayload still writes audit on failed signature", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("sw-webhook-bad");
  try {
    const created = createSigningRequest(db, {
      title: "SignWell bad sig",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "signwell",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const payload = {
      event: { type: "document_signed", time: 1730000001, hash: "wrong" },
      data: { object: { id: "doc_x", metadata: { request_id: created.requestId } } },
    };

    const result = ingestSignWellWebhookPayload(db, { payload, secret: "actual-secret" });
    const snapshot = getRequestSnapshot(db, created.requestId);

    assert.equal(result.verified, false);
    assert.equal(snapshot.request.provider_request_id, null);
  } finally {
    db.close();
    cleanup();
  }
});

test("handleSignWellWebhookHttpRequest verifies and ingests live HTTP requests", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("sw-webhook-http");
  const secret = "http-secret";
  try {
    const created = createSigningRequest(db, {
      title: "SignWell HTTP",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "signwell",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const payload = {
      event: {
        type: "document_completed",
        time: 1730000002,
        hash: hmacSha256(secret, "1730000002document_completed"),
      },
      data: {
        object: {
          id: "doc_http",
          status: "Completed",
          recipients: [{ id: "recipient_http" }],
          metadata: { request_id: created.requestId },
        },
      },
    };

    const requestBody = JSON.stringify(payload);
    const incomingRequest = {
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(requestBody);
      },
    };

    const headers = new Map<string, string>();
    let body = "";
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      end(chunk?: string) {
        body = chunk ?? "";
      },
    };

    await handleSignWellWebhookHttpRequest(incomingRequest as any, response as any, {
      dbPath,
      apiKey: secret,
    });

    const parsed = JSON.parse(body);
    assert.equal(response.statusCode, 200);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.requestId, created.requestId);
    assert.equal(parsed.normalizedEventType, "completed");

    const snapshot = getRequestSnapshot(db, created.requestId);
    assert.equal(snapshot.request.provider_request_id, "doc_http");
  } finally {
    db.close();
    cleanup();
  }
});
