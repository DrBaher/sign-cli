import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAutoPlaceMode,
  selectAutoPlaceCandidates,
  formatAutoPlaceChoice,
  InvalidAutoPlaceValue,
} from "../lib/auto-place-selector.js";
import type { DetectedField } from "../lib/signature-field-detection.js";

function cand(page: number, x: number, y: number, conf: number, label = "Signature:"): DetectedField {
  return {
    page, x, y, width: 100, height: 30,
    source: `anchor:${label}` as `anchor:${string}`,
    confidence: conf,
    adjustedFrom: "underline-snap",
    anchorText: label,
    category: "signature",
  };
}

// ─── parseAutoPlaceMode ────────────────────────────────────────────────────

test("parseAutoPlaceMode: undefined/empty → none", () => {
  assert.deepEqual(parseAutoPlaceMode(undefined), { kind: "none" });
  assert.deepEqual(parseAutoPlaceMode(null), { kind: "none" });
  assert.deepEqual(parseAutoPlaceMode(""), { kind: "none" });
});

test("parseAutoPlaceMode: legacy boolean strings", () => {
  for (const v of ["true", "yes", "1"]) {
    assert.deepEqual(parseAutoPlaceMode(v), { kind: "unique" }, `value=${v}`);
  }
  for (const v of ["false", "no", "0"]) {
    assert.deepEqual(parseAutoPlaceMode(v), { kind: "none" }, `value=${v}`);
  }
});

test("parseAutoPlaceMode: first/last/all literals", () => {
  assert.deepEqual(parseAutoPlaceMode("first"), { kind: "first" });
  assert.deepEqual(parseAutoPlaceMode("last"), { kind: "last" });
  assert.deepEqual(parseAutoPlaceMode("all"), { kind: "all" });
});

test("parseAutoPlaceMode: page:N → { kind: page, page: N }", () => {
  assert.deepEqual(parseAutoPlaceMode("page:1"), { kind: "page", page: 1 });
  assert.deepEqual(parseAutoPlaceMode("page:42"), { kind: "page", page: 42 });
});

test("parseAutoPlaceMode: page:0 → InvalidAutoPlaceValue (1-indexed)", () => {
  assert.throws(() => parseAutoPlaceMode("page:0"), InvalidAutoPlaceValue);
});

test("parseAutoPlaceMode: index:N → { kind: index, index: N }", () => {
  assert.deepEqual(parseAutoPlaceMode("index:0"), { kind: "index", index: 0 });
  assert.deepEqual(parseAutoPlaceMode("index:5"), { kind: "index", index: 5 });
});

test("parseAutoPlaceMode: invalid value → InvalidAutoPlaceValue with hint", () => {
  try {
    parseAutoPlaceMode("nonsense");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof InvalidAutoPlaceValue);
    assert.match(err.message, /Valid values.*first.*last.*all.*page:N.*index:N/);
  }
});

// ─── selectAutoPlaceCandidates ─────────────────────────────────────────────

