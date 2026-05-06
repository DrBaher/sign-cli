import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, getRequestSnapshot } from "../lib/signing-service.js";
import { handleWebhookHttpRequest } from "../lib/webhook-http.js";
import { hmacSha256 } from "../lib/util.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

function createMockResponse() {
  const headers = new Map<string, string>();
  let body = "";

  return {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
    getBody() {
      return body;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
  };
}

test("handleWebhookHttpRequest ingests verified payloads and persists signature IDs", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("webhook");
  const apiKey = "test-api-key";

  try {
    const created = createSigningRequest(db, {
      title: "Webhook Contract",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const payload = {
      event: {
        event_time: "1715000000",
        event_type: "signature_request_sent",
        event_hash: hmacSha256(apiKey, "1715000000signature_request_sent"),
      },
      signature_request: {
        signature_request_id: "sigreq_webhook",
        metadata: {
          request_id: created.requestId,
        },
        signatures: [
          { signature_id: "sig_from_webhook" },
        ],
      },
    };

    const requestBody = new URLSearchParams({
      json: JSON.stringify(payload),
    }).toString();
    const request = {
      "content-type": "application/x-www-form-urlencoded",
    };
    const incomingRequest = {
      headers: request,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(requestBody);
      },
    };

    const response = createMockResponse();
    await handleWebhookHttpRequest(incomingRequest as any, response as any, { dbPath, apiKey });

    const parsed = JSON.parse(response.getBody());
    const snapshot = getRequestSnapshot(db, created.requestId);

    assert.equal(response.statusCode, 200);
    assert.equal(response.getHeader("content-type"), "application/json; charset=utf-8");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.requestId, created.requestId);
    assert.equal(parsed.eventType, "signature_request_sent");
    assert.equal(snapshot.request.provider, "dropbox");
    assert.equal(snapshot.request.provider_request_id, "sigreq_webhook");
    assert.deepEqual(snapshot.request.signatureIds, ["sig_from_webhook"]);
    assert.equal(snapshot.request.dropbox_signature_request_id, "sigreq_webhook");
  } finally {
    db.close();
    cleanup();
  }
});
