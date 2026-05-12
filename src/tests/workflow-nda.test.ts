import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, makeTempDb } from "./helpers.js";
import { runNdaWorkflow, bundledMutualNdaPath } from "../lib/workflow-nda.js";
import { placeholders, substitute, renderTemplateToPdf } from "../lib/template-render.js";

const NDA_VALUES = {
  EFFECTIVE_DATE: "15 January 2026",
  PARTY_A_NAME: "Alpha Inc.",
  PARTY_A_ADDRESS: "100 Main St, Wilmington, DE",
  PARTY_A_SIGNATORY: "Carol Adams",
  PARTY_A_TITLE: "COO",
  PARTY_B_NAME: "Beta GmbH",
  PARTY_B_ADDRESS: "Friedrichstr. 100, Berlin",
  PARTY_B_SIGNATORY: "Dieter Becker",
  PARTY_B_TITLE: "Geschäftsführer",
  TERM_YEARS: "3",
  SURVIVAL_YEARS: "5",
  GOVERNING_LAW: "Germany",
  JURISDICTION: "Berlin",
};

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nda-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- template-render unit tests -------------------------------------------

test("substitute: replaces every {{KEY}} from values map", () => {
  const out = substitute("Hello {{NAME}}, welcome to {{PLACE}}.", { NAME: "Carol", PLACE: "Berlin" });
  assert.equal(out, "Hello Carol, welcome to Berlin.");
});

test("substitute: throws with a consolidated list of unresolved placeholders (all gaps surfaced at once, not just the first)", () => {
  assert.throws(
    () => substitute("{{A}} {{B}} {{C}}", { B: "ok" }),
    (err: Error) => /unresolved placeholders: A, C/.test(err.message),
  );
});

test("placeholders: returns the sorted unique set of {{KEY}} tokens", () => {
  const keys = placeholders("{{B}} {{A}} {{B}} text {{C}}");
  assert.deepEqual(keys, ["A", "B", "C"]);
});

test("renderTemplateToPdf: produces a valid PDF buffer starting with %PDF-", async () => {
  const pdf = await renderTemplateToPdf("# Title\n\nHello {{NAME}}.", { NAME: "Carol" });
  assert.ok(pdf.length > 200, "PDF should be non-trivial size");
  assert.equal(pdf.slice(0, 5).toString(), "%PDF-", "should start with PDF magic");
});

// --- workflow-nda integration tests ---------------------------------------

