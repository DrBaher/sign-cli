import { readFileSync } from "node:fs";
import path from "node:path";
import { appendAuditEvent, verifyAuditChain } from "./audit.js";
import type { AuditVerificationResult } from "./audit.js";
import {
  checkDocuSignAccountAccess,
  downloadDocuSignCombinedPdf,
  fetchDocuSignEnvelopeStatus,
  normalizeDocuSignStatus,
  sendDocuSignEnvelope,
  voidDocuSignEnvelope,
} from "./docusign.js";
import type { SqliteDb } from "./db.js";
import {
  cancelDropboxSignatureRequest,
  checkDropboxAccount,
  createEmbeddedSignatureRequest,
  downloadSignedPdf,
  fetchEmbeddedSignUrl,
  fetchSignatureRequestStatus,
  sendSignatureRequest,
} from "./dropbox-sign.js";
import {
  cancelSignWellDocument,
  checkSignWellAccount,
  downloadSignWellCompletedPdf,
  fetchSignWellDocumentStatus,
  fetchSignWellEmbeddedSignUrl,
  normalizeSignWellStatus,
  resolveSignWellBaseUrl,
  sendSignWellDocument,
} from "./signwell.js";
import {
  extractSignWellRecipientIds as extractSignWellWebhookRecipientIds,
  getSignWellWebhookDocument,
  normalizeSignWellEventType,
  verifySignWellCallback,
  type SignWellWebhookPayload,
} from "./signwell-webhook.js";
import { resolveSignProvider, type SignProvider } from "./providers.js";
import {
  createId,
  createToken,
  nowIso,
  sha256,
  stableStringify,
  tokenHint,
} from "./util.js";
import type { SignerInput } from "./util.js";
import { verifyDropboxCallback } from "./webhook.js";
import type { DropboxCallbackPayload } from "./webhook.js";

export const REQUEST_WATCH_EXIT_CODES = {
  completed: 0,
  declined: 2,
  error: 3,
  timeout: 4,
} as const;

type WatchTerminalStatus = keyof typeof REQUEST_WATCH_EXIT_CODES;

export type CreateRequestInput = {
  title: string;
  documentPath: string;
  signers: SignerInput[];
  tokenTtlMinutes: number;
  autoApprove?: boolean;
  provider?: SignProvider;
  now?: Date;
};

type RequestRow = {
  id: string;
  title: string;
  document_path: string;
  document_hash: string;
  status: string;
  provider: string | null;
  provider_request_id: string | null;
  provider_status: string | null;
  dropbox_signature_request_id: string | null;
  dropbox_status: string | null;
  signature_ids_json: string | null;
  signers_json: string;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = {
  id: string;
  request_id: string;
  signer_name: string;
  signer_email: string;
  signer_order: number;
  token_hash: string;
  token_hint: string;
  doc_hash: string;
  expires_at: string;
  used_at: string | null;
  approved_at: string | null;
  created_at: string;
};

type ProviderSendResult = {
  providerRequestId: string;
  signatureIds: string[];
  providerStatus: string;
  responseBody: unknown;
};

type ProviderStatusResult = {
  providerStatus: string;
  signatureIds: string[];
  remoteStatus: unknown;
};

type ProviderApi = {
  send(input: {
    request: RequestRow;
    signers: SignerInput[];
    apiKey?: string;
    testMode: boolean;
  }): Promise<ProviderSendResult>;
  sendEmbedded?: (input: {
    request: RequestRow;
    signers: SignerInput[];
    apiKey?: string;
    clientId?: string;
    testMode: boolean;
  }) => Promise<ProviderSendResult>;
  getEmbeddedSignUrl?: (input: {
    signatureId: string;
    providerRequestId?: string | null;
    apiKey?: string;
  }) => Promise<{ signUrl: string; expiresAt: number | null }>;
  getStatus(input: {
    providerRequestId: string;
    apiKey?: string;
  }): Promise<ProviderStatusResult>;
  downloadFinalPdf(input: {
    providerRequestId: string;
    apiKey?: string;
  }): Promise<Buffer>;
  cancel(input: {
    providerRequestId: string;
    apiKey?: string;
    reason?: string;
  }): Promise<{ remoteResponse: unknown }>;
};

function getRequestRow(db: SqliteDb, requestId: string): RequestRow {
  const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as RequestRow | undefined;
  if (!row) {
    throw new Error(`Request not found: ${requestId}`);
  }
  return row;
}

function listApprovalRows(db: SqliteDb, requestId: string): ApprovalRow[] {
  return db.prepare("SELECT * FROM approvals WHERE request_id = ? ORDER BY signer_order ASC").all(requestId) as ApprovalRow[];
}

function updateRequestStatus(db: SqliteDb, requestId: string, status: string, now: Date): void {
  db.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(now), requestId);
}

