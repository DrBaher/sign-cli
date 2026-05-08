import test from "node:test";
import assert from "node:assert/strict";
import { renderAuditChainAsPretty, type PrettyAuditEvent } from "../lib/audit-pretty.js";

const E1: PrettyAuditEvent = {
  id: 1,
  event_type: "request.created",
  payload_json: JSON.stringify({ title: "NDA Acme", signers: 2, autoApprove: false }),
  hash_prev: null,
  hash_self: "1a2b3c4d5e6f7890aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011",
  created_at: "2026-05-08T12:00:00.000Z",
};
const E2: PrettyAuditEvent = {
  id: 2,
  event_type: "request.signed",
  payload_json: JSON.stringify({ signerEmail: "alice@example.com", at: "2026-05-08T12:01:00Z" }),
  hash_prev: E1.hash_self,
  hash_self: "deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef",
  created_at: "2026-05-08T12:01:00.000Z",
};

test("renderAuditChainAsPretty emits a multi-line timeline with hash + payload summary", () => {
  const md = renderAuditChainAsPretty([E1, E2]);
  const lines = md.split("\n");
  assert.equal(lines.length, 6); // two events × 3 lines
  assert.match(lines[0], /^2026-05-08T12:00:00\.000Z {2}\[request\.created\]/);
  assert.match(lines[1], /hash:.*prev: \(genesis\)/);
  assert.match(lines[2], /title="NDA Acme"/);
  assert.match(lines[2], /signers=2/);
  assert.match(lines[2], /autoApprove=false/);
  assert.match(lines[4], /prev: 1a2b3c…0011/);
  assert.match(lines[5], /signerEmail="alice@example\.com"/);
});

test("renderAuditChainAsPretty handles malformed JSON payloads gracefully (raw fallback)", () => {
  const broken: PrettyAuditEvent = { ...E1, payload_json: "not-valid-json" };
  const out = renderAuditChainAsPretty([broken]);
  assert.match(out, /not-valid-json/);
});

test("renderAuditChainAsPretty marks nested-payload events with an ellipsis after the scalar fields", () => {
  const nested: PrettyAuditEvent = {
    ...E1,
    payload_json: JSON.stringify({ requestId: "req-1", chain: { events: 7, valid: true } }),
  };
  const out = renderAuditChainAsPretty([nested]);
  assert.match(out, /requestId="req-1"/);
  assert.match(out, / …/);
});

test("renderAuditChainAsPretty returns a friendly placeholder for an empty chain", () => {
  assert.equal(renderAuditChainAsPretty([]), "(no events)");
});
