import test from "node:test";
import assert from "node:assert/strict";
import { parsePrefillSpec, parseSignerSpec } from "../lib/util.js";

test("parseSignerSpec accepts role:", () => {
  const signer = parseSignerSpec("role:Buyer,name:Alice,email:alice@example.com,order:1");
  assert.equal(signer.role, "Buyer");
  assert.equal(signer.name, "Alice");
  assert.equal(signer.email, "alice@example.com");
  assert.equal(signer.order, 1);
});

test("parseSignerSpec keeps role optional for non-template usage", () => {
  const signer = parseSignerSpec("name:Alice,email:alice@example.com,order:1");
  assert.equal(signer.role, undefined);
});

test("parsePrefillSpec extracts name + value", () => {
  const prefill = parsePrefillSpec(`name:purchase_price,value:"1,000"`);
  assert.equal(prefill.name, "purchase_price");
  assert.equal(prefill.value, "1,000");
});

test("parsePrefillSpec accepts optional signer:", () => {
  const prefill = parsePrefillSpec("name:title,value:CEO,signer:2");
  assert.equal(prefill.signerOrder, 2);
});

test("parsePrefillSpec rejects missing name or value", () => {
  assert.throws(() => parsePrefillSpec("value:hi"), /name:<key>/);
  assert.throws(() => parsePrefillSpec("name:hi"), /value:<v>/);
});
