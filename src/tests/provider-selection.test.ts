import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderStatus, resolveWatchTerminalStatus } from "../lib/signing-service.js";
import { resolveSignProvider } from "../lib/providers.js";

test("resolveSignProvider defaults to dropbox", () => {
  const original = process.env.SIGN_PROVIDER;
  delete process.env.SIGN_PROVIDER;

  try {
    assert.equal(resolveSignProvider(), "dropbox");
  } finally {
    if (original === undefined) {
      delete process.env.SIGN_PROVIDER;
    } else {
      process.env.SIGN_PROVIDER = original;
    }
  }
});

test("resolveSignProvider prefers explicit flag over env", () => {
  const original = process.env.SIGN_PROVIDER;
  process.env.SIGN_PROVIDER = "dropbox";

  try {
    assert.equal(resolveSignProvider("docusign"), "docusign");
  } finally {
    if (original === undefined) {
      delete process.env.SIGN_PROVIDER;
    } else {
      process.env.SIGN_PROVIDER = original;
    }
  }
});

test("normalizeProviderStatus handles Dropbox and DocuSign payloads", () => {
  assert.equal(normalizeProviderStatus("dropbox", {
    signature_request: {
      status_code: "sent",
      is_complete: false,
    },
  }), "sent");

  assert.equal(normalizeProviderStatus("docusign", {
    status: "completed",
  }), "completed");
});

test("resolveWatchTerminalStatus normalizes shared terminal states", () => {
  assert.equal(resolveWatchTerminalStatus("completed"), "completed");
  assert.equal(resolveWatchTerminalStatus("voided"), "declined");
  assert.equal(resolveWatchTerminalStatus("failed"), "error");
});
