import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchMcp } from "../lib/mcp-server.js";
import { getMcpPrompt, listMcpPrompts } from "../lib/mcp-prompts.js";
import { SignCliError } from "../lib/sign-error.js";
import { createSigningRequest, sendSigningRequest } from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-prompts-"));
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

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

test("listMcpPrompts returns the canonical agent-as-signer prompts", () => {
  const list = listMcpPrompts();
  const names = list.map((p) => p.name).sort();
  assert.deepEqual(names, ["inbox_triage", "policy_check", "review_and_sign", "verify_receipt"]);
  // Every prompt has a description and (where declared) arguments are well-shaped.
  for (const prompt of list) {
    assert.equal(typeof prompt.description, "string");
    if (prompt.arguments) {
      for (const a of prompt.arguments) {
        assert.equal(typeof a.name, "string");
        assert.equal(typeof a.description, "string");
      }
    }
  }
});

test("getMcpPrompt fills argument placeholders into the message text", () => {
  const result = getMcpPrompt({
    name: "review_and_sign",
    arguments: {
      request_id: "req_xyz",
      token: "alice-tok-123",
      expected_title_pattern: "^Mutual NDA$",
      expected_sha256: "abc123",
    },
  });
  assert.equal(result.messages.length, 1);
  const text = result.messages[0].content.text;
  assert.match(text, /req_xyz/);
  assert.match(text, /alice-tok-123/);
  assert.match(text, /\^Mutual NDA\$/);
  assert.match(text, /abc123/);
});

test("getMcpPrompt rejects missing required arguments with INVALID_ARGS", () => {
  assert.throws(
    () => getMcpPrompt({ name: "review_and_sign", arguments: { token: "x" } }),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
  );
});

test("getMcpPrompt rejects unknown prompt names", () => {
  assert.throws(
    () => getMcpPrompt({ name: "no_such_prompt" }),
    (err: unknown) => err instanceof SignCliError && err.code === "UNKNOWN_RESOURCE",
  );
});

test("dispatchMcp prompts/list + prompts/get integrate with the server", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup: dbCleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-prompts-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Prompt smoke",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });

      const init = await dispatchMcp({ method: "initialize", db });
      const initValue = (init as { kind: "result"; value: any }).value;
      assert.ok(initValue.capabilities.prompts, "initialize must advertise prompts capability");

      const list = await dispatchMcp({ method: "prompts/list", db });
      const listValue = (list as { kind: "result"; value: any }).value;
      const names = (listValue.prompts as Array<{ name: string }>).map((p) => p.name);
      assert.ok(names.includes("review_and_sign"));

      const get = await dispatchMcp({
        method: "prompts/get",
        params: {
          name: "review_and_sign",
          arguments: { request_id: created.requestId, token: created.tokens[0].token },
        },
        db,
      });
      const getValue = (get as { kind: "result"; value: any }).value;
      assert.equal(getValue.messages.length, 1);
      assert.match(getValue.messages[0].content.text, new RegExp(created.requestId));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      dbCleanup();
    }
  });
});

test("dispatchMcp prompts/get errors on missing name or unknown prompt", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    try {
      await assert.rejects(
        dispatchMcp({ method: "prompts/get", params: {}, db }),
        /requires a string `name`/,
      );
      await assert.rejects(
        dispatchMcp({ method: "prompts/get", params: { name: "no_such" }, db }),
        /Unknown MCP prompt/,
      );
    } finally {
      db.close();
      cleanup();
    }
  });
});
