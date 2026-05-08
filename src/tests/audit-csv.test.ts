import test from "node:test";
import assert from "node:assert/strict";
import { renderAuditChainAsCsv } from "../lib/audit-csv.js";

test("renderAuditChainAsCsv emits header-only CRLF for an empty chain", () => {
  const out = renderAuditChainAsCsv([]);
  assert.equal(out, "id,event_type,created_at,hash_prev,hash_self,payload_json\r\n");
});

test("renderAuditChainAsCsv quotes fields containing commas, newlines, or double quotes", () => {
  const out = renderAuditChainAsCsv([
    {
      id: 1,
      event_type: "request.created",
      payload_json: '{"title":"NDA, Acme \"Co\"","note":"line1\nline2"}',
      hash_prev: null,
      hash_self: "abc123",
      created_at: "2026-05-01T00:00:00Z",
    },
  ]);
  // hash_prev null serializes as empty; the payload (containing comma, quotes,
  // and a literal newline) is wrapped and inner quotes are doubled per RFC 4180.
  assert.match(out, /^id,event_type,created_at,hash_prev,hash_self,payload_json\r\n/);
  assert.match(out, /^1,request\.created,2026-05-01T00:00:00Z,,abc123,"/m);
  assert.match(out, /""title"":""NDA, Acme ""Co""""/);
});

test("renderAuditChainAsCsv preserves row order and escapes newlines inside payload", () => {
  const out = renderAuditChainAsCsv([
    { id: 1, event_type: "a", payload_json: "{}", hash_prev: null, hash_self: "h1", created_at: "t1" },
    { id: 2, event_type: "b", payload_json: "line1\nline2", hash_prev: "h1", hash_self: "h2", created_at: "t2" },
  ]);
  const lines = out.split(/\r\n/u);
  assert.equal(lines[0], "id,event_type,created_at,hash_prev,hash_self,payload_json");
  assert.equal(lines[1], "1,a,t1,,h1,{}");
  // Row 2 has a literal newline inside the payload — entire field must be quoted, but
  // the CSV row itself can contain that literal newline (RFC 4180 §2.6).
  assert.match(out, /"line1\nline2"/u);
});