function parseSignatureIdsJson(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function extractRemoteSignatureIds(remoteStatus: unknown): string[] {
  const remote = remoteStatus as Record<string, any> | null;
  const signatureRequest = remote?.signatureRequest ?? remote?.signature_request ?? null;
  return Array.isArray(signatureRequest?.signatures)
    ? signatureRequest.signatures
      .map((signature: any) => signature?.signature_id)
      .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : [];
}

function getPersistedProvider(request: RequestRow): SignProvider {
  return resolveSignProvider(undefined, request.provider ?? (request.dropbox_signature_request_id || request.dropbox_status ? "dropbox" : null));
}

function getProviderRequestId(request: RequestRow): string | null {
  return request.provider_request_id ?? request.dropbox_signature_request_id;
}

function getProviderStatusValue(request: RequestRow): string | null {
  return request.provider_status ?? request.dropbox_status;
}

function persistRequestProviderMetadata(
  db: SqliteDb,
  input: {
    requestId: string;
    provider: SignProvider;
    providerRequestId?: string | null;
    providerStatus?: string | null;
    signatureIds?: string[];
    now: Date;
  },
): void {
  const signatureIdsJson = input.signatureIds ? stableStringify(input.signatureIds) : null;
  const dropboxRequestId = input.provider === "dropbox" ? input.providerRequestId ?? null : null;
  const dropboxStatus = input.provider === "dropbox" ? input.providerStatus ?? null : null;
  db.prepare(
    `UPDATE requests
     SET provider = ?,
         provider_request_id = COALESCE(?, provider_request_id),
         provider_status = COALESCE(?, provider_status),
         dropbox_signature_request_id = CASE
           WHEN ? IS NOT NULL THEN ?
           ELSE dropbox_signature_request_id
         END,
         dropbox_status = CASE
           WHEN ? IS NOT NULL THEN ?
           ELSE dropbox_status
         END,
         signature_ids_json = CASE
           WHEN ? IS NOT NULL THEN ?
           ELSE signature_ids_json
         END,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    input.provider,
    input.providerRequestId ?? null,
    input.providerStatus ?? null,
    dropboxRequestId,
    dropboxRequestId,
    dropboxStatus,
    dropboxStatus,
    signatureIdsJson,
    signatureIdsJson,
    nowIso(input.now),
    input.requestId,
  );
}

function serializeRequestRow(request: RequestRow): RequestRow & { signatureIds: string[]; normalizedProvider: SignProvider } {
  return {
    ...request,
    provider: request.provider ?? getPersistedProvider(request),
    provider_request_id: getProviderRequestId(request),
    provider_status: getProviderStatusValue(request),
    signatureIds: parseSignatureIdsJson(request.signature_ids_json),
    normalizedProvider: getPersistedProvider(request),
  };
}

export function normalizeDropboxStatus(remoteStatus: unknown): string {
  const remote = remoteStatus as Record<string, any> | null;
  const signatureRequest = remote?.signatureRequest ?? remote?.signature_request ?? null;
  if (!signatureRequest) {
    return "unknown";
  }
  if (signatureRequest?.isComplete || signatureRequest?.is_complete) {
    return "completed";
  }
  return String(signatureRequest?.statusCode ?? signatureRequest?.status_code ?? "sent").toLowerCase();
}

export function normalizeProviderStatus(provider: SignProvider, remoteStatus: unknown): string {
  if (provider === "docusign") {
    return normalizeDocuSignStatus(remoteStatus);
  }
  if (provider === "signwell") {
    return normalizeSignWellStatus(remoteStatus);
  }
  return normalizeDropboxStatus(remoteStatus);
}

export function resolveWatchTerminalStatus(status: string): WatchTerminalStatus | null {
  const normalized = status.toLowerCase();

  if (["completed", "signed"].includes(normalized)) {
    return "completed";
  }
  if (["declined", "rejected", "expired", "canceled", "cancelled", "voided"].includes(normalized)) {
    return "declined";
  }
  if (["error", "invalid", "failed", "authentication_failed", "bounced"].includes(normalized)) {
    return "error";
  }
  return null;
}

function getProviderApi(provider: SignProvider): ProviderApi {
  if (provider === "docusign") {
    return {
      async send(input) {
        const result = await sendDocuSignEnvelope({
          documentPath: input.request.document_path,
          title: input.request.title,
          signers: input.signers,
          metadata: {
            request_id: input.request.id,
            document_hash: input.request.document_hash,
          },
        });
        return {
          providerRequestId: result.envelopeId,
          signatureIds: result.recipientIds,
          providerStatus: "sent",
          responseBody: result.responseBody,
        };
      },
      async getStatus(input) {
        const remoteStatus = await fetchDocuSignEnvelopeStatus(input.providerRequestId);
        return {
          providerStatus: normalizeDocuSignStatus(remoteStatus),
          signatureIds: [],
          remoteStatus,
        };
      },
      async downloadFinalPdf(input) {
        return downloadDocuSignCombinedPdf(input.providerRequestId);
      },
      async cancel(input) {
        const remoteResponse = await voidDocuSignEnvelope(input.providerRequestId, input.reason ?? "Voided via sign CLI");
        return { remoteResponse };
      },
    };
  }

  if (provider === "signwell") {
    return {
      async send(input) {
        const result = await sendSignWellDocument({
          apiKey: input.apiKey ?? "",
          baseUrl: resolveSignWellBaseUrl(),
          documentPath: input.request.document_path,
          title: input.request.title,
          signers: input.signers,
          metadata: {
            request_id: input.request.id,
            document_hash: input.request.document_hash,
          },
          testMode: input.testMode,
        });
        return {
          providerRequestId: result.documentId,
          signatureIds: result.recipientIds,
          providerStatus: result.status || "sent",
          responseBody: result.responseBody,
        };
      },
      async sendEmbedded(input) {
        const result = await sendSignWellDocument({
          apiKey: input.apiKey ?? "",
          baseUrl: resolveSignWellBaseUrl(),
          documentPath: input.request.document_path,
          title: input.request.title,
          signers: input.signers,
          metadata: {
            request_id: input.request.id,
            document_hash: input.request.document_hash,
          },
          testMode: input.testMode,
          embeddedSigning: true,
        });
        return {
          providerRequestId: result.documentId,
          signatureIds: result.recipientIds,
          providerStatus: result.status || "sent",
          responseBody: result.responseBody,
        };
      },
      async getEmbeddedSignUrl(input) {
        if (!input.providerRequestId) {
          throw new Error("SignWell embedded sign URL requires a provider request id (document id).");
        }
        const result = await fetchSignWellEmbeddedSignUrl(
          input.apiKey ?? "",
          input.providerRequestId,
          input.signatureId,
          resolveSignWellBaseUrl(),
        );
        return { signUrl: result.signUrl, expiresAt: result.expiresAt };
      },
      async getStatus(input) {
        const remoteStatus = await fetchSignWellDocumentStatus(
          input.apiKey ?? "",
          input.providerRequestId,
          resolveSignWellBaseUrl(),
        );
        return {
          providerStatus: normalizeSignWellStatus(remoteStatus),
          signatureIds: extractRemoteSignWellRecipientIds(remoteStatus),
          remoteStatus,
        };
      },
      async downloadFinalPdf(input) {
        return downloadSignWellCompletedPdf(input.apiKey ?? "", input.providerRequestId, resolveSignWellBaseUrl());
      },
      async cancel(input) {
        const remoteResponse = await cancelSignWellDocument(input.apiKey ?? "", input.providerRequestId, resolveSignWellBaseUrl());
        return { remoteResponse };
      },
    };
  }

  return {
    async send(input) {
      const result = await sendSignatureRequest({
        apiKey: input.apiKey ?? "",
        documentPath: input.request.document_path,
        title: input.request.title,
        signers: input.signers,
        metadata: {
          request_id: input.request.id,
          document_hash: input.request.document_hash,
        },
        testMode: input.testMode,
      });
      return {
        providerRequestId: result.signatureRequestId,
        signatureIds: result.signatureIds,
        providerStatus: "sent",
        responseBody: result.responseBody,
      };
    },
    async sendEmbedded(input) {
      const result = await createEmbeddedSignatureRequest({
        apiKey: input.apiKey ?? "",
        clientId: input.clientId ?? "",
        documentPath: input.request.document_path,
        title: input.request.title,
        signers: input.signers,
        metadata: {
          request_id: input.request.id,
          document_hash: input.request.document_hash,
        },
        testMode: input.testMode,
      });
      return {
        providerRequestId: result.signatureRequestId,
        signatureIds: result.signatureIds,
        providerStatus: "sent",
        responseBody: result.responseBody,
      };
    },
    async getEmbeddedSignUrl(input) {
      const result = await fetchEmbeddedSignUrl(input.apiKey ?? "", input.signatureId);
      return { signUrl: result.signUrl, expiresAt: result.expiresAt };
    },
    async getStatus(input) {
      const remoteStatus = await fetchSignatureRequestStatus(input.apiKey ?? "", input.providerRequestId);
      return {
        providerStatus: normalizeDropboxStatus(remoteStatus),
        signatureIds: extractRemoteSignatureIds(remoteStatus),
        remoteStatus,
      };
    },
    async downloadFinalPdf(input) {
      return downloadSignedPdf(input.apiKey ?? "", input.providerRequestId);
    },
    async cancel(input) {
      const remoteResponse = await cancelDropboxSignatureRequest(input.apiKey ?? "", input.providerRequestId);
      return { remoteResponse };
    },
  };
}

function extractRemoteSignWellRecipientIds(remoteStatus: unknown): string[] {
  const remote = remoteStatus as Record<string, any> | null;
  return Array.isArray(remote?.recipients)
    ? remote.recipients
      .map((recipient: any) => recipient?.id)
      .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : [];
}

export function createSigningRequest(
  db: SqliteDb,
  input: CreateRequestInput,
): {
  requestId: string;
  documentHash: string;
  tokens: Array<{ signer: SignerInput; token: string; expiresAt: string }>;
} {
  if (input.signers.length === 0) {
    throw new Error("At least one --signer is required.");
  }
  if (!Number.isFinite(input.tokenTtlMinutes) || input.tokenTtlMinutes <= 0) {
    throw new Error("--token-ttl-minutes must be a positive number.");
  }

  const sortedSigners = [...input.signers].sort((left, right) => left.order - right.order);
  const duplicateOrders = new Set<number>();
  const seenOrders = new Set<number>();
  for (const signer of sortedSigners) {
    if (seenOrders.has(signer.order)) {
      duplicateOrders.add(signer.order);
    }
    seenOrders.add(signer.order);
  }
  if (duplicateOrders.size > 0) {
    throw new Error(`Duplicate signer order values are not allowed: ${[...duplicateOrders].join(", ")}`);
  }

  const now = input.now ?? new Date();
  const requestId = createId("req");
  const createdAt = nowIso(now);
  const documentPath = path.resolve(input.documentPath);
  const documentHash = sha256(readFileSync(documentPath));
  const signersJson = stableStringify(sortedSigners);

  db.prepare(
    `INSERT INTO requests (
      id, title, document_path, document_hash, status, provider, provider_request_id, provider_status, dropbox_signature_request_id, dropbox_status, signature_ids_json, signers_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    input.title,
    documentPath,
    documentHash,
    "created",
    input.provider ?? null,
    null,
    null,
    null,
    null,
    null,
    signersJson,
    createdAt,
    createdAt,
  );

  db.prepare(
    `INSERT INTO artifacts (id, request_id, kind, path, content_hash, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createId("art"),
    requestId,
    "document",
    documentPath,
    documentHash,
    stableStringify({ title: input.title }),
    createdAt,
  );

  const tokens = sortedSigners.map((signer) => {
    const token = createToken();
    const expiresAt = nowIso(new Date(now.getTime() + input.tokenTtlMinutes * 60_000));
    db.prepare(
      `INSERT INTO approvals (
        id, request_id, signer_name, signer_email, signer_order, token_hash, token_hint, doc_hash, expires_at, used_at, approved_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("apr"),
      requestId,
      signer.name,
      signer.email,
      signer.order,
      sha256(token),
      tokenHint(token),
      documentHash,
      expiresAt,
      null,
      null,
      createdAt,
    );
    return { signer, token, expiresAt };
  });

  if (input.autoApprove) {
    db.prepare("UPDATE approvals SET used_at = ?, approved_at = ? WHERE request_id = ?").run(createdAt, createdAt, requestId);
    updateRequestStatus(db, requestId, "approved", now);
  }

  appendAuditEvent(db, {
    requestId,
    eventType: "request.created",
    payload: {
      title: input.title,
      documentPath,
      documentHash,
      provider: input.provider ?? null,
      signers: sortedSigners,
      tokenTtlMinutes: input.tokenTtlMinutes,
      autoApprove: Boolean(input.autoApprove),
    },
    now,
  });

  return { requestId, documentHash, tokens };
}

export function approveSigningRequest(
  db: SqliteDb,
  input: { requestId: string; token: string; now?: Date },
): {
  approvalId: string;
  signerEmail: string;
  requestStatus: string;
} {
  const now = input.now ?? new Date();
  const tokenHash = sha256(input.token);
  const approval = db.prepare(
    "SELECT * FROM approvals WHERE request_id = ? AND token_hash = ?",
  ).get(input.requestId, tokenHash) as ApprovalRow | undefined;

  if (!approval) {
    throw new Error("Approval token is invalid for this request.");
  }
  if (approval.used_at) {
    throw new Error("Approval token has already been used.");
  }
  if (new Date(approval.expires_at).getTime() < now.getTime()) {
    throw new Error("Approval token has expired.");
  }

  const request = getRequestRow(db, input.requestId);
  if (request.document_hash !== approval.doc_hash) {
    throw new Error("Approval token is not valid for the current document hash.");
  }

  const nowStamp = nowIso(now);
  db.prepare("UPDATE approvals SET used_at = ?, approved_at = ? WHERE id = ?").run(nowStamp, nowStamp, approval.id);

  const remainingCount = db
    .prepare("SELECT COUNT(*) AS count FROM approvals WHERE request_id = ? AND used_at IS NULL")
    .get(input.requestId) as { count: number };

  const nextStatus = remainingCount.count === 0 ? "approved" : "partially_approved";
  updateRequestStatus(db, input.requestId, nextStatus, now);

  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.approved",
    payload: {
      approvalId: approval.id,
      signerEmail: approval.signer_email,
      signerOrder: approval.signer_order,
      requestStatus: nextStatus,
    },
    now,
  });

  return {
    approvalId: approval.id,
    signerEmail: approval.signer_email,
    requestStatus: nextStatus,
  };
}

