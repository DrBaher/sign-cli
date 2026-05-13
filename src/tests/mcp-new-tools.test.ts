// Coverage for the MCP tools added on 2026-05-13: pdf_detect_signature_field,
// pdf_detect_date_field, profile_list, profile_show, pdf_stamp_text, preview,
// document. The CLI handlers they wrap have their own unit tests; these
// exercise the wiring (handler bindings, validateOutputPath integration,
// SignCliError shape on bad inputs).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchMcp, listMcpTools } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PDF = path.resolve(__dirname, "../../fixtures/canonical-unsigned-v1.pdf");

function parseEnvelope(value: any): any {
  return JSON.parse(value.content[0].text);
}

test("listMcpTools exposes the new 2026-05-13 surfaces", () => {
  const names = listMcpTools().map((t) => t.name);
  for (const expected of [
    "pdf_detect_signature_field",
    "pdf_detect_date_field",
    "profile_list",
    "profile_show",
    "pdf_stamp_text",
    "preview",
    "document",
  ]) {
    assert.ok(names.includes(expected), `Missing MCP tool: ${expected}`);
  }
});

test("pdf_detect_signature_field returns candidates with category=signature", async () => {
  if (!existsSync(FIXTURE_PDF)) return; // skip if fixture missing in worktree
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "pdf_detect_signature_field", arguments: { pdf_path: FIXTURE_PDF } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.notEqual(value.isError, true);
    const payload = parseEnvelope(value);
    assert.equal(typeof payload.pageCount, "number");
    assert.ok(Array.isArray(payload.candidates));
    for (const c of payload.candidates) {
      assert.equal(c.category, "signature");
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("pdf_detect_date_field projects date candidates only", async () => {
  if (!existsSync(FIXTURE_PDF)) return;
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "pdf_detect_date_field", arguments: { pdf_path: FIXTURE_PDF } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.notEqual(value.isError, true);
    const payload = parseEnvelope(value);
    for (const c of payload.candidates) {
      assert.equal(c.category, "date");
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("profile_list returns userFilePath + profile list even when file is missing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-profile-list-"));
  const previousProfilesFile = process.env.SIGN_PROFILES_FILE;
  process.env.SIGN_PROFILES_FILE = path.join(dir, "profiles.json"); // intentionally missing
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "profile_list", arguments: {} },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.notEqual(value.isError, true);
    const payload = parseEnvelope(value);
    assert.equal(typeof payload.userFilePath, "string");
    assert.deepEqual(payload.profiles, []);
    assert.equal(payload.defaultProfile, null);
  } finally {
    db.close();
    cleanup();
    if (previousProfilesFile === undefined) delete process.env.SIGN_PROFILES_FILE;
    else process.env.SIGN_PROFILES_FILE = previousProfilesFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile_show by name redacts credentials by default", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-profile-show-"));
  const profilesPath = path.join(dir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify(
      {
        version: 1,
        defaultProfile: "main",
        profiles: {
          main: {
            version: 1,
            provider: "dropbox",
            credentials: { DROPBOX_SIGN_API_KEY: "supersecret-shhh" },
          },
        },
      },
      null,
      2,
    ),
  );
  const previousProfilesFile = process.env.SIGN_PROFILES_FILE;
  process.env.SIGN_PROFILES_FILE = profilesPath;
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "profile_show", arguments: { name: "main" } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.notEqual(value.isError, true);
    const text = value.content[0].text;
    assert.ok(!text.includes("supersecret-shhh"), "raw secret leaked when show_secrets=false");
    const payload = parseEnvelope(value);
    assert.equal(payload.name, "main");

    const dispatchSecret = await dispatchMcp({
      method: "tools/call",
      params: { name: "profile_show", arguments: { name: "main", show_secrets: true } },
      db,
    });
    const secretValue = (dispatchSecret as { kind: "result"; value: any }).value;
    assert.ok(secretValue.content[0].text.includes("supersecret-shhh"), "show_secrets=true should reveal");
  } finally {
    db.close();
    cleanup();
    if (previousProfilesFile === undefined) delete process.env.SIGN_PROFILES_FILE;
    else process.env.SIGN_PROFILES_FILE = previousProfilesFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview rejects when neither signature_image nor name_signature is given", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "preview", arguments: { pdf_path: "x.pdf", out_path: "o.pdf" } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.equal(value.isError, true);
    const envelope = parseEnvelope(value);
    assert.equal(envelope.error.code, "MISSING_FLAG");
  } finally {
    db.close();
    cleanup();
  }
});

test("preview rejects when both signature_image and name_signature are given", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "preview", arguments: {
        pdf_path: "x.pdf", out_path: "o.pdf",
        signature_image: "s.png", name_signature: "Alice",
      } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.equal(value.isError, true);
    const envelope = parseEnvelope(value);
    assert.equal(envelope.error.code, "SIGN_VISIBLE_SIG_BOTH");
  } finally {
    db.close();
    cleanup();
  }
});

test("pdf_stamp_text rejects unsafe absolute out_path without SIGN_ALLOW_ABSOLUTE_DOCS", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "pdf_stamp_text", arguments: {
        pdf_path: "x.pdf", text: "2026-05-13", out_path: "/etc/sign-out.pdf",
      } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.equal(value.isError, true);
    const envelope = parseEnvelope(value);
    assert.match(envelope.error.message, /escapes the working directory/);
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    db.close();
    cleanup();
  }
});

test("document rejects missing required signer_name", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "document", arguments: { input_path: "x.pdf", out_path: "out.pdf" } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.equal(value.isError, true);
    const envelope = parseEnvelope(value);
    assert.equal(envelope.error.code, "INVALID_ARGS");
  } finally {
    db.close();
    cleanup();
  }
});
