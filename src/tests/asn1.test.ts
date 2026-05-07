import test from "node:test";
import assert from "node:assert/strict";
import { decodeOid, parseAsn1 } from "../lib/asn1.js";

test("parseAsn1 reads SEQUENCE with INTEGER and OCTET STRING", () => {
  // SEQUENCE { INTEGER 7, OCTET STRING 0xCAFEBABE }
  const buffer = Buffer.from([
    0x30, 0x09,
    0x02, 0x01, 0x07,
    0x04, 0x04, 0xca, 0xfe, 0xba, 0xbe,
  ]);
  const node = parseAsn1(buffer);
  assert.equal(node.tagNumber, 16);
  assert.equal(node.constructed, true);
  assert.equal(node.children?.length, 2);
  assert.equal(node.children?.[0].contents[0], 0x07);
  assert.deepEqual(node.children?.[1].contents.toString("hex"), "cafebabe");
});

test("parseAsn1 handles long-form length", () => {
  const contents = Buffer.alloc(200, 0xab);
  const buffer = Buffer.concat([Buffer.from([0x04, 0x81, 200]), contents]);
  const node = parseAsn1(buffer);
  assert.equal(node.tagNumber, 4);
  assert.equal(node.contentLength, 200);
});

test("decodeOid decodes RSA encryption OID", () => {
  // 1.2.840.113549.1.1.1
  const oidBytes = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  assert.equal(decodeOid(oidBytes), "1.2.840.113549.1.1.1");
});
