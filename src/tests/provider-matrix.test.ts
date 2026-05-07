import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderMatrix } from "../lib/signing-service.js";

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const ENV_KEYS = [
  "DROPBOX_SIGN_API_KEY",
  "DROPBOX_SIGN_CLIENT_ID",
  "DROPBOX_SIGN_TEST_MODE",
  "SIGNWELL_API_KEY",
  "SIGNWELL_BASE_URL",
  "SIGNWELL_TEST_MODE",
  "SIGNWELL_WEBHOOK_SECRET",
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_USER_ID",
  "DOCUSIGN_ACCOUNT_ID",
  "DOCUSIGN_BASE_PATH",
  "DOCUSIGN_PRIVATE_KEY_PATH",
];

test("buildProviderMatrix reports configured providers based on env", () => {
  const snapshot = snapshotEnv(ENV_KEYS);
  try {
    for (const key of ENV_KEYS) delete process.env[key];

    const empty = buildProviderMatrix();
    const dropbox = empty.find((entry) => entry.provider === "dropbox")!;
    const docusign = empty.find((entry) => entry.provider === "docusign")!;
    const signwell = empty.find((entry) => entry.provider === "signwell")!;

    assert.equal(dropbox.config.configured, false);
    assert.deepEqual(dropbox.config.missing, ["DROPBOX_SIGN_API_KEY"]);
    assert.equal(docusign.config.configured, false);
    assert.equal(docusign.config.missing.length, 5);
    assert.equal(signwell.config.configured, false);
    assert.deepEqual(signwell.config.missing, ["SIGNWELL_API_KEY"]);

    process.env.DROPBOX_SIGN_API_KEY = "k";
    process.env.SIGNWELL_API_KEY = "s";
    process.env.SIGNWELL_WEBHOOK_SECRET = "w";

    const populated = buildProviderMatrix();
    assert.equal(populated.find((p) => p.provider === "dropbox")!.config.configured, true);
    assert.equal(populated.find((p) => p.provider === "signwell")!.config.configured, true);
    assert.equal(populated.find((p) => p.provider === "signwell")!.config.detected.SIGNWELL_WEBHOOK_SECRET, true);
  } finally {
    restoreEnv(snapshot);
  }
});

test("buildProviderMatrix reports capabilities expected by the README", () => {
  const matrix = buildProviderMatrix();
  const dropbox = matrix.find((p) => p.provider === "dropbox")!;
  const docusign = matrix.find((p) => p.provider === "docusign")!;
  const signwell = matrix.find((p) => p.provider === "signwell")!;

  assert.equal(dropbox.capabilities.embeddedSigning, true);
  assert.equal(dropbox.capabilities.webhooks, true);

  assert.equal(docusign.capabilities.embeddedSigning, false);
  assert.equal(docusign.capabilities.webhooks, false);
  assert.equal(docusign.capabilities.finalPdfDownload, true);

  assert.equal(signwell.capabilities.embeddedSigning, true);
  assert.equal(signwell.capabilities.webhooks, true);
  assert.equal(signwell.capabilities.testMode, true);
});
