import test from "node:test";
import assert from "node:assert/strict";
import {
  bottomLeftToTopLeft,
  docusignTabsForSigner,
  dropboxFormFieldsPerDocument,
  parseFieldSpec,
  signwellFieldsPerFile,
} from "../lib/field-placement.js";

test("bottomLeftToTopLeft flips the origin and accounts for field height", () => {
  // A field whose bottom-left sits at y=100 on a 792pt-tall (US Letter) page,
  // 30pt tall, should have its top edge at 792 - 100 - 30 = 662 from the top.
  assert.deepEqual(
    bottomLeftToTopLeft({ x: 72, y: 100, pageHeight: 792, height: 30 }),
    { x: 72, y: 662 },
  );
  // Without a height we get the baseline point flipped (top edge at the line).
  assert.deepEqual(
    bottomLeftToTopLeft({ x: 72, y: 100, pageHeight: 792 }),
    { x: 72, y: 692 },
  );
});

test("parseFieldSpec accepts coordinate-based fields", () => {
  const field = parseFieldSpec("signer:1,doc:0,page:2,x:120,y:300,type:signature,width:200,height:30");
  assert.equal(field.signerOrder, 1);
  assert.equal(field.documentIndex, 0);
  assert.equal(field.page, 2);
  assert.equal(field.x, 120);
  assert.equal(field.y, 300);
  assert.equal(field.type, "signature");
  assert.equal(field.width, 200);
  assert.equal(field.height, 30);
  assert.equal(field.required, true);
  assert.equal(field.anchor, undefined);
});

test("parseFieldSpec accepts anchor-based fields", () => {
  const field = parseFieldSpec(`signer:2,anchor:"Sign here",y-offset:20,type:date,anchor-units:pixels`);
  assert.equal(field.anchor, "Sign here");
  assert.equal(field.anchorYOffset, 20);
  assert.equal(field.anchorUnits, "pixels");
  assert.equal(field.type, "date");
});

test("parseFieldSpec defaults documentIndex to 0 and required to true", () => {
  const field = parseFieldSpec("signer:1,page:1,x:1,y:1");
  assert.equal(field.documentIndex, 0);
  assert.equal(field.required, true);
  assert.equal(field.type, "signature");
});

test("parseFieldSpec rejects invalid signer/order", () => {
  assert.throws(() => parseFieldSpec("page:1,x:1,y:1"), /signer:/);
  assert.throws(() => parseFieldSpec("signer:0,page:1,x:1,y:1"), /positive integer/);
});

test("parseFieldSpec rejects fields with neither anchor nor coords", () => {
  assert.throws(() => parseFieldSpec("signer:1"), /anchor:"text" or page\+x\+y/);
});

test("parseFieldSpec rejects unknown type", () => {
  assert.throws(() => parseFieldSpec("signer:1,page:1,x:1,y:1,type:checkbox"), /Field type must be one of/);
});

test("dropboxFormFieldsPerDocument splits fields by document and resolves signer index", () => {
  const fields = [
    parseFieldSpec("signer:2,doc:0,page:1,x:50,y:50,type:signature"),
    parseFieldSpec("signer:1,doc:1,page:1,x:60,y:60,type:date"),
  ];
  const result = dropboxFormFieldsPerDocument(fields, [1, 2], 2);
  assert.equal(result[0].length, 1);
  assert.equal(result[1].length, 1);
  assert.equal((result[0][0] as any).signer, 1);
  assert.equal((result[0][0] as any).type, "signature");
  assert.equal((result[1][0] as any).type, "date_signed");
});

test("dropboxFormFieldsPerDocument rejects anchor-only fields", () => {
  const fields = [parseFieldSpec(`signer:1,anchor:"Sign here"`)];
  assert.throws(() => dropboxFormFieldsPerDocument(fields, [1], 1), /Anchor strings are not supported/);
});

test("docusignTabsForSigner groups fields by tab type and supports anchor", () => {
  const fields = [
    parseFieldSpec("signer:1,page:1,x:50,y:50,type:signature"),
    parseFieldSpec(`signer:1,anchor:"Sign here",y-offset:20,type:date`),
    parseFieldSpec("signer:2,page:1,x:60,y:60,type:signature"),
  ];
  const tabs = docusignTabsForSigner(1, fields);
  assert.equal(tabs.signHereTabs?.length, 1);
  assert.equal(tabs.dateSignedTabs?.length, 1);
  assert.equal(tabs.dateSignedTabs?.[0].anchorString, "Sign here");
  assert.equal(tabs.dateSignedTabs?.[0].anchorYOffset, "20");
});

test("signwellFieldsPerFile maps signer order to recipient_id and rejects anchor", () => {
  const fields = [
    parseFieldSpec("signer:2,doc:0,page:1,x:50,y:50,type:signature"),
  ];
  const map = new Map<number, string>([[1, "1"], [2, "2"]]);
  const out = signwellFieldsPerFile(fields, map, 1);
  assert.equal(out[0][0].recipient_id, "2");
  assert.equal(out[0][0].type, "signature");
  const anchor = [parseFieldSpec(`signer:1,anchor:"Sign here"`)];
  assert.throws(() => signwellFieldsPerFile(anchor, map, 1), /Anchor strings are not supported/);
});
