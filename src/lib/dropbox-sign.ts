import { readFile } from "node:fs/promises";
import path from "node:path";
import { retryFetch } from "./http.js";
import { parseBooleanFlag } from "./util.js";
import type { SignerInput } from "./util.js";

export type DropboxSendInput = {
  apiKey: string;
  documentPath: string;
  documentPaths?: string[];
  title: string;
  signers: SignerInput[];
  metadata: Record<string, string>;
  testMode: boolean;
};

function resolveDocumentPaths(input: DropboxSendInput): string[] {
  if (input.documentPaths && input.documentPaths.length > 0) return input.documentPaths;
  return [input.documentPath];
}

async function appendFileFields(form: FormData, paths: string[]): Promise<void> {
  for (let index = 0; index < paths.length; index += 1) {
    const filePath = path.resolve(paths[index]);
    const buffer = await readFile(filePath);
    form.set(`files[${index}]`, new Blob([buffer], { type: "application/pdf" }), path.basename(filePath));
  }
}

export function requireDropboxApiKey(): string {
  const apiKey = process.env.DROPBOX_SIGN_API_KEY?.trim();
  if (!apiKey) throw new Error("DROPBOX_SIGN_API_KEY is not set.");
  return apiKey;
}

export function resolveDropboxTestMode(flag?: string): boolean {
  return parseBooleanFlag(flag ?? process.env.DROPBOX_SIGN_TEST_MODE, true);
}

