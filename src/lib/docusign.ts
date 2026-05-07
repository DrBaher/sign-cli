import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { retryFetch } from "./http.js";
import type { SignerInput } from "./util.js";

export type DocuSignSendInput = {
  documentPath: string;
  documentPaths?: string[];
  title: string;
  signers: SignerInput[];
  metadata: Record<string, string>;
  embeddedSigning?: boolean;
};

type DocuSignConfig = {
  integrationKey: string;
  userId: string;
  accountId: string;
  basePath: string;
  privateKeyPath: string;
};

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function readJsonSafe(response: Response): Promise<any> {
  return response.text().then((text) => {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  });
}

function normalizeBasePath(rawBasePath: string): string {
  return rawBasePath.trim().replace(/\/+$/u, "");
}

function resolveAuthHost(basePath: string): string {
  const hostname = new URL(basePath).hostname.toLowerCase();
  return hostname.includes("demo") ? "account-d.docusign.com" : "account.docusign.com";
}

export function requireDocuSignConfig(): DocuSignConfig {
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY?.trim();
  const userId = process.env.DOCUSIGN_USER_ID?.trim();
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID?.trim();
  const basePath = process.env.DOCUSIGN_BASE_PATH?.trim();
  const privateKeyPath = process.env.DOCUSIGN_PRIVATE_KEY_PATH?.trim();

  if (!integrationKey) {
    throw new Error("DOCUSIGN_INTEGRATION_KEY is not set.");
  }
  if (!userId) {
    throw new Error("DOCUSIGN_USER_ID is not set.");
  }
  if (!accountId) {
    throw new Error("DOCUSIGN_ACCOUNT_ID is not set.");
  }
  if (!basePath) {
    throw new Error("DOCUSIGN_BASE_PATH is not set.");
  }
  if (!privateKeyPath) {
    throw new Error("DOCUSIGN_PRIVATE_KEY_PATH is not set.");
  }

  return {
    integrationKey,
    userId,
    accountId,
    basePath: normalizeBasePath(basePath),
    privateKeyPath: path.resolve(privateKeyPath),
  };
}

async function createJwtBearerAssertion(config: DocuSignConfig): Promise<{ assertion: string; authHost: string }> {
  const authHost = resolveAuthHost(config.basePath);
  const privateKeyPem = await readFile(config.privateKeyPath, "utf8");
  const key = createPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: config.integrationKey,
    sub: config.userId,
    aud: authHost,
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key);
  return {
    assertion: `${signingInput}.${base64UrlEncode(signature)}`,
    authHost,
  };
}

async function getAccessToken(config: DocuSignConfig): Promise<string> {
  const { assertion, authHost } = await createJwtBearerAssertion(config);
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await retryFetch(`https://${authHost}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.error_description ?? body?.error ?? body?.raw ?? response.statusText;
    throw new Error(`DocuSign auth failed: ${detail}`);
  }
  const token = body?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("DocuSign auth completed without an access token.");
  }
  return token;
}

async function docusignJsonRequest(
  config: DocuSignConfig,
  init: { method: string; endpoint: string; body?: unknown; accept?: string },
): Promise<any> {
  const accessToken = await getAccessToken(config);
  const response = await retryFetch(`${config.basePath}/v2.1/accounts/${config.accountId}${init.endpoint}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: init.accept ?? "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const detail = body?.message ?? body?.errorCode ?? body?.raw ?? response.statusText;
    throw new Error(`DocuSign request failed: ${detail}`);
  }
  return body;
}

function buildSignerTabs(index: number): { signHereTabs: Array<Record<string, string>> } {
  return {
    signHereTabs: [
      {
        documentId: "1",
        pageNumber: "1",
        xPosition: String(72 + (index % 2) * 180),
        yPosition: String(120 + index * 80),
      },
    ],
  };
}

function extractRecipientIds(envelopeSummary: any): string[] {
  return Array.isArray(envelopeSummary?.recipientIds)
    ? envelopeSummary.recipientIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : [];
}

