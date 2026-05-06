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

async function loadSdk(): Promise<Record<string, any>> {
  try {
    return (await import("@dropbox/sign")).default as Record<string, any>;
  } catch (error) {
    throw new Error(
      "Dropbox Sign SDK is not installed. Run `npm install` to add @dropbox/sign before using send/status.",
      { cause: error as Error },
    );
  }
}

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

export async function sendSignatureRequest(input: DropboxSendInput): Promise<{
  signatureRequestId: string;
  statusCode: number | null;
  responseBody: unknown;
}> {
  const sdk = await loadSdk();
  const apiClient = new sdk.SignatureRequestApi();
  apiClient.username = input.apiKey;

  const fileBuffer = await readFile(path.resolve(input.documentPath));
  const request = {
    title: input.title,
    subject: input.title,
    message: `Please sign: ${input.title}`,
    signers: input.signers
      .sort((left, right) => left.order - right.order)
      .map((signer) => ({
        name: signer.name,
        emailAddress: signer.email,
        order: signer.order,
      })),
    files: [fileBuffer],
    metadata: input.metadata,
    testMode: input.testMode,
  };

  const response = await apiClient.signatureRequestSend(request);
  const body = response?.body ?? response;
  const signatureRequest =
    body?.signatureRequest ??
    body?.signature_request ??
    body?.signatureRequestResponse ??
    null;
  const signatureRequestId =
    signatureRequest?.signatureRequestId ??
    signatureRequest?.signature_request_id ??
    body?.signatureRequestId ??
    body?.signature_request_id;

  if (!signatureRequestId) {
    throw new Error("Dropbox Sign send completed without returning a signature request ID.");
  }

  return {
    signatureRequestId,
    statusCode: response?.response?.statusCode ?? null,
    responseBody: body,
  };
}

export async function fetchSignatureRequestStatus(apiKey: string, signatureRequestId: string): Promise<unknown> {
  const sdk = await loadSdk();
  const apiClient = new sdk.SignatureRequestApi();
  apiClient.username = apiKey;
  const response = await apiClient.signatureRequestGet(signatureRequestId);
  return response?.body ?? response;
}
