import test from "node:test";
import assert from "node:assert/strict";
import { parseSignerSpec } from "../lib/util.js";

test("parseSignerSpec parses repeated multi-signer input", () => {
  const signerOne = parseSignerSpec("name:Alice Example,email:alice@example.com,order:2");
  const signerTwo = parseSignerSpec("name:Bob Example,email:bob@example.com,order:1");

  assert.deepEqual(signerOne, {
    name: "Alice Example",
    email: "alice@example.com",
    order: 2,
  });
  assert.deepEqual(signerTwo, {
    name: "Bob Example",
    email: "bob@example.com",
    order: 1,
  });
});