export async function sendSigningRequest(
  db: SqliteDb,
  input: {
    requestId: string;
    provider?: SignProvider;
    apiKey?: string;
    testMode: boolean;
    now?: Date;
    providerSend?: () => Promise<ProviderSendResult>;
    sendRequest?: typeof sendSignatureRequest;
  },
): Promise<{
  provider: SignProvider;
  signatureRequestId: string;
  signatureIds: string[];
  responseBody: unknown;
}> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const providerApi = getProviderApi(provider);
  const send = input.providerSend
    ? input.providerSend
    : input.sendRequest && provider === "dropbox"
    ? async () => {
      const result = await input.sendRequest!({
        apiKey: input.apiKey ?? "",
        documentPath: request.document_path,
        title: request.title,
        signers,
        metadata: {
          request_id: request.id,
          document_hash: request.document_hash,
        },
        testMode: input.testMode,
      });
      return {
        providerRequestId: result.signatureRequestId,
        signatureIds: result.signatureIds,
        providerStatus: "sent",
        responseBody: result.responseBody,
      };
    }
    : () => providerApi.send({ request, signers, apiKey: input.apiKey, testMode: input.testMode });

  const result = await send();
  const now = input.now ?? new Date();
  persistRequestProviderMetadata(db, {
    requestId: input.requestId,
    provider,
    providerRequestId: result.providerRequestId,
    providerStatus: result.providerStatus,
    signatureIds: result.signatureIds,
    now,
  });
  updateRequestStatus(db, input.requestId, "sent", now);

  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.sent",
    payload: {
      provider,
      providerRequestId: result.providerRequestId,
      signatureIds: result.signatureIds,
      testMode: input.testMode,
    },
    now,
  });

  return {
    provider,
    signatureRequestId: result.providerRequestId,
    signatureIds: result.signatureIds,
    responseBody: result.responseBody,
  };
}