export async function sendDocuSignEnvelope(input: DocuSignSendInput): Promise<{
  envelopeId: string;
  recipientIds: string[];
  responseBody: unknown;
}> {
  const config = requireDocuSignConfig();
  const allPaths = (input.documentPaths && input.documentPaths.length > 0)
    ? input.documentPaths
    : [input.documentPath];
  const documents = allPaths.map((rawPath, index) => {
    const resolved = path.resolve(rawPath);
    const buffer = readFileSync(resolved);
    return {
      documentBase64: buffer.toString("base64"),
      name: path.basename(resolved),
      fileExtension: path.extname(resolved).replace(/^\./u, "") || "pdf",
      documentId: String(index + 1),
    };
  });
  const body = await docusignJsonRequest(config, {
    method: "POST",
    endpoint: "/envelopes",
    body: {
      emailSubject: input.title,
      status: "sent",
      documents,
      recipients: {
        signers: input.signers
          .slice()
          .sort((left, right) => left.order - right.order)
          .map((signer, index) => ({
            name: signer.name,
            email: signer.email,
            recipientId: String(index + 1),
            routingOrder: String(signer.order),
            tabs: buildSignerTabs(index),
            ...(input.embeddedSigning ? { clientUserId: signer.email } : {}),
          })),
      },
      customFields: {
        textCustomFields: Object.entries(input.metadata).map(([name, value]) => ({
          name,
          value,
          required: "false",
          show: "false",
        })),
      },
    },
  });

  const envelopeId = body?.envelopeId;
  if (typeof envelopeId !== "string" || envelopeId.length === 0) {
    throw new Error("DocuSign send completed without an envelopeId.");
  }

  return {
    envelopeId,
    recipientIds: extractRecipientIds(body),
    responseBody: body,
  };
}

export async function fetchDocuSignEnvelopeStatus(envelopeId: string): Promise<unknown> {
  const config = requireDocuSignConfig();
  return docusignJsonRequest(config, {
    method: "GET",
    endpoint: `/envelopes/${envelopeId}`,
  });
}

export function normalizeDocuSignStatus(remoteStatus: unknown): string {
  const remote = remoteStatus as Record<string, unknown> | null;
  const status = remote?.status;
  return typeof status === "string" && status.length > 0 ? status.toLowerCase() : "unknown";
}

export async function downloadDocuSignCombinedPdf(envelopeId: string): Promise<Buffer> {
  const config = requireDocuSignConfig();
  const accessToken = await getAccessToken(config);
  const response = await retryFetch(`${config.basePath}/v2.1/accounts/${config.accountId}/envelopes/${envelopeId}/documents/combined`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/pdf",
    },
  });
  if (!response.ok) {
    const body = await readJsonSafe(response);
    const detail = body?.message ?? body?.errorCode ?? body?.raw ?? response.statusText;
    throw new Error(`DocuSign PDF download failed: ${detail}`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}


export async function getDocuSignRecipientView(input: {
  envelopeId: string;
  signerEmail: string;
  signerName: string;
  recipientId: string;
  returnUrl: string;
  authenticationMethod?: string;
}): Promise<{ url: string; responseBody: unknown }> {
  const config = requireDocuSignConfig();
  const body = await docusignJsonRequest(config, {
    method: "POST",
    endpoint: `/envelopes/${input.envelopeId}/views/recipient`,
    body: {
      returnUrl: input.returnUrl,
      authenticationMethod: input.authenticationMethod ?? "none",
      email: input.signerEmail,
      userName: input.signerName,
      clientUserId: input.signerEmail,
      recipientId: input.recipientId,
    },
  });
  if (typeof body?.url !== "string" || body.url.length === 0) {
    throw new Error("DocuSign recipient view did not return a url.");
  }
  return { url: body.url, responseBody: body };
}

export async function remindDocuSignEnvelope(envelopeId: string): Promise<unknown> {
  const config = requireDocuSignConfig();
  return docusignJsonRequest(config, {
    method: "PUT",
    endpoint: `/envelopes/${envelopeId}/notification`,
    body: {
      useAccountDefaults: false,
      reminders: {
        reminderEnabled: "true",
        reminderDelay: "0",
        reminderFrequency: "1",
      },
    },
  });
}

export async function voidDocuSignEnvelope(envelopeId: string, reason: string): Promise<unknown> {
  const config = requireDocuSignConfig();
  return docusignJsonRequest(config, {
    method: "PUT",
    endpoint: `/envelopes/${envelopeId}`,
    body: { status: "voided", voidedReason: reason },
  });
}

export async function checkDocuSignAccountAccess(): Promise<{
  accountId: string;
  basePath: string;
  accountName: string | null;
  isDefault: boolean | null;
  canCreateEnvelope: boolean;
}> {
  const config = requireDocuSignConfig();
  const account = await docusignJsonRequest(config, {
    method: "GET",
    endpoint: "",
  });

  return {
    accountId: config.accountId,
    basePath: config.basePath,
    accountName: typeof account?.accountName === "string" ? account.accountName : null,
    isDefault: typeof account?.isDefault === "string"
      ? account.isDefault.toLowerCase() === "true"
      : typeof account?.isDefault === "boolean"
        ? account.isDefault
        : null,
    canCreateEnvelope: true,
  };
}
