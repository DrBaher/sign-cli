import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchMcp } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

const SECRET = "sk_live_super_secret_provider_key";

function withProfilesFile<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-profiles-"));
  const file = path.join(dir, "profiles.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      defaultProfile: "prod",
      profiles: {
        prod: { version: 1, provider: "signwell", credentials: { SIGNWELL_API_KEY: SECRET } },
      },
    }),
  );
  const prev = process.env.SIGN_PROFILES_FILE;
  process.env.SIGN_PROFILES_FILE = file;
  const restore = () => {
    if (prev === undefined) delete process.env.SIGN_PROFILES_FILE;
    else process.env.SIGN_PROFILES_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  };
  return fn().finally(restore);
}

async function callProfileShow(opts: {
  showSecrets: boolean;
  secretsAllowed?: boolean;
}): Promise<{ text: string; isError?: boolean }> {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "profile_show", arguments: { name: "prod", show_secrets: opts.showSecrets } },
      db,
      secretsAllowed: opts.secretsAllowed,
    });
    const value = result.kind === "result"
      ? (result.value as { content: Array<{ text: string }>; isError?: boolean })
      : null;
    return { text: value!.content[0].text, isError: value!.isError };
  } finally {
    db.close();
    cleanup();
  }
}

test("profile_show show_secrets=true is REFUSED when secretsAllowed is unset (untrusted transport)", async () => {
  await withProfilesFile(async () => {
    const res = await callProfileShow({ showSecrets: true });
    assert.equal(res.isError, true, "must return an error envelope");
    const env = JSON.parse(res.text);
    assert.equal(env.error.code, "FORBIDDEN");
    assert.ok(!res.text.includes(SECRET), "the plaintext secret must NOT appear anywhere in the response");
  });
});

test("profile_show show_secrets=true is REFUSED when secretsAllowed=false", async () => {
  await withProfilesFile(async () => {
    const res = await callProfileShow({ showSecrets: true, secretsAllowed: false });
    assert.equal(res.isError, true);
    const env = JSON.parse(res.text);
    assert.equal(env.error.code, "FORBIDDEN");
    assert.ok(!res.text.includes(SECRET));
  });
});

test("profile_show show_secrets=true is ALLOWED on a trusted transport (secretsAllowed=true)", async () => {
  await withProfilesFile(async () => {
    const res = await callProfileShow({ showSecrets: true, secretsAllowed: true });
    assert.notEqual(res.isError, true);
    assert.ok(res.text.includes(SECRET), "a trusted transport may return the plaintext secret");
  });
});

test("profile_show without show_secrets never returns the plaintext secret regardless of transport", async () => {
  await withProfilesFile(async () => {
    const res = await callProfileShow({ showSecrets: false });
    assert.notEqual(res.isError, true);
    assert.ok(!res.text.includes(SECRET), "redacted view must not leak the secret");
  });
});
