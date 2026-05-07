import { readFile } from "node:fs/promises";
import path from "node:path";
import { retryFetch } from "./http.js";
import { parseBooleanFlag } from "./util.js";
import type { SignerInput } from "./util.js";

export const SIGNWELL_DEFAULT_BASE_URL = "https://www.signwell.com/api/v1";

export type SignWellSendInput = {
  apiKey: string;
  baseUrl?: string;
  documentPath: string;
  title: string;
  signers: SignerInput[];
  metadata: Record<string, string>;
  testMode: boolean;
  embeddedSigning?: boolean;
};

function readJsonSafe(response: Response): Promise<any> {
  return response.text().then((text) => {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  });
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.trim().replace(/\/+$/u, "");
}

function signWellHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": apiKey,
  };
}

function normalizeErrorDetail(body: any, fallback: string): string {
  if (body?.errors && typeof body.errors === "object") {
    return JSON.stringify(body.errors);
  }
  if (typeof body?.error === "string" && body.error.length > 0) {
    return body.error;
  }
  if (typeof body?.message === "string" && body.message.length > 0) {
    return body.message;
  }
  if (typeof body?.raw === "string" && body.raw.length > 0) {
    return body.raw;
  }
  return fallback;
}

function sortSigners(signers: SignerInput[]): SignerInput[] {
  return signers.slice().sort((left, right) => left.order - right.order);
}

function extractRecipientIds(document: any): string[] {
  return Array.isArray(document?.recipients)
    ? document.recipients
      .map((recipient: any) => recipient?.id)
      .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : [];
}

async function signWellJsonRequest<T>(
  apiKey: string,
  init: {
    method: string;
    endpoint: string;
    baseUrl?: string;
    body?: unknown;
  },
): Promise<T> {
  const response = await retryFetch(`${resolveSignWellBaseUrl(init.baseUrl)}${init.endpoint}`, {
    method: init.method,
    headers: signWellHeaders(apiKey),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    throw new Error(`SignWell request failed: ${normalizeErrorDetail(body, response.statusText)}`);
  }
  return body as T;
}

export function requireSignWellApiKey(): string {
  const apiKey = process.env.SIGNWELL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("SIGNWELL_API_KEY is not set.");
  }
  return apiKey;
}

export function resolveSignWellBaseUrl(rawBaseUrl = process.env.SIGNWELL_BASE_URL): string {
  return normalizeBaseUrl(rawBaseUrl?.trim() || SIGNWELL_DEFAULT_BASE_URL);
}

export function resolveSignWellTestMode(flag?: string): boolean {
  return parseBooleanFlag(flag ?? process.env.SIGNWELL_TEST_MODE, true);
}

export function normalizeSignWellStatus(remoteStatus: unknown): string {
  const remote = remoteStatus as Record<string, unknown> | null;
  const rawStatus = typeof remote?.status === "string" ? remote.status : "unknown";
  return rawStatus.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

export async function sendSignWellDocument(input: SignWellSendInput): Promise<{
  documentId: string;
  recipientIds: string[];
  status: string;
  responseBody: unknown;
}> {
  const documentBuffer = await readFile(path.resolve(input.documentPath));
  const signers = sortSigners(input.signers);
  const body = await signWellJsonRequest<any>(input.apiKey, {
    method: "POST",
    endpoint: "/documents",
    baseUrl: input.baseUrl,
    body: {
      test_mode: input.testMode,
      name: input.title,
      subject: input.title,
      message: `Please sign: ${input.title}`,
      draft: false,
      with_signature_page: true,
      apply_signing_order: signers.length > 1,
      embedded_signing: Boolean(input.embeddedSigning),
      files: [
        {
          name: path.basename(input.documentPath),
          file_base64: documentBuffer.toString("base64"),
        },
      ],
      recipients: signers.map((signer, index) => ({
        id: String(index + 1),
        name: signer.name,
        email: signer.email,
      })),
      metadata: input.metadata,
    },
  });

  if (typeof body?.id !== "string" || body.id.length === 0) {
    throw new Error("SignWell send completed without a document id.");
  }

  return {
    documentId: body.id,
    recipientIds: extractRecipientIds(body),
    status: normalizeSignWellStatus(body),
    responseBody: body,
  };
}

export async function fetchSignWellDocumentStatus(apiKey: string, documentId: string, baseUrl?: string): Promise<unknown> {
  return signWellJsonRequest(apiKey, {
    method: "GET",
    endpoint: `/documents/${documentId}`,
    baseUrl,
  });
}

export function extractSignWellEmbeddedSignUrl(document: any, recipientId: string): { signUrl: string; expiresAt: number | null } | null {
  if (!document || !Array.isArray(document.recipients)) {
    return null;
  }
  const recipient = document.recipients.find((entry: any) => entry?.id === recipientId);
  const signUrl = recipient?.embedded_signing_url
    ?? recipient?.signing_url
    ?? recipient?.embedded_signature_url
    ?? null;
  if (typeof signUrl !== "string" || signUrl.length === 0) {
    return null;
  }
  const expiresRaw = recipient?.embedded_signing_url_expires_at ?? recipient?.embedded_signing_expires_at ?? null;
  const expiresAt = typeof expiresRaw === "number"
    ? expiresRaw
    : typeof expiresRaw === "string" && expiresRaw.length > 0
      ? Date.parse(expiresRaw) || null
      : null;
  return { signUrl, expiresAt };
}

export async function fetchSignWellEmbeddedSignUrl(
  apiKey: string,
  documentId: string,
  recipientId: string,
  baseUrl?: string,
): Promise<{ signUrl: string; expiresAt: number | null; responseBody: unknown }> {
  const document = await signWellJsonRequest<any>(apiKey, {
    method: "GET",
    endpoint: `/documents/${documentId}`,
    baseUrl,
  });
  const extracted = extractSignWellEmbeddedSignUrl(document, recipientId);
  if (!extracted) {
    throw new Error(
      `SignWell document ${documentId} did not return an embedded signing URL for recipient ${recipientId}. ` +
      `Make sure the document was created with --provider signwell send-embedded and that the recipient ID matches.`,
    );
  }
  return { signUrl: extracted.signUrl, expiresAt: extracted.expiresAt, responseBody: document };
}

export async function downloadSignWellCompletedPdf(apiKey: string, documentId: string, baseUrl?: string): Promise<Buffer> {
  const response = await retryFetch(`${resolveSignWellBaseUrl(baseUrl)}/documents/${documentId}/completed_pdf`, {
    method: "GET",
    headers: {
      accept: "application/pdf",
      "x-api-key": apiKey,
    },
  });
  if (!response.ok) {
    const body = await readJsonSafe(response);
    throw new Error(`SignWell PDF download failed: ${normalizeErrorDetail(body, response.statusText)}`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

export async function cancelSignWellDocument(apiKey: string, documentId: string, baseUrl?: string): Promise<unknown> {
  return signWellJsonRequest(apiKey, {
    method: "DELETE",
    endpoint: `/documents/${documentId}`,
    baseUrl,
  });
}

export async function checkSignWellAccount(apiKey: string, baseUrl?: string): Promise<{
  email: string | null;
  name: string | null;
  responseBody: unknown;
}> {
  const body = await signWellJsonRequest<any>(apiKey, {
    method: "GET",
    endpoint: "/me",
    baseUrl,
  });
  return {
    email: typeof body?.email === "string" ? body.email : null,
    name: typeof body?.name === "string" ? body.name : null,
    responseBody: body,
  };
}
