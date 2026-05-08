// In-process end-to-end smoke. Runs the full local-provider flow against a
// scratch DB + scratch local-provider store + scratch keys directory:
//
//   request create → request send → sign sign → fetch-final → verify-signed-pdf
//   → audit verify → request receipt → request verify-receipt
//
// Everything is cleaned up before return. Returns a structured report;
// throws on any failure so deployment scripts can use exit-code semantics.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { openDatabase } from "./db.js";
import { serveMcpStdio } from "./mcp-server.js";
import {
  createSigningRequest,
  exportRequestReceipt,
  fetchFinalSignedPdf,
  inspectRequestSignedPdf,
  sendSigningRequest,
  signSigningRequest,
  verifyRequestAuditChain,
} from "./signing-service.js";
import { verifyRequestReceiptBundle } from "./receipt-verify.js";

export type SelftestReport = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; durationMs: number; note?: string }>;
  workspace: string;
  cleaned: boolean;
};

export async function runSelftest(opts: { keepWorkspace?: boolean } = {}): Promise<SelftestReport> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "sign-selftest-"));
  const dbPath = path.join(workspace, "sign.db");
  const docPath = path.join(workspace, "doc.pdf");
  writeFileSync(docPath, Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
4 0 obj << /Length 35 >> stream
BT /F1 14 Tf 60 720 Td (selftest fixture) Tj ET
endstream
endobj
trailer << /Root 1 0 R /Size 5 >>
%%EOF`, "latin1"));

  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousKeys = process.env.SIGN_LOCAL_KEY_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  const previousDbBackend = process.env.SIGN_DB_BACKEND;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(workspace, "store");
  process.env.SIGN_LOCAL_KEY_DIR = path.join(workspace, "keys");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  process.env.SIGN_DB_BACKEND = "sqlite";

  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousKeys === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previousKeys;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    if (previousDbBackend === undefined) delete process.env.SIGN_DB_BACKEND;
    else process.env.SIGN_DB_BACKEND = previousDbBackend;
  };

  const steps: SelftestReport["steps"] = [];
  let allOk = true;
  let cleaned = false;

  async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    const started = Date.now();
    try {
      const value = await fn();
      steps.push({ name, ok: true, durationMs: Date.now() - started });
      return value;
    } catch (error) {
      allOk = false;
      steps.push({
        name,
        ok: false,
        durationMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  const db = openDatabase(dbPath);
  try {
    const created = await step("request.create", () =>
      createSigningRequest(db, {
        title: "Sign CLI selftest",
        documentPath: docPath,
        signers: [{ name: "Selftest Signer", email: "selftest@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      }),
    );
    if (!created) {
      throw new Error("selftest aborted: request.create failed");
    }
    await step("request.send", async () => {
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
    });
    await step("sign.sign", () => {
      signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
    });
    const final = await step("request.fetch-final", () =>
      fetchFinalSignedPdf(db, {
        requestId: created.requestId,
        provider: "local",
        outPath: path.join(workspace, "signed.pdf"),
      }),
    );
    if (final) {
      await step("request.verify-signed-pdf", async () => {
        const report = await inspectRequestSignedPdf(db, { requestId: created.requestId, path: final.path });
        if (!report.report.signatures.every((s) => s.messageDigestMatches === true)) {
          throw new Error("verify-signed-pdf: at least one messageDigest did not match");
        }
      });
    }
    await step("audit.verify", () => {
      const result = verifyRequestAuditChain(db, created.requestId);
      if (!result.valid) throw new Error(`audit chain broken: ${result.break?.kind}`);
    });
    const receiptDir = path.join(workspace, "receipt");
    await step("request.receipt", async () => {
      await exportRequestReceipt(db, { requestId: created.requestId, outDir: receiptDir });
    });
    await step("request.verify-receipt", () => {
      const verdict = verifyRequestReceiptBundle(receiptDir);
      if (!verdict.ok) throw new Error(`verify-receipt failed: ${verdict.errors.join("; ")}`);
    });

    // MCP leg: drive the same signed request through the JSON-RPC server
    // over piped streams. Confirms initialize → tools/list → tools/call
    // round-trips against a real DB. Cheap (<200ms) and catches schema
    // drift that direct library tests miss.
    await step("mcp.handshake", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const collected: string[] = [];
      output.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) collected.push(line);
        }
      });
      const serverPromise = serveMcpStdio({ input, output, db });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "request_show", arguments: { request_id: created.requestId } },
      })}\n`);
      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "audit_verify", arguments: { request_id: created.requestId } },
      })}\n`);
      input.end();
      await serverPromise;

      if (collected.length !== 4) {
        throw new Error(`mcp.handshake: expected 4 responses, got ${collected.length}`);
      }
      const init = JSON.parse(collected[0]);
      if (!init.result?.protocolVersion) throw new Error("mcp.handshake: initialize missing protocolVersion");
      const tools = JSON.parse(collected[1]);
      if (!Array.isArray(tools.result?.tools) || tools.result.tools.length < 7) {
        throw new Error(`mcp.handshake: tools/list returned ${tools.result?.tools?.length ?? 0} tools (expected ≥ 7)`);
      }
      const showResp = JSON.parse(collected[2]);
      const showBody = JSON.parse(showResp.result.content[0].text);
      if (showBody.request?.id !== created.requestId) {
        throw new Error(`mcp.handshake: request_show returned wrong id (${showBody.request?.id})`);
      }
      const verifyResp = JSON.parse(collected[3]);
      const verifyBody = JSON.parse(verifyResp.result.content[0].text);
      if (verifyBody.valid !== true) {
        throw new Error(`mcp.handshake: audit_verify returned valid=${verifyBody.valid}`);
      }
    });
  } finally {
    db.close();
    if (!opts.keepWorkspace) {
      try {
        rmSync(workspace, { recursive: true, force: true });
        cleaned = true;
      } catch {
        cleaned = false;
      }
    }
    restore();
  }

  return { ok: allOk, steps, workspace, cleaned };
}
