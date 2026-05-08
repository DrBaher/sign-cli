import test from "node:test";
import assert from "node:assert/strict";
import { explainQueryPlan, listDbIndexes, suggestMissingIndexes } from "../lib/db-indexes.js";
import { createDb, makeTempDb } from "./helpers.js";

test("listDbIndexes returns user-created indexes with their columns + unique flag", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    db.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY, sku TEXT NOT NULL, color TEXT)");
    db.exec("CREATE UNIQUE INDEX widgets_sku_idx ON widgets (sku)");
    db.exec("CREATE INDEX widgets_color_idx ON widgets (color)");
    const indexes = listDbIndexes(db);
    const sku = indexes.find((i) => i.name === "widgets_sku_idx");
    const color = indexes.find((i) => i.name === "widgets_color_idx");
    assert.ok(sku, "sku index should be reported");
    assert.equal(sku!.unique, true);
    assert.deepEqual(sku!.columns, ["sku"]);
    assert.equal(sku!.table, "widgets");
    assert.ok(color);
    assert.equal(color!.unique, false);
  } finally {
    db.close();
    cleanup();
  }
});

test("explainQueryPlan returns step rows that reference an index when one is available", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, k TEXT NOT NULL)");
    db.exec("CREATE INDEX t_k_idx ON t (k)");
    db.prepare("INSERT INTO t (id, k) VALUES ('a', 'foo')").run();
    const plan = explainQueryPlan(db, "SELECT * FROM t WHERE k = 'foo'");
    assert.ok(plan.length >= 1);
    // SQLite's planner mentions the index name in the detail string when the index is used.
    assert.ok(plan.some((step) => /t_k_idx/.test(step.detail)), "plan should reference t_k_idx");
  } finally {
    db.close();
    cleanup();
  }
});

test("suggestMissingIndexes flags large tables that have zero user-created indexes", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    db.exec("CREATE TABLE small (id TEXT PRIMARY KEY, v TEXT)");
    db.exec("CREATE TABLE big (id TEXT PRIMARY KEY, v TEXT)");
    const insertBig = db.prepare("INSERT INTO big (id, v) VALUES (?, ?)");
    for (let i = 0; i < 50; i += 1) insertBig.run(`id-${i}`, `v-${i}`);
    // Threshold below big's row count, above small's — only big should be flagged.
    const suggestions = suggestMissingIndexes(db, 25);
    const tables = suggestions.map((s) => s.table);
    assert.ok(tables.includes("big"));
    assert.ok(!tables.includes("small"));
  } finally {
    db.close();
    cleanup();
  }
});

test("suggestMissingIndexes does not flag tables that already have a user-created index", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    db.exec("CREATE TABLE big_indexed (id TEXT PRIMARY KEY, v TEXT)");
    db.exec("CREATE INDEX big_v_idx ON big_indexed (v)");
    const insert = db.prepare("INSERT INTO big_indexed (id, v) VALUES (?, ?)");
    for (let i = 0; i < 20; i += 1) insert.run(`id-${i}`, `v-${i}`);
    const suggestions = suggestMissingIndexes(db, 10);
    assert.ok(!suggestions.some((s) => s.table === "big_indexed"));
  } finally {
    db.close();
    cleanup();
  }
});
