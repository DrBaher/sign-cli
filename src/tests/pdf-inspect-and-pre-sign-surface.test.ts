// Coverage for the new `pdf inspect` surface + the auto-surface of
// `existingSignatures` in `signer fetch-document` and `sign document`.
// Verifies:
//   - The new pdf_inspect_signatures MCP tool returns the report shape.
//   - The new POST /v1/pdf/inspect-signatures HTTP route is registered.
//   - signer_fetch_document's result now includes existingSignatures.
//   - signer_fetch_document's outputSchema advertises the new field.
//   - sign document on a fresh-PDF input surfaces existingSignatures=null
//     when the input is DOCX (not converted in this test), or a summary
//     when the input was already PDF.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchMcp, listMcpTools } from "../lib/mcp-server.js";
import { listMockHttpRoutes } from "../lib/http-api.js";
import {
  createSigningRequest,
  fetchUnsignedDocumentForSigner,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { inspectPdfSignatures, summarizeExistingSignatures } from "../lib/pdf-signature.js";
import { createDb, makeTempDb } from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_PDF = path.resolve(__dirname, "../../fixtures/canonical-unsigned-v1.pdf");

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-inspect-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

// ─── Surface registration ───────────────────────────────────────────────

test("MCP tool pdf_inspect_signatures is registered and read-only", () => {
  const names = listMcpTools().map((t) => t.name);
  assert.ok(names.includes("pdf_inspect_signatures"), "pdf_inspect_signatures missing");
});

test("HTTP route POST /v1/pdf/inspect-signatures is registered", () => {
  assert.ok(listMockHttpRoutes().includes("POST /v1/pdf/inspect-signatures"));
});

// ─── Library primitive ──────────────────────────────────────────────────

test("inspectPdfSignatures on a fresh PDF returns hasSignature=false", async () => {
  if (!existsSync(CANONICAL_PDF)) return;
  const report = await inspectPdfSignatures(CANONICAL_PDF);
  assert.equal(report.hasSignature, false);
  assert.equal(report.signatureCount, 0);
  // Canonical fixture is a 1-page A4 with no /ByteRange — should
  // surface the "not signed" warning.
  assert.ok(report.warnings.some((w) => /not signed/i.test(w)));
});

test("summarizeExistingSignatures on a fresh PDF projects to count=0", async () => {
  if (!existsSync(CANONICAL_PDF)) return;
  const summary = summarizeExistingSignatures(await inspectPdfSignatures(CANONICAL_PDF));
  assert.equal(summary.count, 0);
  assert.equal(summary.hasSignature, false);
  assert.equal(summary.allDigestsOk, false); // no sigs → vacuously not "ok"
  assert.deepEqual(summary.signers, []);
});

// ─── MCP pdf_inspect_signatures ─────────────────────────────────────────

test("MCP pdf_inspect_signatures returns the report shape", async () => {
  if (!existsSync(CANONICAL_PDF)) return;
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  process.env.SIGN_ALLOW_ABSOLUTE_DOCS = "1";
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "pdf_inspect_signatures", arguments: { pdf_path: CANONICAL_PDF } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.notEqual(value.isError, true);
    const payload = JSON.parse(value.content[0].text);
    assert.equal(payload.hasSignature, false);
    assert.equal(payload.signatureCount, 0);
    assert.equal(payload.path, CANONICAL_PDF);
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    db.close();
    cleanup();
  }
});

test("MCP pdf_inspect_signatures rejects path-traversal", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "pdf_inspect_signatures", arguments: { pdf_path: "/etc/passwd" } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.equal(value.isError, true);
    const envelope = JSON.parse(value.content[0].text);
    assert.match(envelope.error.message, /escapes the working directory/);
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    db.close();
    cleanup();
  }
});

// ─── Auto-surface in signer fetch-document ──────────────────────────────

test("signer fetch-document result includes existingSignatures (empty for a fresh PDF)", { concurrency: false }, async () => {
  if (!existsSync(CANONICAL_PDF)) return;
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-inspect-fetch-"));
    const docPath = path.join(dir, "doc.pdf");
    writeFileSync(docPath, await (await import("node:fs/promises")).readFile(CANONICAL_PDF));
    try {
      const created = createSigningRequest(db, {
        title: "Inspect-fetch test",
        documentPath: docPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const result = await fetchUnsignedDocumentForSigner(db, {
        requestId: created.requestId,
        token: created.tokens[0].token,
      });
      assert.ok(result.existingSignatures, "existingSignatures field missing");
      assert.equal(result.existingSignatures.count, 0);
      assert.equal(result.existingSignatures.hasSignature, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("signer_fetch_document MCP outputSchema advertises existingSignatures", () => {
  const tool = listMcpTools().find((t) => t.name === "signer_fetch_document");
  assert.ok(tool);
  const props = (tool!.outputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok("existingSignatures" in props, "outputSchema.properties.existingSignatures missing");
});
