import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectInitAnswers, writeEnvFile, type WizardIo } from "../lib/init-wizard.js";

function scriptedIo(answers: string[]): { io: WizardIo; logs: string[] } {
  const queue = [...answers];
  const logs: string[] = [];
  return {
    logs,
    io: {
      prompt: async () => queue.shift() ?? "",
      log: (line) => logs.push(line),
    },
  };
}

test("collectInitAnswers gathers Dropbox provider answers", async () => {
  const { io } = scriptedIo(["1", "dbx_key", "true", ""]);
  const answers = await collectInitAnswers(io);
  assert.equal(answers.provider, "dropbox");
  assert.equal(answers.values.SIGN_PROVIDER, "dropbox");
  assert.equal(answers.values.DROPBOX_SIGN_API_KEY, "dbx_key");
  assert.equal(answers.values.DROPBOX_SIGN_TEST_MODE, "true");
  assert.equal(answers.values.DROPBOX_SIGN_CLIENT_ID, "");
});

test("writeEnvFile writes new keys and preserves existing unrelated keys", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-init-"));
  const envPath = path.join(dir, ".env");
  writeFileSync(envPath, "EXISTING_KEY=keep\nDROPBOX_SIGN_API_KEY=old\n", "utf8");
  try {
    const result = writeEnvFile({
      provider: "dropbox",
      values: {
        SIGN_PROVIDER: "dropbox",
        DROPBOX_SIGN_API_KEY: "new",
      },
    }, { path: envPath });
    assert.equal(result.envPath, envPath);
    assert.ok(existsSync(envPath));
    const contents = readFileSync(envPath, "utf8");
    assert.match(contents, /EXISTING_KEY=keep/);
    assert.match(contents, /DROPBOX_SIGN_API_KEY=new/);
    assert.match(contents, /SIGN_PROVIDER=dropbox/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectInitAnswers re-prompts on bad provider input", async () => {
  const { io } = scriptedIo(["wat", "signwell", "sw_key", "https://example.com/api/v1", "true", ""]);
  const answers = await collectInitAnswers(io);
  assert.equal(answers.provider, "signwell");
  assert.equal(answers.values.SIGNWELL_API_KEY, "sw_key");
});