export async function runProviderAccountCheck(input: { provider: SignProvider; apiKey?: string }): Promise<Record<string, unknown>> {
  if (input.provider === "dropbox") {
    if (!input.apiKey) {
      throw new Error("DROPBOX_SIGN_API_KEY is required for Dropbox account check.");
    }
    const account = await checkDropboxAccount(input.apiKey);
    return {
      provider: "dropbox",
      account,
      interpretation: {
        apiLikelyEnabled: account.apiSignatureRequestsLeft !== null,
        note: account.apiSignatureRequestsLeft === null
          ? "Could not confirm API quota; account may be restricted or response shape changed."
          : "API quota field is present.",
      },
    };
  }

  if (input.provider === "signwell") {
    if (!input.apiKey) {
      throw new Error("SIGNWELL_API_KEY is required for SignWell account check.");
    }
    const account = await checkSignWellAccount(input.apiKey, resolveSignWellBaseUrl());
    return {
      provider: "signwell",
      account,
      interpretation: {
        apiLikelyEnabled: account.email !== null || account.name !== null,
        note: "API key + /me endpoint succeeded.",
      },
    };
  }

  const account = await checkDocuSignAccountAccess();
  return {
    provider: "docusign",
    account,
    interpretation: {
      apiLikelyEnabled: true,
      note: "JWT auth + account endpoint succeeded.",
    },
  };
}

export type ProviderCapability = {
  provider: SignProvider;
  displayName: string;
  capabilities: {
    emailSend: boolean;
    embeddedSigning: boolean;
    webhooks: boolean;
    finalPdfDownload: boolean;
    testMode: boolean;
    accountCheck: boolean;
  };
  config: {
    configured: boolean;
    missing: string[];
    detected: Record<string, boolean | string | null>;
  };
};

