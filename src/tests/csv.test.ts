import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../lib/csv.js";

test("parseCsv parses headers and trims whitespace", () => {
  const rows = parseCsv("name,email\n Alice , alice@example.com \nBob,bob@x.com\n");
  assert.deepEqual(rows, [
    { name: "Alice", email: "alice@example.com" },
    { name: "Bob", email: "bob@x.com" },
  ]);
});

test("parseCsv handles quoted fields with commas and escaped quotes", () => {
  const rows = parseCsv(`name,email\n"Last, First","quote \"\"hi\"\""\n`);
  assert.deepEqual(rows, [
    { name: "Last, First", email: 'quote "hi"' },
  ]);
});

test("parseCsv ignores BOM and CRLF line endings", () => {
  const rows = parseCsv("﻿a,b\r\n1,2\r\n3,4\r\n");
  assert.deepEqual(rows, [
    { a: "1", b: "2" },
    { a: "3", b: "4" },
  ]);
});

test("parseCsv returns empty array for blank input", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\n\n"), []);
});
