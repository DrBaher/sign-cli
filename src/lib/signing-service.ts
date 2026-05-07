import { readFileSync } from "node:fs";
import path from "node:path";
import { appendAuditEvent } from "./audit.js";
import {
  checkDocuSignAccountAccess,
  downloadDocuSignCombinedPdf,
  fetchDocuSignEnvelopeStatus,
  normalizeDocuSignStatus,
  sendDocuSignEnvelope,
} from "./docusign.js";
import type { SqliteDb } from "./db.js";
import {
  checkDropboxAccount,
  createEmbeddedSignatureRequest,
  downloadSignedPdf,
  fetchEmbeddedSignUrl,
  fetchSignatureRequestStatus,
  sendSignatureRequest,
} from "./dropbox-sign.js";
import {
  checkSignWellAccount,
  downloadSignWellCompletedPdf,
  fetchSignWellDocumentStatus,
  normalizeSignWellStatus,
  resolveSignWellBaseUrl,
  sendSignWellDocument,
} from "./signwell.js";
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
  if (provider !== "dropbox") {
    throw new Error(`Embedded signing is not yet supported for ${providerDisplayName(provider)}.`);
  }

  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const sendEmbedded = input.createEmbeddedRequest
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
    : () => getProviderApi(provider).sendEmbedded!({
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
  if (provider !== "dropbox") {
    throw new Error(`Embedded signing is not yet supported for ${providerDisplayName(provider)}.`);
  }

  const result = await getProviderApi(provider).getEmbeddedSignUrl!({
    signatureId: input.signatureId,
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