test("selectAutoPlaceCandidates: none mode → empty chosen, ok", () => {
  const r = selectAutoPlaceCandidates([cand(1, 100, 500, 0.95)], { kind: "none" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.chosen, []);
});

test("selectAutoPlaceCandidates: unique with exactly one high-confidence → ok", () => {
  const candidates = [cand(1, 100, 500, 0.95), cand(1, 200, 300, 0.5)];
  const r = selectAutoPlaceCandidates(candidates, { kind: "unique" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.chosen.length, 1);
  assert.equal(r.chosen[0].confidence, 0.95);
});

test("selectAutoPlaceCandidates: unique with TWO high-confidence → AUTO_PLACE_AMBIGUOUS", () => {
  const r = selectAutoPlaceCandidates(
    [cand(1, 100, 500, 0.95), cand(1, 200, 300, 0.85)],
    { kind: "unique" },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, "AUTO_PLACE_AMBIGUOUS");
  assert.match(r.hint!, /first.*last.*all.*page:N.*index:N/);
});

test("selectAutoPlaceCandidates: any mode with zero high-confidence → AUTO_PLACE_NO_HIGH_CONFIDENCE", () => {
  for (const mode of [
    { kind: "unique" as const },
    { kind: "first" as const },
    { kind: "last" as const },
    { kind: "all" as const },
    { kind: "page" as const, page: 1 },
    { kind: "index" as const, index: 0 },
  ]) {
    const r = selectAutoPlaceCandidates([cand(1, 100, 500, 0.5)], mode);
    assert.equal(r.ok, false, `mode=${JSON.stringify(mode)} should fail`);
    if (r.ok) continue;
    assert.equal(r.errorCode, "AUTO_PLACE_NO_HIGH_CONFIDENCE");
  }
});

test("selectAutoPlaceCandidates: first → lowest page, top y first", () => {
  // Page 2 first, page 1 second; on page 1, two candidates at different y.
  const candidates = [
    cand(2, 100, 500, 0.95),
    cand(1, 100, 300, 0.95),   // lower on page 1
    cand(1, 100, 600, 0.95),   // top of page 1 — should win
  ];
  const r = selectAutoPlaceCandidates(candidates, { kind: "first" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.chosen[0].page, 1);
  assert.equal(r.chosen[0].y, 600);
});

test("selectAutoPlaceCandidates: last → highest page, lowest y first", () => {
  const candidates = [
    cand(1, 100, 600, 0.95),
    cand(2, 100, 600, 0.95),   // top of page 2
    cand(2, 100, 100, 0.95),   // bottom of page 2 — should win
  ];
  const r = selectAutoPlaceCandidates(candidates, { kind: "last" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.chosen[0].page, 2);
  assert.equal(r.chosen[0].y, 100);
});

test("selectAutoPlaceCandidates: all → every high-confidence candidate", () => {
  const candidates = [
    cand(1, 100, 600, 0.95),
    cand(1, 100, 300, 0.85),
    cand(1, 100, 100, 0.5),    // low-confidence, filtered out
  ];
  const r = selectAutoPlaceCandidates(candidates, { kind: "all" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.chosen.length, 2);
});

test("selectAutoPlaceCandidates: page:N → unique candidate on page N", () => {
  const candidates = [cand(1, 100, 600, 0.95), cand(2, 100, 600, 0.95)];
  const r = selectAutoPlaceCandidates(candidates, { kind: "page", page: 2 });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.chosen.length, 1);
  assert.equal(r.chosen[0].page, 2);
});

test("selectAutoPlaceCandidates: page:N with multiple on page → AUTO_PLACE_PAGE_AMBIGUOUS", () => {
  const r = selectAutoPlaceCandidates(
    [cand(1, 100, 600, 0.95), cand(1, 100, 300, 0.95)],
    { kind: "page", page: 1 },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, "AUTO_PLACE_PAGE_AMBIGUOUS");
});

test("selectAutoPlaceCandidates: page:N with zero on page → AUTO_PLACE_PAGE_NOT_FOUND with hint listing other pages", () => {
  const r = selectAutoPlaceCandidates(
    [cand(1, 100, 600, 0.95), cand(2, 100, 600, 0.95)],
    { kind: "page", page: 5 },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, "AUTO_PLACE_PAGE_NOT_FOUND");
  assert.match(r.hint!, /pages: 1, 2/);
});

test("selectAutoPlaceCandidates: index:N picks Nth from high-confidence list", () => {
  const candidates = [
    cand(1, 100, 600, 0.95, "Signature:"),
    cand(1, 100, 300, 0.95, "Signed by:"),
  ];
  const r0 = selectAutoPlaceCandidates(candidates, { kind: "index", index: 0 });
  assert.ok(r0.ok);
  if (!r0.ok) return;
  assert.equal(r0.chosen[0].source, "anchor:Signature:");

  const r1 = selectAutoPlaceCandidates(candidates, { kind: "index", index: 1 });
  assert.ok(r1.ok);
  if (!r1.ok) return;
  assert.equal(r1.chosen[0].source, "anchor:Signed by:");
});

test("selectAutoPlaceCandidates: index:N out of range → AUTO_PLACE_INDEX_OUT_OF_RANGE", () => {
  const r = selectAutoPlaceCandidates([cand(1, 100, 600, 0.95)], { kind: "index", index: 5 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, "AUTO_PLACE_INDEX_OUT_OF_RANGE");
});

// ─── formatAutoPlaceChoice ────────────────────────────────────────────────

test("formatAutoPlaceChoice: single → one-line description with rect", () => {
  const out = formatAutoPlaceChoice([cand(1, 140, 596, 0.95)]);
  assert.match(out, /anchor:Signature: \(confidence 0\.95.*\) at page=1 x=140 y=596 w=100 h=30/);
});

test("formatAutoPlaceChoice: multiple → N candidates across pages summary", () => {
  const out = formatAutoPlaceChoice([cand(1, 0, 0, 0.95), cand(2, 0, 0, 0.95), cand(1, 100, 0, 0.95)]);
  assert.match(out, /3 candidates across page\(s\) 1,2/);
});