export function requireDropboxClientId(flag?: string): string {
  const clientId = (flag ?? process.env.DROPBOX_SIGN_CLIENT_ID)?.trim();
  if (!clientId) throw new Error("DROPBOX_SIGN_CLIENT_ID is required for embedded signing.");
  return clientId;
}

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function readJsonSafe(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function addCommonFormFields(form: FormData, input: DropboxSendInput): void {
  form.set("title", input.title);
  form.set("subject", input.title);
  form.set("message", `Please sign: ${input.title}`);
  form.set("test_mode", input.testMode ? "1" : "0");
  input.signers.sort((a,b)=>a.order-b.order).forEach((s,i)=>{
    form.set(`signers[${i}][name]`, s.name);
    form.set(`signers[${i}][email_address]`, s.email);
    form.set(`signers[${i}][order]`, String(s.order));
  });
  Object.entries(input.metadata).forEach(([k,v])=> form.set(`metadata[${k}]`, v));
}

async function postSignatureRequest(endpoint: string, apiKey: string, form: FormData): Promise<any> {
  const response = await retryFetch(`https://api.hellosign.com/v3/${endpoint}`, {
    method: "POST",
    headers: { Authorization: authHeader(apiKey) },
    body: form,
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox Sign request failed: ${detail}`);
  }
  return body;
}

function extractSignatureIds(signatureRequest: any): string[] {
  return Array.isArray(signatureRequest?.signatures)
    ? signatureRequest.signatures.map((signature: any) => signature?.signature_id).filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : [];
}

export async function sendSignatureRequest(input: DropboxSendInput): Promise<{ signatureRequestId: string; signatureIds: string[]; statusCode: number | null; responseBody: unknown; }> {
  const form = new FormData();
  addCommonFormFields(form, input);
  await appendFileFields(form, resolveDocumentPaths(input));
  const body = await postSignatureRequest("signature_request/send", input.apiKey, form);
  const signatureRequest = body?.signature_request ?? body?.signatureRequest ?? null;
  const signatureRequestId = signatureRequest?.signature_request_id ?? signatureRequest?.signatureRequestId;
  if (!signatureRequestId) throw new Error("Dropbox Sign send completed without signature_request_id.");
  return { signatureRequestId, signatureIds: extractSignatureIds(signatureRequest), statusCode: 200, responseBody: body };
}

export async function createEmbeddedSignatureRequest(input: DropboxSendInput & { clientId: string }): Promise<{ signatureRequestId: string; signatureIds: string[]; responseBody: unknown; }> {
  const form = new FormData();
  addCommonFormFields(form, input);
  form.set("client_id", input.clientId);
  await appendFileFields(form, resolveDocumentPaths(input));
  const body = await postSignatureRequest("signature_request/create_embedded", input.apiKey, form);
  const signatureRequest = body?.signature_request ?? null;
  const signatureRequestId = signatureRequest?.signature_request_id;
  const signatureIds = extractSignatureIds(signatureRequest);
  if (!signatureRequestId) throw new Error("Embedded create did not return signature_request_id.");
  return { signatureRequestId, signatureIds, responseBody: body };
}

export async function fetchEmbeddedSignUrl(apiKey: string, signatureId: string): Promise<{ signUrl: string; expiresAt: number | null; responseBody: unknown }> {
  const response = await retryFetch(`https://api.hellosign.com/v3/embedded/sign_url/${signatureId}`, {
    method: "GET",
    headers: { Authorization: authHeader(apiKey), Accept: "application/json" },
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox embedded sign_url failed: ${detail}`);
  }
  const signUrl = body?.embedded?.sign_url;
  if (!signUrl) throw new Error("embedded/sign_url returned no sign_url");
  return { signUrl, expiresAt: body?.embedded?.expires_at ?? null, responseBody: body };
}

export async function fetchSignatureRequestStatus(apiKey: string, signatureRequestId: string): Promise<unknown> {
  const response = await retryFetch(`https://api.hellosign.com/v3/signature_request/${signatureRequestId}`, {
    method: "GET",
    headers: { Authorization: authHeader(apiKey), Accept: "application/json" },
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox Sign status fetch failed: ${detail}`);
  }
  return body;
}


export async function downloadSignedPdf(apiKey: string, signatureRequestId: string): Promise<Buffer> {
  const response = await retryFetch(`https://api.hellosign.com/v3/signature_request/files/${signatureRequestId}?file_type=pdf`, {
    method: "GET",
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!response.ok) {
    const body = await readJsonSafe(response);
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox signed file download failed: ${detail}`);
  }
  const arr = await response.arrayBuffer();
  return Buffer.from(arr);
}

export async function cancelDropboxSignatureRequest(apiKey: string, signatureRequestId: string): Promise<unknown> {
  const response = await retryFetch(`https://api.hellosign.com/v3/signature_request/cancel/${signatureRequestId}`, {
    method: "POST",
    headers: { Authorization: authHeader(apiKey), Accept: "application/json" },
  });
  if (response.status === 200 || response.status === 204) {
    if (response.status === 204) return { ok: true };
    return readJsonSafe(response);
  }
  const body = await readJsonSafe(response);
  const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
  throw new Error(`Dropbox Sign cancel failed: ${detail}`);
}

export async function remindDropboxSignatureRequest(apiKey: string, signatureRequestId: string, email: string): Promise<unknown> {
  const form = new FormData();
  form.set("email_address", email);
  const response = await retryFetch(`https://api.hellosign.com/v3/signature_request/remind/${signatureRequestId}`, {
    method: "POST",
    headers: { Authorization: authHeader(apiKey) },
    body: form,
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox Sign remind failed: ${detail}`);
  }
  return body;
}

export async function checkDropboxAccount(apiKey: string): Promise<{ email: string | null; apiSignatureRequestsLeft: number | null }> {
  const response = await retryFetch("https://api.hellosign.com/v3/account", {
    method: "GET",
    headers: { Authorization: authHeader(apiKey), Accept: "application/json" },
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error?.error_msg ?? body?.error_msg ?? body?.raw ?? response.statusText;
    throw new Error(`Dropbox account check failed: ${detail}`);
  }
  return {
    email: body?.account?.email_address ?? null,
    apiSignatureRequestsLeft: typeof body?.account?.quotas?.api_signature_requests_left === 'number' ? body.account.quotas.api_signature_requests_left : null,
  };
}
