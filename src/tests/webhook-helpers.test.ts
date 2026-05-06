import test from "node:test";
import assert from "node:assert/strict";
import { hmacSha256 } from "../lib/util.js";
import { parseWebhookRequestBody, verifyDropboxCallback } from "../lib/webhook.js";

const basePayload = {
  event: {
    event_time: "1715000000",
    event_type: "signature_request_completed",
  },
  signature_request: {
    signature_request_id: "sig_123",
    metadata: {
      request_id: "req_123",
    },
  },
};

test("parseWebhookRequestBody parses application/json wrapped payloads", () => {
  const payload = parseWebhookRequestBody(JSON.stringify({
    json: JSON.stringify(basePayload),
  }), "application/json");

  assert.equal(payload.signature_request?.metadata?.request_id, "req_123");
});

test("parseWebhookRequestBody parses form-urlencoded webhook bodies", () => {
  const payload = parseWebhookRequestBody(
    new URLSearchParams({
      json: JSON.stringify(basePayload),
    }).toString(),
    "application/x-www-form-urlencoded",
  );

  assert.equal(payload.event?.event_type, "signature_request_completed");
});

test("parseWebhookRequestBody parses multipart webhook bodies", () => {
  const boundary = "dropbox-test-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="json"',
    "",
    JSON.stringify(basePayload),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const payload = parseWebhookRequestBody(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(payload.signature_request?.signature_request_id, "sig_123");
});

test("parseWebhookRequestBody rejects multipart bodies without a boundary", () => {
  assert.throws(
    () => parseWebhookRequestBody("ignored", "multipart/form-data"),
    /missing a boundary/i,
  );
});

test("verifyDropboxCallback accepts valid event hashes and rejects missing fields", () => {
  const apiKey = "test-api-key";
  const validPayload = {
    ...basePayload,
    event: {
      ...basePayload.event,
      event_hash: hmacSha256(apiKey, `${basePayload.event.event_time}${basePayload.event.event_type}`),
    },
  };

  assert.equal(verifyDropboxCallback(apiKey, validPayload), true);
  assert.equal(verifyDropboxCallback(apiKey, { event: { event_type: "missing-time" } }), false);
});