test("runNdaWorkflow: bundled template + full values → PDF written, request created with 2 signers", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    const out = path.join(dir, "nda.pdf");
    const result = await runNdaWorkflow(db, {
      values: NDA_VALUES,
      partyAEmail: "alice@example.com",
      partyBEmail: "bob@example.com",
      outPath: out,
    });
    assert.equal(result.ok, true);
    assert.equal(result.templateUsed, "bundled");
    assert.equal(result.templatePath, bundledMutualNdaPath());
    assert.ok(existsSync(out), "rendered PDF should be on disk");
    assert.equal(readFileSync(out).slice(0, 5).toString(), "%PDF-");
    assert.equal(result.pdfBytes, readFileSync(out).length);
    assert.ok(result.request.requestId.startsWith("req_"));
    // Title derived from PARTY_A_NAME / PARTY_B_NAME
    assert.match(result.title, /Mutual NDA — Alpha Inc\. & Beta GmbH/);
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("runNdaWorkflow: signer names default to PARTY_*_SIGNATORY values", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    const result = await runNdaWorkflow(db, {
      values: NDA_VALUES,
      partyAEmail: "alice@example.com",
      partyBEmail: "bob@example.com",
      outPath: path.join(dir, "nda.pdf"),
    });
    assert.equal(result.signers.length, 2);
    assert.equal(result.signers[0].name, "Carol Adams");
    assert.equal(result.signers[1].name, "Dieter Becker");
    assert.equal(result.signers[0].order, 1);
    assert.equal(result.signers[1].order, 2);
    // And cross-check that the underlying createSigningRequest got the same emails
    const tokenEmails = result.request.tokens.map((t) => t.signer.email).sort();
    assert.deepEqual(tokenEmails, ["alice@example.com", "bob@example.com"]);
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("runNdaWorkflow: missing placeholder values → error surfaces ALL missing keys at once", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    // Drop two required keys
    const partial = { ...NDA_VALUES };
    delete (partial as Record<string, string>).TERM_YEARS;
    delete (partial as Record<string, string>).GOVERNING_LAW;
    await assert.rejects(
      () => runNdaWorkflow(db, {
        values: partial,
        partyAEmail: "alice@example.com",
        partyBEmail: "bob@example.com",
        outPath: path.join(dir, "nda.pdf"),
      }),
      (err: Error) => /unresolved placeholders: .*GOVERNING_LAW.*TERM_YEARS/.test(err.message),
    );
    // PDF must NOT have been written when validation failed
    assert.equal(existsSync(path.join(dir, "nda.pdf")), false);
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("runNdaWorkflow: same email for both parties → rejected (catches a common copy-paste mistake before a request is created)", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    await assert.rejects(
      () => runNdaWorkflow(db, {
        values: NDA_VALUES,
        partyAEmail: "alice@example.com",
        partyBEmail: "alice@example.com",
        outPath: path.join(dir, "nda.pdf"),
      }),
      /different email addresses/,
    );
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("runNdaWorkflow: --template override loads a user-supplied file and reports templateUsed=custom", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    const customPath = path.join(dir, "custom.md");
    writeFileSync(customPath, "# Tiny NDA\n\nBetween {{PARTY_A_NAME}} and {{PARTY_B_NAME}}, dated {{EFFECTIVE_DATE}}.\n");
    const out = path.join(dir, "nda.pdf");
    const result = await runNdaWorkflow(db, {
      templatePath: customPath,
      values: {
        PARTY_A_NAME: "Acme",
        PARTY_B_NAME: "Globex",
        EFFECTIVE_DATE: "2026-05-12",
      },
      partyAEmail: "a@x.com",
      partyBEmail: "b@x.com",
      outPath: out,
    });
    assert.equal(result.templateUsed, "custom");
    assert.equal(result.templatePath, customPath);
    assert.deepEqual(result.placeholders, ["EFFECTIVE_DATE", "PARTY_A_NAME", "PARTY_B_NAME"]);
    assert.match(result.title, /Acme & Globex/);
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("runNdaWorkflow: --template path that doesn't exist → clear error", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    await assert.rejects(
      () => runNdaWorkflow(db, {
        templatePath: "/nonexistent/template.md",
        values: NDA_VALUES,
        partyAEmail: "alice@example.com",
        partyBEmail: "bob@example.com",
        outPath: path.join(dir, "nda.pdf"),
      }),
      /template not found/,
    );
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("runNdaWorkflow: explicit --title overrides the default derived from party names", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    const result = await runNdaWorkflow(db, {
      values: NDA_VALUES,
      partyAEmail: "alice@example.com",
      partyBEmail: "bob@example.com",
      outPath: path.join(dir, "nda.pdf"),
      title: "Project Apollo NDA",
    });
    assert.equal(result.title, "Project Apollo NDA");
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("runNdaWorkflow: parent directory for --out is created if missing", async () => {
  const { dbPath, cleanup: cleanupDb } = makeTempDb();
  const db = createDb(dbPath);
  const { dir, cleanup: cleanupDir } = tmpDir();
  try {
    const nested = path.join(dir, "deep", "nested", "nda.pdf");
    const result = await runNdaWorkflow(db, {
      values: NDA_VALUES,
      partyAEmail: "alice@example.com",
      partyBEmail: "bob@example.com",
      outPath: nested,
    });
    assert.equal(result.ok, true);
    assert.ok(existsSync(nested), "nested PDF should be created");
  } finally {
    cleanupDir(); cleanupDb();
  }
});

test("bundledMutualNdaPath: points to the fixtures/templates/mutual-nda.md that exists on disk", () => {
  const p = bundledMutualNdaPath();
  assert.ok(existsSync(p), `bundled template should exist at ${p}`);
  const contents = readFileSync(p, "utf8");
  assert.match(contents, /Mutual Non-Disclosure Agreement/);
});
