import test from "node:test";
import assert from "node:assert/strict";
import { renderBulkResultAsNdjson } from "../lib/ndjson.js";

test("renderBulkResultAsNdjson emits one JSON object per row plus a summary line", () => {
  const out = renderBulkResultAsNdjson({
    total: 2,
    succeeded: 1,
    failed: 1,
    results: [
      { row: 1, ok: true, requestId: "req-1" },
      { row: 2, ok: false, error: { code: "X", message: "boom" } },
    ],
  });
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 3); // 2 rows + summary
  // Each line parses cleanly.
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].row, 1);
  assert.equal(parsed[0].ok, true);
  assert.equal(parsed[1].row, 2);
  assert.equal(parsed[1].ok, false);
  // Final summary line carries a `summary: true` discriminant + counts.
  assert.equal(parsed[2].summary, true);
  assert.equal(parsed[2].total, 2);
  assert.equal(parsed[2].succeeded, 1);
  assert.equal(parsed[2].failed, 1);
});

test("renderBulkResultAsNdjson terminates with a trailing newline so consumers can `tail -F`", () => {
  const out = renderBulkResultAsNdjson({ total: 0, succeeded: 0, failed: 0, results: [] });
  assert.ok(out.endsWith("\n"));
  // Empty results: only the summary line.
  assert.equal(out.trim().split("\n").length, 1);
});

test("renderBulkResultAsNdjson does not pretty-print — each row is a single line", () => {
  const out = renderBulkResultAsNdjson({
    total: 1, succeeded: 1, failed: 0,
    results: [{ row: 1, nested: { a: 1, b: { c: 2 } } }],
  });
  // No newlines inside a row — only between rows.
  for (const line of out.trim().split("\n")) {
    assert.ok(!line.includes("\n"));
    JSON.parse(line); // confirms each line is a complete JSON value
  }
});