export function buildProviderMatrix(): ProviderCapability[] {
  const dropboxKey = Boolean(process.env.DROPBOX_SIGN_API_KEY);
  const dropboxClient = Boolean(process.env.DROPBOX_SIGN_CLIENT_ID);
  const signwellKey = Boolean(process.env.SIGNWELL_API_KEY);
  const signwellWebhookSecret = Boolean(process.env.SIGNWELL_WEBHOOK_SECRET || process.env.SIGNWELL_API_KEY);
  const docusignKeys = {
    DOCUSIGN_INTEGRATION_KEY: Boolean(process.env.DOCUSIGN_INTEGRATION_KEY),
    DOCUSIGN_USER_ID: Boolean(process.env.DOCUSIGN_USER_ID),
    DOCUSIGN_ACCOUNT_ID: Boolean(process.env.DOCUSIGN_ACCOUNT_ID),
    DOCUSIGN_BASE_PATH: Boolean(process.env.DOCUSIGN_BASE_PATH),
    DOCUSIGN_PRIVATE_KEY_PATH: Boolean(process.env.DOCUSIGN_PRIVATE_KEY_PATH),
  };

  const dropboxMissing: string[] = [];
  if (!dropboxKey) dropboxMissing.push("DROPBOX_SIGN_API_KEY");

  const signwellMissing: string[] = [];
  if (!signwellKey) signwellMissing.push("SIGNWELL_API_KEY");

  const docusignMissing = Object.entries(docusignKeys)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  return [
    {
      provider: "dropbox",
      displayName: "Dropbox Sign",
      capabilities: {
        emailSend: true,
        embeddedSigning: true,
        webhooks: true,
        finalPdfDownload: true,
        testMode: true,
        accountCheck: true,
      },
      config: {
        configured: dropboxKey,
        missing: dropboxMissing,
        detected: {
          DROPBOX_SIGN_API_KEY: dropboxKey,
          DROPBOX_SIGN_CLIENT_ID: dropboxClient,
          DROPBOX_SIGN_TEST_MODE: process.env.DROPBOX_SIGN_TEST_MODE ?? null,
        },
      },
    },
    {
      provider: "docusign",
      displayName: "DocuSign",
      capabilities: {
        emailSend: true,
        embeddedSigning: false,
        webhooks: false,
        finalPdfDownload: true,
        testMode: false,
        accountCheck: true,
      },
      config: {
        configured: docusignMissing.length === 0,
        missing: docusignMissing,
        detected: docusignKeys,
      },
    },
    {
      provider: "signwell",
      displayName: "SignWell",
      capabilities: {
        emailSend: true,
        embeddedSigning: true,
        webhooks: true,
        finalPdfDownload: true,
        testMode: true,
        accountCheck: true,
      },
      config: {
        configured: signwellKey,
        missing: signwellMissing,
        detected: {
          SIGNWELL_API_KEY: signwellKey,
          SIGNWELL_BASE_URL: process.env.SIGNWELL_BASE_URL ?? resolveSignWellBaseUrl(),
          SIGNWELL_TEST_MODE: process.env.SIGNWELL_TEST_MODE ?? null,
          SIGNWELL_WEBHOOK_SECRET: signwellWebhookSecret,
        },
      },
    },
  ];
}

export async function runDoctor(apiKey?: string): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {
    env: {
      provider: resolveSignProvider(),
      hasApiKey: Boolean(process.env.DROPBOX_SIGN_API_KEY),
      hasClientId: Boolean(process.env.DROPBOX_SIGN_CLIENT_ID),
      hasSignWellApiKey: Boolean(process.env.SIGNWELL_API_KEY),
      signWellBaseUrl: resolveSignWellBaseUrl(),
      hasDocuSignIntegrationKey: Boolean(process.env.DOCUSIGN_INTEGRATION_KEY),
      hasDocuSignUserId: Boolean(process.env.DOCUSIGN_USER_ID),
      hasDocuSignAccountId: Boolean(process.env.DOCUSIGN_ACCOUNT_ID),
      hasDocuSignBasePath: Boolean(process.env.DOCUSIGN_BASE_PATH),
      hasDocuSignPrivateKeyPath: Boolean(process.env.DOCUSIGN_PRIVATE_KEY_PATH),
      dbPath: process.env.SIGN_DB_PATH ?? "./data/sign.db",
    },
  };
  if (apiKey) {
    checks.dropbox = await checkDropboxAccount(apiKey);
  }
  return checks;
}

