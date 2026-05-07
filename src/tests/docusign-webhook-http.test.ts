import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleDocuSignWebhookHttpRequest } from "../lib/webhook-http.js";
import {
  createSigningRequest,
  getRequestSnapshot,
  listSignerSigningStates,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

function buildHttpFakes(rawBody: string, headers: Record<string, string>): {
  incomingRequest: any;
  response: any;
  body: () => string;
  status: () => number;
} {
  const incomingRequest = {
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(rawBody);
    },
  };
  const headersOut = new Map<string, string>();
  let bodyOut = "";
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headersOut.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      bodyOut = chunk ?? "";
    },
  };
  return { incomingRequest, response, body: () => bodyOut, status: () => response.statusCode };
}

test("handleDocuSignWebhookHttpRequest verifies HMAC and ingests signers (X-DocuSign-Signature-1 base64)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-docusign-http-"));
  const documentPath = makeFixturePdf(dir);
  const secret = "ds-http-secret";
  try {
    const created = createSigningRequest(db, {
      title: "DocuSign HTTP",
      documentPath,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      tokenTtlMinutes: 60,
      provider: "docusign",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    db.prepare("UPDATE requests SET status = ?, provider_request_id = ? WHERE id = ?")
      .run("sent", "env-http-1", created.requestId);

    const payload = {
      event: "envelope-completed",
      data: {
        envelopeId: "env-http-1",
        envelopeSummary: {
          envelopeId: "env-http-1",
          status: "completed",
          envelopeMetadata: { request_id: created.requestId },
          recipients: {
            signers: [
              { email: "alice@example.com", name: "Alice", status: "completed", signedDateTime: "2026-05-01T10:00:00Z" },
              { email: "bob@example.com", name: "Bob", status: "sent", signedDateTime: null },
            ],
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("base64");

    const { incomingRequest, response, body, status } = buildHttpFakes(rawBody, {
      "content-type": "application/json",
      "x-docusign-signature-1": sig,
    });
    db.close(); // handler reopens via dbPath
    await handleDocuSignWebhookHttpRequest(incomingRequest, response, { dbPath, secret });

    const reopened = createDb(dbPath);
    try {
      const parsed = JSON.parse(body());
      assert.equal(status(), 200);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.requestId, created.requestId);

      const states = listSignerSigningStates(reopened, created.requestId);
      assert.equal(states.length, 1);
      assert.equal(states[0].email, "alice@example.com");
      assert.equal(states[0].source, "docusign");

      const snap = getRequestSnapshot(reopened, created.requestId);
      assert.equal(snap.signedBy?.[0].source, "docusign");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("handleDocuSignWebhookHttpRequest returns 401 with no state writes when HMAC is wrong", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-docusign-http-bad-"));
  const documentPath = makeFixturePdf(dir);
  try {
    const created = createSigningRequest(db, {
      title: "DocuSign HTTP bad",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "docusign",
      autoApprove: true,
    });
    db.close();

    const payload = {
      event: "envelope-completed",
      data: {
        envelopeSummary: {
          envelopeId: "env-bad",
          status: "completed",
          envelopeMetadata: { request_id: created.requestId },
          recipients: { signers: [{ email: "alice@example.com", name: "Alice", signedDateTime: "2026-05-01T10:00:00Z" }] },
        },
      },
    };
    const rawBody = JSON.stringify(payload);

    const { incomingRequest, response, body, status } = buildHttpFakes(rawBody, {
      "content-type": "application/json",
      "x-docusign-signature-1": "wrong-sig",
    });
    await handleDocuSignWebhookHttpRequest(incomingRequest, response, { dbPath, secret: "right-secret" });

    const parsed = JSON.parse(body());
    assert.equal(status(), 401);
    assert.equal(parsed.ok, false);

    const reopened = createDb(dbPath);
    try {
      const states = listSignerSigningStates(reopened, created.requestId);
      assert.equal(states.length, 0, "401 must not write signing-state rows");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("handleDocuSignWebhookHttpRequest accepts any of -1/-2/-3 signature header slots", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-docusign-http-rotate-"));
  const documentPath = makeFixturePdf(dir);
  const secret = "rotate-secret";
  try {
    const created = createSigningRequest(db, {
      title: "DocuSign rotate",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "docusign",
      autoApprove: true,
    });
    db.close();

    const payload = {
      event: "envelope-completed",
      data: {
        envelopeSummary: {
          envelopeId: "env-rotate",
          status: "completed",
          envelopeMetadata: { request_id: created.requestId },
          recipients: { signers: [{ email: "alice@example.com", name: "Alice", signedDateTime: "2026-05-01T10:00:00Z" }] },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("base64");

    // Put the right signature in slot -3, with garbage in -1 and -2.
    const { incomingRequest, response, status } = buildHttpFakes(rawBody, {
      "content-type": "application/json",
      "x-docusign-signature-1": "stale-key-1",
      "x-docusign-signature-2": "stale-key-2",
      "x-docusign-signature-3": sig,
    });
    await handleDocuSignWebhookHttpRequest(incomingRequest, response, { dbPath, secret });
    assert.equal(status(), 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});
