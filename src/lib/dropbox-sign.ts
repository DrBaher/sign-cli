import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseBooleanFlag } from "./util.js";
import type { SignerInput } from "./util.js";

export type DropboxSendInput = {
  apiKey: string;
  documentPath: string;
  title: string;
  signers: SignerInput[];
  metadata: Record<string, string>;
  testMode: boolean;
};

export function requireDropboxApiKey(): string {
  const apiKey = process.env.DROPBOX_SIGN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "DROPBOX_SIGN_API_KEY is not set. `sign request send` and `sign request status` require a Dropbox Sign API key.",
    );
  }
  return apiKey;
}

export function resolveDropboxTestMode(flag?: string): boolean {
  return parseBooleanFlag(flag ?? process.env.DROPBOX_SIGN_TEST_MODE, true);
}

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function readJsonSafe(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function sendSignatureRequest(input: DropboxSendInput): Promise<{
  signatureRequestId: string;
  statusCode: number | null;
  responseBody: unknown;
}> {
  const fileBuffer = await readFile(path.resolve(input.documentPath));
  const form = new FormData();
  form.set("title", input.title);
  form.set("subject", input.title);
  form.set("message", `Please sign: ${input.title}`);
  form.set("test_mode", input.testMode ? "1" : "0");

  input.signers
    .sort((left, right) => left.order - right.order)
    .forEach((signer, index) => {
      form.set(`signers[${index}][name]`, signer.name);
      form.set(`signers[${index}][email_address]`, signer.email);
      form.set(`signers[${index}][order]`, String(signer.order));
    });

  Object.entries(input.metadata).forEach(([k, v]) => {
    form.set(`metadata[${k}]`, v);
  });

  form.set("files[0]", new Blob([fileBuffer], { type: "application/pdf" }), path.basename(input.documentPath));

  const response = await fetch("https://api.hellosign.com/v3/signature_request/send", {
    method: "POST",
    headers: { Authorization: authHeader(input.apiKey) },
    body: form,
  });

  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox Sign send failed: ${detail}`);
  }

  const signatureRequest = body?.signature_request ?? body?.signatureRequest ?? null;
  const signatureRequestId = signatureRequest?.signature_request_id ?? signatureRequest?.signatureRequestId;

  if (!signatureRequestId) {
    throw new Error("Dropbox Sign send completed without returning a signature request ID.");
  }

  return {
    signatureRequestId,
    statusCode: response.status,
    responseBody: body,
  };
}

export async function fetchSignatureRequestStatus(apiKey: string, signatureRequestId: string): Promise<unknown> {
  const response = await fetch(`https://api.hellosign.com/v3/signature_request/${signatureRequestId}`, {
    method: "GET",
    headers: {
      Authorization: authHeader(apiKey),
      Accept: "application/json",
    },
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox Sign status fetch failed: ${detail}`);
  }
  return body;
}