export async function fetchFinalSignedPdf(
  db: SqliteDb,
  input: { requestId: string; provider?: SignProvider; apiKey?: string; outPath?: string; now?: Date },
): Promise<{ path: string; bytes: number; sha256: string }> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  const providerRequestId = getProviderRequestId(request);
  if (!providerRequestId) {
    throw new Error(`Request has not been sent to ${providerDisplayName(provider)} yet.`);
  }

  const providerApi = getProviderApi(provider);
  const status = await providerApi.getStatus({ providerRequestId, apiKey: input.apiKey });
  if (resolveWatchTerminalStatus(status.providerStatus) !== "completed") {
    throw new Error("Request is not complete yet.");
  }

  const pdf = await providerApi.downloadFinalPdf({ providerRequestId, apiKey: input.apiKey });
  const outPath = input.outPath ?? path.resolve("artifacts", `${request.id}-signed.pdf`);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, pdf);
  const hash = sha256(pdf);
  const now = input.now ?? new Date();

  persistRequestProviderMetadata(db, {
    requestId: request.id,
    provider,
    providerRequestId,
    providerStatus: status.providerStatus,
    signatureIds: status.signatureIds.length > 0 ? status.signatureIds : undefined,
    now,
  });

  db.prepare(
    `INSERT INTO artifacts (id, request_id, kind, path, content_hash, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(createId("art"), request.id, "signed_pdf", outPath, hash, stableStringify({ bytes: pdf.length, provider }), nowIso(now));

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.final_pdf_downloaded",
    payload: { provider, outPath, bytes: pdf.length, sha256: hash },
    now,
  });

  return { path: outPath, bytes: pdf.length, sha256: hash };
}

export async function sendEmbeddedSigningRequest(
  db: SqliteDb,
  input: {
    requestId: string;
    provider?: SignProvider;
    apiKey?: string;
    clientId?: string;
    testMode: boolean;
    now?: Date;
    createEmbeddedRequest?: typeof createEmbeddedSignatureRequest;
  },
): Promise<{
  provider: SignProvider;
  signatureRequestId: string;
  signatureIds: string[];
  responseBody: unknown;
}> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  if (provider === "docusign") {
    throw new Error(`Embedded signing is not yet supported for ${providerDisplayName(provider)}.`);
  }
  const providerApi = getProviderApi(provider);
  if (!providerApi.sendEmbedded) {
    throw new Error(`Embedded signing is not yet supported for ${providerDisplayName(provider)}.`);
  }

  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const sendEmbedded = input.createEmbeddedRequest && provider === "dropbox"
    ? async () => {
      const result = await input.createEmbeddedRequest!({
        apiKey: input.apiKey ?? "",
        clientId: input.clientId ?? "",
        documentPath: request.document_path,
        title: request.title,
        signers,
        metadata: {
          request_id: request.id,
          document_hash: request.document_hash,
        },
        testMode: input.testMode,
      });
      return {
        providerRequestId: result.signatureRequestId,
        signatureIds: result.signatureIds,
        providerStatus: "sent",
        responseBody: result.responseBody,
      };
    }
    : () => providerApi.sendEmbedded!({
      request,
      signers,
      apiKey: input.apiKey,
      clientId: input.clientId,
      testMode: input.testMode,
    });

  const result = await sendEmbedded();
  const now = input.now ?? new Date();
  persistRequestProviderMetadata(db, {
    requestId: input.requestId,
    provider,
    providerRequestId: result.providerRequestId,
    providerStatus: result.providerStatus,
    signatureIds: result.signatureIds,
    now,
  });
  updateRequestStatus(db, input.requestId, "sent", now);

  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.sent_embedded",
    payload: {
      provider,
      providerRequestId: result.providerRequestId,
      signatureIds: result.signatureIds,
      testMode: input.testMode,
      clientId: input.clientId ?? null,
    },
    now,
  });

  return {
    provider,
    signatureRequestId: result.providerRequestId,
    signatureIds: result.signatureIds,
    responseBody: result.responseBody,
  };
}

export async function getEmbeddedSignUrl(
  db: SqliteDb,
  input: { requestId: string; provider?: SignProvider; signatureId: string; apiKey?: string; now?: Date },
): Promise<{ signUrl: string; expiresAt: number | null; signatureId: string }> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  const providerApi = getProviderApi(provider);
  if (!providerApi.getEmbeddedSignUrl) {
    throw new Error(`Embedded signing is not yet supported for ${providerDisplayName(provider)}.`);
  }

  const result = await providerApi.getEmbeddedSignUrl({
    signatureId: input.signatureId,
    providerRequestId: getProviderRequestId(request),
    apiKey: input.apiKey,
  });
  const now = input.now ?? new Date();
  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.embedded_sign_url_issued",
    payload: { provider, signatureId: input.signatureId, expiresAt: result.expiresAt },
    now,
  });
  return { signUrl: result.signUrl, expiresAt: result.expiresAt, signatureId: input.signatureId };
}

export async function getSigningRequestStatus(
  db: SqliteDb,
  input: { requestId: string; provider?: SignProvider; apiKey?: string; now?: Date },
): Promise<{
  request: RequestRow & { signatureIds: string[]; normalizedProvider: SignProvider };
  remoteStatus: unknown;
}> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  const providerRequestId = getProviderRequestId(request);
  if (!providerRequestId) {
    throw new Error(`Request has not been sent to ${providerDisplayName(provider)} yet.`);
  }

  const result = await getProviderApi(provider).getStatus({
    providerRequestId,
    apiKey: input.apiKey,
  });
  const now = input.now ?? new Date();
  persistRequestProviderMetadata(db, {
    requestId: request.id,
    provider,
    providerRequestId,
    providerStatus: result.providerStatus,
    signatureIds: result.signatureIds.length > 0 ? result.signatureIds : undefined,
    now,
  });

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.status_checked",
    payload: {
      provider,
      providerRequestId,
      providerStatus: result.providerStatus,
    },
    now,
  });

  return { request: serializeRequestRow(getRequestRow(db, request.id)), remoteStatus: result.remoteStatus };
}

function providerDisplayName(provider: SignProvider): string {
  if (provider === "docusign") {
    return "DocuSign";
  }
  if (provider === "signwell") {
    return "SignWell";
  }
  return "Dropbox Sign";
}

export async function watchSigningRequestStatus(
  db: SqliteDb,
  input: {
    requestId: string;
    provider?: SignProvider;
    apiKey?: string;
    intervalMs: number;
    timeoutMs?: number;
    fetchFinalPdf?: boolean;
    outPath?: string;
    now?: Date;
    sleep?: (ms: number) => Promise<void>;
    getStatus?: typeof getSigningRequestStatus;
    fetchFinal?: typeof fetchFinalSignedPdf;
    onPoll?: (update: {
      provider: SignProvider;
      status: string;
      terminal: WatchTerminalStatus | null;
      attempt: number;
      startedAt: string;
      elapsedMs: number;
      lastRemoteStatus: unknown;
    }) => void;
  },
): Promise<{
  requestId: string;
  provider: SignProvider;
  status: string;
  terminal: WatchTerminalStatus;
  exitCode: number;
  attempts: number;
  startedAt: string;
  elapsedMs: number;
  lastRemoteStatus: unknown;
  finalPdf: { path: string; bytes: number; sha256: string } | null;
}> {
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error("--interval-ms must be a positive number.");
  }
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive number when provided.");
  }

  const initialRequest = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(initialRequest);
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const getStatus = input.getStatus ?? getSigningRequestStatus;
  const fetchFinal = input.fetchFinal ?? fetchFinalSignedPdf;
  const startedAtMs = input.now?.getTime() ?? Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  let attempts = 0;
  let lastRemoteStatus: unknown = null;
  while (true) {
    attempts += 1;
    const result = await getStatus(db, { requestId: input.requestId, provider, apiKey: input.apiKey });
    lastRemoteStatus = result.remoteStatus;
    const status = String(result.request.provider_status ?? getProviderStatusValue(result.request) ?? normalizeProviderStatus(provider, result.remoteStatus));
    const terminal = resolveWatchTerminalStatus(status);
    const elapsedMs = Date.now() - startedAtMs;
    input.onPoll?.({ provider, status, terminal, attempt: attempts, startedAt, elapsedMs, lastRemoteStatus });

    if (terminal) {
      const finalPdf = terminal === "completed" && input.fetchFinalPdf
        ? await fetchFinal(db, { requestId: input.requestId, provider, apiKey: input.apiKey, outPath: input.outPath })
        : null;
      return {
        requestId: input.requestId,
        provider,
        status,
        terminal,
        exitCode: REQUEST_WATCH_EXIT_CODES[terminal],
        attempts,
        startedAt,
        elapsedMs,
        lastRemoteStatus,
        finalPdf,
      };
    }

    if (input.timeoutMs !== undefined && elapsedMs >= input.timeoutMs) {
      return {
        requestId: input.requestId,
        provider,
        status,
        terminal: "timeout",
        exitCode: REQUEST_WATCH_EXIT_CODES.timeout,
        attempts,
        startedAt,
        elapsedMs,
        lastRemoteStatus,
        finalPdf: null,
      };
    }

    await sleep(input.intervalMs);
  }
}

export function listAuditEvents(db: SqliteDb, requestId: string): Array<{
  id: number;
  event_type: string;
  payload_json: string;
  hash_prev: string | null;
  hash_self: string;
  created_at: string;
}> {
  return db.prepare(
    `SELECT id, event_type, payload_json, hash_prev, hash_self, created_at
     FROM audit_events
     WHERE request_id = ?
     ORDER BY id ASC`,
  ).all(requestId) as Array<{
    id: number;
    event_type: string;
    payload_json: string;
    hash_prev: string | null;
    hash_self: string;
    created_at: string;
  }>;
}

export function ingestSignWellWebhookPayload(
  db: SqliteDb,
  input: {
    payload: SignWellWebhookPayload;
    secret: string;
    signatureHeader?: string | null;
    requestId?: string;
    now?: Date;
  },
): { verified: boolean; requestId: string | null; eventType: string | null; normalizedEventType: string; providerStatus: string | null } {
  const verified = verifySignWellCallback(input.secret, input.payload, input.signatureHeader ?? null);
  const eventType = input.payload?.event?.type ?? null;
  const normalizedEventType = normalizeSignWellEventType(eventType);
  const document = getSignWellWebhookDocument(input.payload);
  const documentId = document?.id ?? null;
  const documentMetadataRequestId = document?.metadata?.request_id ?? null;
  const requestId = input.requestId ?? documentMetadataRequestId ?? null;

  if (!requestId) {
    return {
      verified,
      requestId: null,
      eventType,
      normalizedEventType,
      providerStatus: typeof document?.status === "string" ? document.status : null,
    };
  }

  getRequestRow(db, requestId);

  const now = input.now ?? new Date();
  const providerStatus = typeof document?.status === "string"
    ? document.status.trim().toLowerCase().replace(/[\s-]+/gu, "_")
    : normalizedEventType;

  appendAuditEvent(db, {
    requestId,
    eventType: `signwell.webhook.${eventType ?? "unknown"}`,
    payload: {
      verified,
      normalizedEventType,
      providerStatus,
      payload: input.payload,
    },
    now,
  });

  if (verified) {
    persistRequestProviderMetadata(db, {
      requestId,
      provider: "signwell",
      providerRequestId: documentId ?? undefined,
      providerStatus,
      signatureIds: extractSignWellWebhookRecipientIds(document),
      now,
    });
  }

  return {
    verified,
    requestId,
    eventType,
    normalizedEventType,
    providerStatus,
  };
}

export function ingestWebhookPayload(
  db: SqliteDb,
  input: {
    payload: DropboxCallbackPayload;
    apiKey: string;
    requestId?: string;
    now?: Date;
  },
): { verified: boolean; requestId: string | null; eventType: string | null } {
  const verified = verifyDropboxCallback(input.apiKey, input.payload);
  const requestId =
    input.requestId ??
    input.payload.signature_request?.metadata?.request_id ??
    null;
  const eventType = input.payload.event?.event_type ?? null;

  if (!requestId) {
    return { verified, requestId: null, eventType };
  }

  getRequestRow(db, requestId);

  const now = input.now ?? new Date();
  appendAuditEvent(db, {
    requestId,
    eventType: `dropbox.webhook.${eventType ?? "unknown"}`,
    payload: {
      verified,
      payload: input.payload,
    },
    now,
  });

  if (verified && input.payload.signature_request?.signature_request_id) {
    const signatureIds = Array.isArray(input.payload.signature_request?.signatures)
      ? input.payload.signature_request.signatures
        .map((signature: any) => signature?.signature_id)
        .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
      : undefined;
    persistRequestProviderMetadata(db, {
      requestId,
      provider: "dropbox",
      providerRequestId: input.payload.signature_request.signature_request_id,
      signatureIds,
      now,
    });
  }

  return { verified, requestId, eventType };
}

export function getRequestSnapshot(db: SqliteDb, requestId: string): {
  request: RequestRow & { signatureIds: string[]; normalizedProvider: SignProvider };
  approvals: ApprovalRow[];
} {
  return {
    request: serializeRequestRow(getRequestRow(db, requestId)),
    approvals: listApprovalRows(db, requestId),
  };
}

export async function cancelSigningRequest(
  db: SqliteDb,
  input: {
    requestId: string;
    provider?: SignProvider;
    apiKey?: string;
    reason?: string;
    now?: Date;
  },
): Promise<{
  provider: SignProvider;
  providerRequestId: string;
  status: string;
  remoteResponse: unknown;
}> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  const providerRequestId = getProviderRequestId(request);
  if (!providerRequestId) {
    throw new Error(`Request has not been sent to ${providerDisplayName(provider)} yet; nothing to cancel.`);
  }
  if (provider === "docusign" && !input.reason) {
    throw new Error("DocuSign cancel requires --reason \"<reason>\".");
  }

  const result = await getProviderApi(provider).cancel({
    providerRequestId,
    apiKey: input.apiKey,
    reason: input.reason,
  });

  const now = input.now ?? new Date();
  const newStatus = "canceled";
  persistRequestProviderMetadata(db, {
    requestId: request.id,
    provider,
    providerRequestId,
    providerStatus: newStatus,
    now,
  });
  updateRequestStatus(db, request.id, newStatus, now);

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.canceled",
    payload: { provider, providerRequestId, reason: input.reason ?? null },
    now,
  });

  return {
    provider,
    providerRequestId,
    status: newStatus,
    remoteResponse: result.remoteResponse,
  };
}

export function listSigningRequests(
  db: SqliteDb,
  input: { provider?: SignProvider; status?: string; limit?: number } = {},
): Array<{
  id: string;
  title: string;
  status: string;
  provider: SignProvider | null;
  providerRequestId: string | null;
  providerStatus: string | null;
  signers: number;
  createdAt: string;
  updatedAt: string;
}> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.provider) {
    where.push("provider = ?");
    params.push(input.provider);
  }
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.min(Number(input.limit), 500) : 100;
  const rows = db.prepare(
    `SELECT id, title, status, provider, provider_request_id, provider_status, signers_json, created_at, updated_at
     FROM requests
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY datetime(created_at) DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<{
    id: string;
    title: string;
    status: string;
    provider: string | null;
    provider_request_id: string | null;
    provider_status: string | null;
    signers_json: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => {
    let signers = 0;
    try {
      const parsed = JSON.parse(row.signers_json);
      signers = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      signers = 0;
    }
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      provider: row.provider as SignProvider | null,
      providerRequestId: row.provider_request_id,
      providerStatus: row.provider_status,
      signers,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function verifyRequestAuditChain(db: SqliteDb, requestId: string): AuditVerificationResult {
  getRequestRow(db, requestId);
  return verifyAuditChain(db, requestId);
}

export async function runSignWellSmokeTest(
  db: SqliteDb,
  input: {
    apiKey: string;
    documentPath: string;
    title?: string;
    signerName?: string;
    signerEmail?: string;
    intervalMs?: number;
    timeoutMs?: number;
    fetchFinalPdf?: boolean;
    outPath?: string;
    onProgress?: (line: string) => void;
  },
): Promise<{
  account: Record<string, unknown>;
  requestId: string;
  documentId: string;
  status: string;
  terminal: WatchTerminalStatus;
  finalPdf: { path: string; bytes: number; sha256: string } | null;
  attempts: number;
  elapsedMs: number;
}> {
  const onProgress = input.onProgress ?? (() => {});
  onProgress(`[smoke-signwell] account-check`);
  const account = await runProviderAccountCheck({ provider: "signwell", apiKey: input.apiKey });

  const title = input.title ?? `SignWell smoke ${new Date().toISOString()}`;
  const signerName = input.signerName ?? "Smoke Tester";
  const signerEmail = input.signerEmail
    ?? process.env.SIGNWELL_SMOKE_SIGNER_EMAIL
    ?? `smoke+${Date.now()}@example.com`;

  onProgress(`[smoke-signwell] creating request title="${title}" signer=${signerEmail}`);
  const created = createSigningRequest(db, {
    title,
    documentPath: input.documentPath,
    signers: [{ name: signerName, email: signerEmail, order: 1 }],
    tokenTtlMinutes: 30,
    provider: "signwell",
    autoApprove: true,
  });

  onProgress(`[smoke-signwell] sending document via SignWell test_mode=true`);
  const sent = await sendSigningRequest(db, {
    requestId: created.requestId,
    provider: "signwell",
    apiKey: input.apiKey,
    testMode: true,
  });

  onProgress(`[smoke-signwell] watching status documentId=${sent.signatureRequestId}`);
  const watch = await watchSigningRequestStatus(db, {
    requestId: created.requestId,
    provider: "signwell",
    apiKey: input.apiKey,
    intervalMs: input.intervalMs ?? 5000,
    timeoutMs: input.timeoutMs ?? 60_000,
    fetchFinalPdf: Boolean(input.fetchFinalPdf),
    outPath: input.outPath,
    onPoll: (update) => {
      onProgress(`[smoke-signwell] +${(update.elapsedMs / 1000).toFixed(1)}s status=${update.status}${update.terminal ? ` terminal=${update.terminal}` : ""}`);
    },
  });

  return {
    account,
    requestId: created.requestId,
    documentId: sent.signatureRequestId,
    status: watch.status,
    terminal: watch.terminal,
    finalPdf: watch.finalPdf,
    attempts: watch.attempts,
    elapsedMs: watch.elapsedMs,
  };
}
