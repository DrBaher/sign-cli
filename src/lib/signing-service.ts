import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendAuditEvent, verifyAuditChain, verifyAuditChainAsync } from "./audit.js";
import type { AuditVerificationResult } from "./audit.js";
import {
  checkDocuSignAccountAccess,
  downloadDocuSignCombinedPdf,
  fetchDocuSignEnvelopeStatus,
  getDocuSignRecipientView,
  normalizeDocuSignStatus,
  remindDocuSignEnvelope,
  sendDocuSignEnvelope,
  sendDocuSignEnvelopeFromTemplate,
  voidDocuSignEnvelope,
} from "./docusign.js";
import { asBackend, type DbBackend } from "./db-backend.js";
import type { SqliteDb } from "./db.js";
import {
  cancelDropboxSignatureRequest,
  checkDropboxAccount,
  createEmbeddedSignatureRequest,
  createEmbeddedSignatureRequestWithTemplate,
  downloadSignedPdf,
  fetchEmbeddedSignUrl,
  fetchSignatureRequestStatus,
  remindDropboxSignatureRequest,
  sendSignatureRequest,
  sendSignatureRequestWithTemplate,
} from "./dropbox-sign.js";
import {
  cancelSignWellDocument,
  checkSignWellAccount,
  downloadSignWellCompletedPdf,
  fetchSignWellDocumentStatus,
  fetchSignWellEmbeddedSignUrl,
  normalizeSignWellStatus,
  remindSignWellDocument,
  resolveSignWellBaseUrl,
  sendSignWellDocument,
  sendSignWellTemplateDocument,
} from "./signwell.js";
import {
  extractSignWellRecipientIds as extractSignWellWebhookRecipientIds,
  getSignWellWebhookDocument,
  normalizeSignWellEventType,
  verifySignWellCallback,
  type SignWellWebhookPayload,
} from "./signwell-webhook.js";
import {
  extractDocuSignSigners,
  getDocuSignEnvelopeSummary,
  normalizeDocuSignWebhookEventType,
  verifyDocuSignCallback,
  type DocuSignWebhookPayload,
} from "./docusign-webhook.js";
import { inspectPdfSignatures, type PdfSignatureReport, type TrustLabel } from "./pdf-signature.js";
import { digestForChainHead, inspectTimestampResponse, issueRfc3161Timestamp, type TimestampInspection } from "./timestamp.js";
import {
  parseFieldSpec,
  type SignatureField,
} from "./field-placement.js";
import type { ImageInput, StampPosition } from "./pdf-image-stamp.js";
import {
  cancelLocalDocument,
  checkLocalAccount,
  declineLocalDocument,
  downloadLocalCompletedPdf,
  fetchLocalDocumentStatus,
  fetchLocalEmbeddedSignUrl,
  getLocalDocumentSigningState,
  listLocalSignerInbox,
  normalizeLocalStatus,
  readLocalDocument,
  remindLocalDocument,
  sendLocalDocument,
  signLocalDocument,
  type LocalDocumentSigningState,
  type LocalSignerInboxEntry,
} from "./local-provider.js";
import { evaluatePolicy, type PolicyDecision, type PolicySpec } from "./policy-engine.js";
import { lookupIdempotencyKey, persistIdempotencyKey } from "./idempotency.js";
import { assertProviderMatchesPersisted, resolveSignProvider, type SignProvider } from "./providers.js";
import { SignCliError } from "./sign-error.js";
import {
  createId,
  createToken,
  nowIso,
  sha256,
  stableStringify,
  tokenHint,
} from "./util.js";
import type { PrefillInput, SignerInput } from "./util.js";
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
  documentPath?: string;
  documentPaths?: string[];
  signers: SignerInput[];
  fields?: SignatureField[];
  templateId?: string;
  prefills?: PrefillInput[];
  tokenTtlMinutes: number;
  autoApprove?: boolean;
  provider?: SignProvider;
  idempotencyKey?: string;
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
  documents_json: string | null;
  fields_json: string | null;
  template_id: string | null;
  prefills_json: string | null;
  created_at: string;
  updated_at: string;
};

export type RequestDocument = {
  path: string;
  hash: string;
  name: string;
};

function parseDocumentsJson(raw: string | null): RequestDocument[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RequestDocument =>
      entry && typeof entry.path === "string" && typeof entry.hash === "string" && typeof entry.name === "string");
  } catch {
    return [];
  }
}

export function getRequestDocuments(request: RequestRow): RequestDocument[] {
  const parsed = parseDocumentsJson(request.documents_json);
  if (parsed.length > 0) return parsed;
  if (request.template_id) return [];
  return [{ path: request.document_path, hash: request.document_hash, name: path.basename(request.document_path) }];
}

function parsePrefillsJson(raw: string | null): PrefillInput[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PrefillInput[]) : [];
  } catch {
    return [];
  }
}

export function getRequestPrefills(request: RequestRow): PrefillInput[] {
  return parsePrefillsJson(request.prefills_json);
}

function parseFieldsJson(raw: string | null): SignatureField[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SignatureField[]) : [];
  } catch {
    return [];
  }
}

export function getRequestFields(request: RequestRow): SignatureField[] {
  return parseFieldsJson(request.fields_json);
}

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
    documents: RequestDocument[];
    fields: SignatureField[];
    apiKey?: string;
    testMode: boolean;
  }): Promise<ProviderSendResult>;
  sendEmbedded?: (input: {
    request: RequestRow;
    signers: SignerInput[];
    documents: RequestDocument[];
    fields: SignatureField[];
    apiKey?: string;
    clientId?: string;
    testMode: boolean;
  }) => Promise<ProviderSendResult>;
  sendFromTemplate?: (input: {
    request: RequestRow;
    signers: SignerInput[];
    prefills: PrefillInput[];
    templateId: string;
    apiKey?: string;
    testMode: boolean;
  }) => Promise<ProviderSendResult>;
  sendFromTemplateEmbedded?: (input: {
    request: RequestRow;
    signers: SignerInput[];
    prefills: PrefillInput[];
    templateId: string;
    apiKey?: string;
    clientId?: string;
    testMode: boolean;
  }) => Promise<ProviderSendResult>;
  getEmbeddedSignUrl?: (input: {
    signatureId: string;
    providerRequestId?: string | null;
    apiKey?: string;
    returnUrl?: string;
    signers?: SignerInput[];
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
  remind?: (input: {
    providerRequestId: string;
    apiKey?: string;
    email?: string;
  }) => Promise<{ remoteResponse: unknown }>;
};

const GET_REQUEST_ROW_SQL = "SELECT * FROM requests WHERE id = ?";

function getRequestRow(db: SqliteDb | DbBackend, requestId: string): RequestRow {
  const row = asBackend(db).prepare(GET_REQUEST_ROW_SQL).get(requestId) as RequestRow | undefined;
  if (!row) {
    throw new Error(`Request not found: ${requestId}`);
  }
  return row;
}

// Async sibling. Same SQL, runs through prepareAsync so PostgresBackend works.
export async function getRequestRowAsync(backend: DbBackend, requestId: string): Promise<RequestRow> {
  const row = await backend.prepareAsync(GET_REQUEST_ROW_SQL).get(requestId) as RequestRow | undefined;
  if (!row) {
    throw new Error(`Request not found: ${requestId}`);
  }
  return row;
}

type InsertApprovalParams = {
  id: string;
  requestId: string;
  signerName: string;
  signerEmail: string;
  signerOrder: number;
  tokenHash: string;
  tokenHint: string;
  docHash: string;
  expiresAt: string;
  createdAt: string;
};

const INSERT_APPROVAL_SQL =
  `INSERT INTO approvals (
    id, request_id, signer_name, signer_email, signer_order, token_hash, token_hint, doc_hash, expires_at, used_at, approved_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertApprovalParams(input: InsertApprovalParams): unknown[] {
  return [
    input.id,
    input.requestId,
    input.signerName,
    input.signerEmail,
    input.signerOrder,
    input.tokenHash,
    input.tokenHint,
    input.docHash,
    input.expiresAt,
    null,
    null,
    input.createdAt,
  ];
}

function insertApprovalRow(db: SqliteDb, input: InsertApprovalParams): void {
  db.prepare(INSERT_APPROVAL_SQL).run(...insertApprovalParams(input) as Parameters<ReturnType<SqliteDb["prepare"]>["run"]>);
}

// Async sibling — same INSERT, runs through prepareAsync so PostgresBackend
// works. Used by future createSigningRequestAsync; existing sync paths keep
// using insertApprovalRow.
export async function insertApprovalRowAsync(backend: DbBackend, input: InsertApprovalParams): Promise<void> {
  await backend.prepareAsync(INSERT_APPROVAL_SQL).run(...insertApprovalParams(input));
}

function listApprovalRows(db: SqliteDb, requestId: string): ApprovalRow[] {
  return db.prepare("SELECT * FROM approvals WHERE request_id = ? ORDER BY signer_order ASC").all(requestId) as ApprovalRow[];
}

const UPDATE_REQUEST_STATUS_SQL = "UPDATE requests SET status = ?, updated_at = ? WHERE id = ?";

function updateRequestStatus(db: SqliteDb, requestId: string, status: string, now: Date): void {
  db.prepare(UPDATE_REQUEST_STATUS_SQL).run(status, nowIso(now), requestId);
}

// Async sibling — same UPDATE, runs through prepareAsync so PostgresBackend
// works. Placeholder translator handles the ?-to-$N rewrite.
export async function updateRequestStatusAsync(
  backend: DbBackend,
  requestId: string,
  status: string,
  now: Date,
): Promise<void> {
  await backend.prepareAsync(UPDATE_REQUEST_STATUS_SQL).run(status, nowIso(now), requestId);
}

const MARK_APPROVAL_USED_SQL = "UPDATE approvals SET used_at = ?, approved_at = ? WHERE id = ?";

function markApprovalUsed(db: SqliteDb, approvalId: string, nowStamp: string): void {
  db.prepare(MARK_APPROVAL_USED_SQL).run(nowStamp, nowStamp, approvalId);
}

// Async sibling — flips used_at/approved_at on one approval row.
export async function markApprovalUsedAsync(
  backend: DbBackend,
  approvalId: string,
  nowStamp: string,
): Promise<void> {
  await backend.prepareAsync(MARK_APPROVAL_USED_SQL).run(nowStamp, nowStamp, approvalId);
}

const MARK_ALL_REQUEST_APPROVALS_USED_SQL =
  "UPDATE approvals SET used_at = ?, approved_at = ? WHERE request_id = ?";

const REISSUE_APPROVAL_TOKEN_SQL =
  "UPDATE approvals SET token_hash = ?, token_hint = ?, expires_at = ? WHERE id = ?";

function reissueApprovalTokenRow(
  db: SqliteDb,
  approvalId: string,
  tokenHash: string,
  tokenHint: string,
  expiresAt: string,
): void {
  db.prepare(REISSUE_APPROVAL_TOKEN_SQL).run(tokenHash, tokenHint, expiresAt, approvalId);
}

// Async sibling — flips token_hash + token_hint + expires_at on one
// approval row. Used by future reissueSignerTokenAsync; existing sync paths
// keep using reissueApprovalTokenRow.
export async function reissueApprovalTokenRowAsync(
  backend: DbBackend,
  approvalId: string,
  tokenHash: string,
  tokenHint: string,
  expiresAt: string,
): Promise<void> {
  await backend.prepareAsync(REISSUE_APPROVAL_TOKEN_SQL).run(tokenHash, tokenHint, expiresAt, approvalId);
}

function markAllRequestApprovalsUsed(db: SqliteDb, requestId: string, nowStamp: string): void {
  db.prepare(MARK_ALL_REQUEST_APPROVALS_USED_SQL).run(nowStamp, nowStamp, requestId);
}

// Async sibling — auto-approve path. Flips used_at/approved_at on every
// approval row for a request in one UPDATE.
export async function markAllRequestApprovalsUsedAsync(
  backend: DbBackend,
  requestId: string,
  nowStamp: string,
): Promise<void> {
  await backend.prepareAsync(MARK_ALL_REQUEST_APPROVALS_USED_SQL).run(nowStamp, nowStamp, requestId);
}

const INSERT_ARTIFACT_SQL =
  `INSERT INTO artifacts (id, request_id, kind, path, content_hash, metadata_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`;

export type InsertArtifactParams = {
  id: string;
  requestId: string;
  kind: string;
  path: string;
  contentHash: string;
  metadataJson: string;
  createdAt: string;
};

function insertArtifactParams(input: InsertArtifactParams): unknown[] {
  return [
    input.id, input.requestId, input.kind, input.path,
    input.contentHash, input.metadataJson, input.createdAt,
  ];
}

export function insertArtifactRow(db: SqliteDb, input: InsertArtifactParams): void {
  db.prepare(INSERT_ARTIFACT_SQL).run(...insertArtifactParams(input) as Parameters<ReturnType<SqliteDb["prepare"]>["run"]>);
}

// Async sibling — same INSERT, runs through prepareAsync. Used by future
// async-write paths (export/timestamp/anchor) when targeting Postgres.
export async function insertArtifactRowAsync(backend: DbBackend, input: InsertArtifactParams): Promise<void> {
  await backend.prepareAsync(INSERT_ARTIFACT_SQL).run(...insertArtifactParams(input));
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

/** Public helper used by the CLI's strict-provider preflight: looks up the
 *  provider a request was created against without exposing the whole request
 *  row. Throws if the request doesn't exist. */
export function getPersistedProviderForRequest(db: SqliteDb, requestId: string): SignProvider {
  return getPersistedProvider(getRequestRow(db, requestId));
}

function getProviderRequestId(request: RequestRow): string | null {
  return request.provider_request_id ?? request.dropbox_signature_request_id;
}

function getProviderStatusValue(request: RequestRow): string | null {
  return request.provider_status ?? request.dropbox_status;
}

type PersistRequestProviderMetadataInput = {
  requestId: string;
  provider: SignProvider;
  providerRequestId?: string | null;
  providerStatus?: string | null;
  signatureIds?: string[];
  now: Date;
};

const PERSIST_REQUEST_PROVIDER_METADATA_SQL =
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
     WHERE id = ?`;

function persistRequestProviderMetadataParams(input: PersistRequestProviderMetadataInput): unknown[] {
  const signatureIdsJson = input.signatureIds ? stableStringify(input.signatureIds) : null;
  const dropboxRequestId = input.provider === "dropbox" ? input.providerRequestId ?? null : null;
  const dropboxStatus = input.provider === "dropbox" ? input.providerStatus ?? null : null;
  return [
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
  ];
}

function persistRequestProviderMetadata(db: SqliteDb, input: PersistRequestProviderMetadataInput): void {
  db.prepare(PERSIST_REQUEST_PROVIDER_METADATA_SQL).run(...persistRequestProviderMetadataParams(input) as Parameters<ReturnType<SqliteDb["prepare"]>["run"]>);
}

// Async sibling — same multi-column CASE UPDATE that records provider state
// after a send/status-poll. 11 placeholders, every one routed through
// prepareAsync so PostgresBackend works.
export async function persistRequestProviderMetadataAsync(
  backend: DbBackend,
  input: PersistRequestProviderMetadataInput,
): Promise<void> {
  await backend.prepareAsync(PERSIST_REQUEST_PROVIDER_METADATA_SQL).run(...persistRequestProviderMetadataParams(input));
}

function serializeRequestRow(request: RequestRow): RequestRow & { signatureIds: string[]; documents: RequestDocument[]; fields: SignatureField[]; prefills: PrefillInput[]; normalizedProvider: SignProvider } {
  return {
    ...request,
    provider: request.provider ?? getPersistedProvider(request),
    provider_request_id: getProviderRequestId(request),
    provider_status: getProviderStatusValue(request),
    signatureIds: parseSignatureIdsJson(request.signature_ids_json),
    documents: getRequestDocuments(request),
    fields: getRequestFields(request),
    prefills: getRequestPrefills(request),
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
  if (provider === "local") {
    return normalizeLocalStatus(remoteStatus);
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
          documentPath: input.documents[0].path,
          documentPaths: input.documents.map((doc) => doc.path),
          title: input.request.title,
          signers: input.signers,
          fields: input.fields,
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
      async sendEmbedded(input) {
        const result = await sendDocuSignEnvelope({
          documentPath: input.documents[0].path,
          documentPaths: input.documents.map((doc) => doc.path),
          title: input.request.title,
          signers: input.signers,
          fields: input.fields,
          metadata: {
            request_id: input.request.id,
            document_hash: input.request.document_hash,
          },
          embeddedSigning: true,
        });
        return {
          providerRequestId: result.envelopeId,
          signatureIds: result.recipientIds,
          providerStatus: "sent",
          responseBody: result.responseBody,
        };
      },
      async getEmbeddedSignUrl(input) {
        if (!input.providerRequestId) {
          throw new Error("DocuSign embedded sign URL requires the envelope id.");
        }
        if (!input.returnUrl) {
          throw new Error("DocuSign embedded signing requires --return-url.");
        }
        const signers = input.signers ?? [];
        const sortedSigners = signers.slice().sort((left, right) => left.order - right.order);
        const recipientIndex = sortedSigners.findIndex((_, index) => String(index + 1) === input.signatureId);
        const matchedByEmail = recipientIndex === -1 ? sortedSigners.findIndex((signer) => signer.email === input.signatureId) : -1;
        const resolvedIndex = recipientIndex !== -1 ? recipientIndex : matchedByEmail;
        const signer = resolvedIndex !== -1 ? sortedSigners[resolvedIndex] : null;
        if (!signer) {
          throw new Error(`DocuSign embedded signing could not resolve signer for signature-id=${input.signatureId}.`);
        }
        const recipientId = String(resolvedIndex + 1);
        const result = await getDocuSignRecipientView({
          envelopeId: input.providerRequestId,
          signerEmail: signer.email,
          signerName: signer.name,
          recipientId,
          returnUrl: input.returnUrl,
        });
        return { signUrl: result.url, expiresAt: null };
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
      async remind(input) {
        const remoteResponse = await remindDocuSignEnvelope(input.providerRequestId);
        return { remoteResponse };
      },
      async sendFromTemplate(input) {
        const result = await sendDocuSignEnvelopeFromTemplate({
          templateId: input.templateId,
          title: input.request.title,
          signers: input.signers,
          prefills: input.prefills,
          metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
        });
        return {
          providerRequestId: result.envelopeId,
          signatureIds: result.recipientIds,
          providerStatus: "sent",
          responseBody: result.responseBody,
        };
      },
      async sendFromTemplateEmbedded(input) {
        const result = await sendDocuSignEnvelopeFromTemplate({
          templateId: input.templateId,
          title: input.request.title,
          signers: input.signers,
          prefills: input.prefills,
          metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
          embeddedSigning: true,
        });
        return {
          providerRequestId: result.envelopeId,
          signatureIds: result.recipientIds,
          providerStatus: "sent",
          responseBody: result.responseBody,
        };
      },
    };
  }

  if (provider === "signwell") {
    return {
      async send(input) {
        const result = await sendSignWellDocument({
          apiKey: input.apiKey ?? "",
          baseUrl: resolveSignWellBaseUrl(),
          documentPath: input.documents[0].path,
          documentPaths: input.documents.map((doc) => doc.path),
          title: input.request.title,
          signers: input.signers,
          fields: input.fields,
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
          documentPath: input.documents[0].path,
          documentPaths: input.documents.map((doc) => doc.path),
          title: input.request.title,
          signers: input.signers,
          fields: input.fields,
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
      async remind(input) {
        const remoteResponse = await remindSignWellDocument(input.apiKey ?? "", input.providerRequestId, resolveSignWellBaseUrl());
        return { remoteResponse };
      },
      async sendFromTemplate(input) {
        const result = await sendSignWellTemplateDocument({
          apiKey: input.apiKey ?? "",
          baseUrl: resolveSignWellBaseUrl(),
          templateId: input.templateId,
          title: input.request.title,
          signers: input.signers,
          prefills: input.prefills,
          metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
          testMode: input.testMode,
        });
        return {
          providerRequestId: result.documentId,
          signatureIds: result.recipientIds,
          providerStatus: result.status || "sent",
          responseBody: result.responseBody,
        };
      },
      async sendFromTemplateEmbedded(input) {
        const result = await sendSignWellTemplateDocument({
          apiKey: input.apiKey ?? "",
          baseUrl: resolveSignWellBaseUrl(),
          templateId: input.templateId,
          title: input.request.title,
          signers: input.signers,
          prefills: input.prefills,
          metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
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
    };
  }

  if (provider === "local") {
    function localSendCommon(input: { request: RequestRow; signers: SignerInput[]; documents: RequestDocument[]; embedded: boolean; templateId?: string; prefills?: PrefillInput[]; fields?: SignatureField[] }) {
      const result = sendLocalDocument({
        documentPath: input.documents[0]?.path,
        documentPaths: input.documents.map((doc) => doc.path),
        templateId: input.templateId,
        title: input.request.title,
        signers: input.signers,
        prefills: input.prefills,
        metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
        embeddedSigning: input.embedded,
        fields: input.fields,
      });
      return {
        providerRequestId: result.documentId,
        signatureIds: result.recipientIds,
        providerStatus: "sent",
        responseBody: result.responseBody,
      };
    }
    return {
      async send(input) {
        return localSendCommon({ request: input.request, signers: input.signers, documents: input.documents, fields: input.fields, embedded: false });
      },
      async sendEmbedded(input) {
        return localSendCommon({ request: input.request, signers: input.signers, documents: input.documents, fields: input.fields, embedded: true });
      },
      async getEmbeddedSignUrl(input) {
        if (!input.providerRequestId) throw new Error("Local embedded sign URL requires the document id.");
        const result = fetchLocalEmbeddedSignUrl(input.providerRequestId, input.signatureId);
        return result;
      },
      async getStatus(input) {
        const remoteStatus = fetchLocalDocumentStatus(input.providerRequestId);
        return {
          providerStatus: normalizeLocalStatus(remoteStatus),
          signatureIds: Array.isArray((remoteStatus as any)?.recipients)
            ? (remoteStatus as any).recipients
              .map((recipient: any) => recipient?.id)
              .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
            : [],
          remoteStatus,
        };
      },
      async downloadFinalPdf(input) {
        return downloadLocalCompletedPdf(input.providerRequestId);
      },
      async cancel(input) {
        const remoteResponse = cancelLocalDocument(input.providerRequestId);
        return { remoteResponse };
      },
      async remind(input) {
        const remoteResponse = remindLocalDocument(input.providerRequestId);
        return { remoteResponse };
      },
      async sendFromTemplate(input) {
        return localSendCommon({
          request: input.request,
          signers: input.signers,
          documents: [],
          embedded: false,
          templateId: input.templateId,
          prefills: input.prefills,
        });
      },
      async sendFromTemplateEmbedded(input) {
        return localSendCommon({
          request: input.request,
          signers: input.signers,
          documents: [],
          embedded: true,
          templateId: input.templateId,
          prefills: input.prefills,
        });
      },
    };
  }

  return {
    async send(input) {
      const result = await sendSignatureRequest({
        apiKey: input.apiKey ?? "",
        documentPath: input.documents[0].path,
        documentPaths: input.documents.map((doc) => doc.path),
        title: input.request.title,
        signers: input.signers,
        fields: input.fields,
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
        documentPath: input.documents[0].path,
        documentPaths: input.documents.map((doc) => doc.path),
        title: input.request.title,
        signers: input.signers,
        fields: input.fields,
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
    async remind(input) {
      if (!input.email) {
        throw new Error("Dropbox Sign reminders require --email <signer email>.");
      }
      const remoteResponse = await remindDropboxSignatureRequest(input.apiKey ?? "", input.providerRequestId, input.email);
      return { remoteResponse };
    },
    async sendFromTemplate(input) {
      const result = await sendSignatureRequestWithTemplate({
        apiKey: input.apiKey ?? "",
        templateId: input.templateId,
        title: input.request.title,
        signers: input.signers,
        prefills: input.prefills,
        metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
        testMode: input.testMode,
      });
      return {
        providerRequestId: result.signatureRequestId,
        signatureIds: result.signatureIds,
        providerStatus: "sent",
        responseBody: result.responseBody,
      };
    },
    async sendFromTemplateEmbedded(input) {
      const result = await createEmbeddedSignatureRequestWithTemplate({
        apiKey: input.apiKey ?? "",
        clientId: input.clientId ?? "",
        templateId: input.templateId,
        title: input.request.title,
        signers: input.signers,
        prefills: input.prefills,
        metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
        testMode: input.testMode,
      });
      return {
        providerRequestId: result.signatureRequestId,
        signatureIds: result.signatureIds,
        providerStatus: "sent",
        responseBody: result.responseBody,
      };
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

export type CreateRequestResult = {
  requestId: string;
  documentHash: string;
  documents: RequestDocument[];
  templateId: string | null;
  tokens: Array<{ signer: SignerInput; token: string; expiresAt: string }>;
  idempotent?: boolean;
};

export function createSigningRequest(
  db: SqliteDb,
  input: CreateRequestInput,
): CreateRequestResult {
  if (input.idempotencyKey) {
    const cached = lookupIdempotencyKey<CreateRequestResult>(db, "request.create", input.idempotencyKey);
    if (cached.hit) {
      return { ...cached.value, idempotent: true };
    }
  }
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
  const isTemplate = Boolean(input.templateId);
  const allPaths = (input.documentPaths && input.documentPaths.length > 0
    ? input.documentPaths
    : input.documentPath ? [input.documentPath] : []);
  if (!isTemplate && allPaths.length === 0) {
    throw new Error("At least one --document is required (or pass --template-id for a template request).");
  }
  if (isTemplate && allPaths.length > 0) {
    throw new Error("--template-id and --document cannot be combined; pass one or the other.");
  }
  for (const signer of sortedSigners) {
    if (isTemplate && !signer.role) {
      throw new Error(`Template requests need role:<name> on every --signer (signer "${signer.email}" is missing role).`);
    }
  }
  const documents: RequestDocument[] = isTemplate ? [] : allPaths.map((rawPath) => {
    const resolved = path.resolve(rawPath);
    return {
      path: resolved,
      hash: sha256(readFileSync(resolved)),
      name: path.basename(resolved),
    };
  });
  const templateMarker = isTemplate ? `template:${input.templateId!}` : null;
  const primaryPath = templateMarker ?? documents[0].path;
  const primaryHash = templateMarker ? sha256(templateMarker) : documents[0].hash;
  const signersJson = stableStringify(sortedSigners);
  const documentsJson = documents.length > 0 ? stableStringify(documents) : null;
  const fields = input.fields ?? [];
  const knownOrders = new Set(sortedSigners.map((signer) => signer.order));
  for (const field of fields) {
    if (!knownOrders.has(field.signerOrder)) {
      throw new Error(`Field references signer:${field.signerOrder}, but no --signer with that order was provided.`);
    }
    if (!isTemplate && field.documentIndex >= documents.length) {
      throw new Error(`Field doc:${field.documentIndex} is out of range (only ${documents.length} document(s) attached).`);
    }
  }
  const fieldsJson = fields.length > 0 ? JSON.stringify(fields) : null;
  const prefills = input.prefills ?? [];
  for (const prefill of prefills) {
    if (prefill.signerOrder !== undefined && !knownOrders.has(prefill.signerOrder)) {
      throw new Error(`Prefill references signer:${prefill.signerOrder}, but no --signer with that order was provided.`);
    }
  }
  const prefillsJson = prefills.length > 0 ? JSON.stringify(prefills) : null;

  db.prepare(
    `INSERT INTO requests (
      id, title, document_path, document_hash, status, provider, provider_request_id, provider_status, dropbox_signature_request_id, dropbox_status, signature_ids_json, signers_json, documents_json, fields_json, template_id, prefills_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    input.title,
    primaryPath,
    primaryHash,
    "created",
    input.provider ?? null,
    null,
    null,
    null,
    null,
    null,
    signersJson,
    documentsJson,
    fieldsJson,
    input.templateId ?? null,
    prefillsJson,
    createdAt,
    createdAt,
  );

  for (const document of documents) {
    insertArtifactRow(db, {
      id: createId("art"),
      requestId,
      kind: "document",
      path: document.path,
      contentHash: document.hash,
      metadataJson: stableStringify({ title: input.title, name: document.name }),
      createdAt,
    });
  }

  const tokens = sortedSigners.map((signer) => {
    const token = createToken();
    const expiresAt = nowIso(new Date(now.getTime() + input.tokenTtlMinutes * 60_000));
    insertApprovalRow(db, {
      id: createId("apr"),
      requestId,
      signerName: signer.name,
      signerEmail: signer.email,
      signerOrder: signer.order,
      tokenHash: sha256(token),
      tokenHint: tokenHint(token),
      docHash: primaryHash,
      expiresAt,
      createdAt,
    });
    return { signer, token, expiresAt };
  });

  if (input.autoApprove) {
    markAllRequestApprovalsUsed(db, requestId, createdAt);
    updateRequestStatus(db, requestId, "approved", now);
  }

  appendAuditEvent(db, {
    requestId,
    eventType: "request.created",
    payload: {
      title: input.title,
      documentPath: primaryPath,
      documentHash: primaryHash,
      documents,
      fields,
      templateId: input.templateId ?? null,
      prefills,
      provider: input.provider ?? null,
      signers: sortedSigners,
      tokenTtlMinutes: input.tokenTtlMinutes,
      autoApprove: Boolean(input.autoApprove),
    },
    now,
  });

  const result: CreateRequestResult = {
    requestId,
    documentHash: primaryHash,
    documents,
    tokens,
    templateId: input.templateId ?? null,
  };
  if (input.idempotencyKey) {
    persistIdempotencyKey(db, {
      scope: "request.create",
      key: input.idempotencyKey,
      requestId,
      value: result,
      now,
    });
  }
  return result;
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
  markApprovalUsed(db, approval.id, nowStamp);

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
    force?: boolean;
    now?: Date;
    providerSend?: () => Promise<ProviderSendResult>;
    sendRequest?: typeof sendSignatureRequest;
    /** When true and `provider` is supplied, fail loudly if it doesn't match
     *  the provider the request was created against. Drives the strict-mode
     *  feature from Item 1 of the product-readiness feedback. */
    strictProvider?: boolean;
  },
): Promise<{
  provider: SignProvider;
  signatureRequestId: string;
  signatureIds: string[];
  responseBody: unknown;
  idempotent: boolean;
}> {
  const request = getRequestRow(db, input.requestId);
  if (request.provider_request_id && !input.force) {
    appendAuditEvent(db, {
      requestId: input.requestId,
      eventType: "request.send_skipped",
      payload: {
        reason: "already_sent",
        provider: request.provider ?? input.provider ?? null,
        providerRequestId: request.provider_request_id,
      },
      now: input.now ?? new Date(),
    });
    return {
      provider: (request.provider as SignProvider | null) ?? (input.provider ?? "dropbox"),
      signatureRequestId: request.provider_request_id,
      signatureIds: parseSignatureIdsJson(request.signature_ids_json),
      responseBody: { idempotent: true, reason: "already_sent" },
      idempotent: true,
    };
  }
  const persistedProvider = getPersistedProvider(request);
  if (input.provider !== undefined && input.strictProvider) {
    assertProviderMatchesPersisted(input.provider, persistedProvider, true);
  }
  const provider = input.provider ?? persistedProvider;
  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const documents = getRequestDocuments(request);
  const fields = getRequestFields(request);
  const prefills = getRequestPrefills(request);
  const templateId = request.template_id;
  const providerApi = getProviderApi(provider);
  const send = input.providerSend
    ? input.providerSend
    : templateId
      ? () => {
        if (!providerApi.sendFromTemplate) {
          throw new Error(`Template send is not supported for ${providerDisplayName(provider)}.`);
        }
        return providerApi.sendFromTemplate({
          request,
          signers,
          prefills,
          templateId,
          apiKey: input.apiKey,
          testMode: input.testMode,
        });
      }
      : input.sendRequest && provider === "dropbox"
        ? async () => {
          const result = await input.sendRequest!({
            apiKey: input.apiKey ?? "",
            documentPath: documents[0].path,
            documentPaths: documents.map((doc) => doc.path),
            title: request.title,
            signers,
            fields,
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
        : () => providerApi.send({ request, signers, documents, fields, apiKey: input.apiKey, testMode: input.testMode });

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
    idempotent: false,
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

  if (input.provider === "local") {
    return {
      provider: "local",
      account: checkLocalAccount(),
      interpretation: {
        apiLikelyEnabled: true,
        note: "Local provider always available; no remote API call. Demo / test only.",
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
    {
      provider: "local",
      displayName: "Local simulator (demo / tests)",
      capabilities: {
        emailSend: true,
        embeddedSigning: true,
        webhooks: false,
        finalPdfDownload: true,
        testMode: true,
        accountCheck: true,
      },
      config: {
        configured: true,
        missing: [],
        detected: {
          SIGN_LOCAL_STORE_DIR: process.env.SIGN_LOCAL_STORE_DIR ?? "./data/local-provider",
          SIGN_LOCAL_KEY_DIR: process.env.SIGN_LOCAL_KEY_DIR ?? "./data/local-keys",
          SIGN_LOCAL_COMPLETE_AFTER: process.env.SIGN_LOCAL_COMPLETE_AFTER ?? null,
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

  insertArtifactRow(db, {
    id: createId("art"),
    requestId: request.id,
    kind: "signed_pdf",
    path: outPath,
    contentHash: hash,
    metadataJson: stableStringify({ bytes: pdf.length, provider }),
    createdAt: nowIso(now),
  });

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
  const providerApi = getProviderApi(provider);
  const templateId = request.template_id;
  if (templateId && !providerApi.sendFromTemplateEmbedded) {
    throw new Error(`Embedded template signing is not yet supported for ${providerDisplayName(provider)}.`);
  }
  if (!templateId && !providerApi.sendEmbedded) {
    throw new Error(`Embedded signing is not yet supported for ${providerDisplayName(provider)}.`);
  }

  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const documents = getRequestDocuments(request);
  const fields = getRequestFields(request);
  const prefills = getRequestPrefills(request);
  const sendEmbedded = templateId
    ? () => providerApi.sendFromTemplateEmbedded!({
      request,
      signers,
      prefills,
      templateId,
      apiKey: input.apiKey,
      clientId: input.clientId,
      testMode: input.testMode,
    })
    : input.createEmbeddedRequest && provider === "dropbox"
      ? async () => {
        const result = await input.createEmbeddedRequest!({
          apiKey: input.apiKey ?? "",
          clientId: input.clientId ?? "",
          documentPath: documents[0].path,
          documentPaths: documents.map((doc) => doc.path),
          title: request.title,
          signers,
          fields,
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
        documents,
        fields,
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
  input: { requestId: string; provider?: SignProvider; signatureId: string; apiKey?: string; returnUrl?: string; now?: Date },
): Promise<{ signUrl: string; expiresAt: number | null; signatureId: string }> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  const providerApi = getProviderApi(provider);
  if (!providerApi.getEmbeddedSignUrl) {
    throw new Error(`Embedded signing is not yet supported for ${providerDisplayName(provider)}.`);
  }

  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const result = await providerApi.getEmbeddedSignUrl({
    signatureId: input.signatureId,
    providerRequestId: getProviderRequestId(request),
    apiKey: input.apiKey,
    returnUrl: input.returnUrl,
    signers,
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
  if (provider === "local") {
    return "Local simulator";
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

export type AuditEventRow = {
  id: number;
  event_type: string;
  payload_json: string;
  hash_prev: string | null;
  hash_self: string;
  created_at: string;
};

const LIST_AUDIT_EVENTS_SQL =
  `SELECT id, event_type, payload_json, hash_prev, hash_self, created_at
   FROM audit_events
   WHERE request_id = ?
   ORDER BY id ASC`;

export function listAuditEvents(db: SqliteDb | DbBackend, requestId: string): AuditEventRow[] {
  return asBackend(db).prepare(LIST_AUDIT_EVENTS_SQL).all(requestId) as AuditEventRow[];
}

// Async variant — same query via prepareAsync so PostgresBackend works.
export async function listAuditEventsAsync(backend: DbBackend, requestId: string): Promise<AuditEventRow[]> {
  return await backend.prepareAsync(LIST_AUDIT_EVENTS_SQL).all(requestId) as AuditEventRow[];
}

// SQLite uses INSERT OR IGNORE; Postgres uses INSERT … ON CONFLICT DO NOTHING.
// The semantics are identical: insert wins ⇒ changes/rowCount = 1, conflict ⇒ 0.
const CLAIM_WEBHOOK_SQL_SQLITE =
  `INSERT OR IGNORE INTO webhook_dedupe (provider, event_key, request_id, first_seen_at)
   VALUES (?, ?, ?, ?)`;
const CLAIM_WEBHOOK_SQL_POSTGRES =
  `INSERT INTO webhook_dedupe (provider, event_key, request_id, first_seen_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT (provider, event_key) DO NOTHING`;

function tryClaimWebhookEvent(
  db: SqliteDb,
  input: { provider: "dropbox" | "signwell" | "docusign"; eventKey: string; requestId: string | null; now: Date },
): boolean {
  const result = db.prepare(CLAIM_WEBHOOK_SQL_SQLITE).run(
    input.provider, input.eventKey, input.requestId, nowIso(input.now),
  );
  return result.changes === 1;
}

// Async sibling. Picks the right INSERT dialect based on backend.kind so
// PostgresBackend gets ON CONFLICT DO NOTHING and SqliteBackend keeps INSERT
// OR IGNORE. Returns true exactly when this caller is the first to claim
// (provider, event_key).
export async function tryClaimWebhookEventAsync(
  backend: DbBackend,
  input: { provider: "dropbox" | "signwell" | "docusign"; eventKey: string; requestId: string | null; now: Date },
): Promise<boolean> {
  const sql = backend.kind === "postgres" ? CLAIM_WEBHOOK_SQL_POSTGRES : CLAIM_WEBHOOK_SQL_SQLITE;
  const result = await backend.prepareAsync(sql).run(
    input.provider, input.eventKey, input.requestId, nowIso(input.now),
  );
  return result.changes === 1;
}

export function ingestDocuSignWebhookPayload(
  db: SqliteDb,
  input: {
    payload: DocuSignWebhookPayload;
    secret: string;
    rawBody: string | Buffer;
    signatureHeader?: string | string[] | null;
    requestId?: string;
    now?: Date;
  },
): {
  verified: boolean;
  replayed: boolean;
  requestId: string | null;
  eventType: string | null;
  normalizedEventType: string;
  providerStatus: string | null;
} {
  const verified = verifyDocuSignCallback(input.secret, input.rawBody, input.signatureHeader ?? null);
  const eventType = input.payload.event ?? null;
  const normalizedEventType = normalizeDocuSignWebhookEventType(eventType);
  const summary = getDocuSignEnvelopeSummary(input.payload);
  const requestId = input.requestId ?? summary.metadataRequestId ?? null;
  const providerStatus = summary.status ? summary.status.toLowerCase() : normalizedEventType;

  if (!requestId) {
    return { verified, replayed: false, requestId: null, eventType, normalizedEventType, providerStatus };
  }

  getRequestRow(db, requestId);

  const now = input.now ?? new Date();
  // Dedupe key: hash of the raw body. DocuSign Connect doesn't expose a stable event id in the body;
  // identical bodies are necessarily replays.
  const bodyHash = sha256(typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody);

  if (verified) {
    const claimed = tryClaimWebhookEvent(db, { provider: "docusign", eventKey: bodyHash, requestId, now });
    if (!claimed) {
      appendAuditEvent(db, {
        requestId,
        eventType: `docusign.webhook.${eventType ?? "unknown"}.replay`,
        payload: { verified, normalizedEventType, providerStatus, eventKey: bodyHash },
        now,
      });
      return { verified, replayed: true, requestId, eventType, normalizedEventType, providerStatus };
    }
  }

  appendAuditEvent(db, {
    requestId,
    eventType: `docusign.webhook.${eventType ?? "unknown"}`,
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
      provider: "docusign",
      providerRequestId: summary.envelopeId ?? undefined,
      providerStatus,
      now,
    });

    for (const signer of extractDocuSignSigners(input.payload)) {
      const email = (signer.email ?? "").toString().trim();
      if (!email) continue;
      if (!signer.signedDateTime) continue;
      recordSignerSigningState(db, {
        requestId,
        signerEmail: email,
        signerName: typeof signer.name === "string" ? signer.name : undefined,
        signedAt: new Date(signer.signedDateTime).toISOString(),
        source: "docusign",
        now,
      });
    }
  }

  return { verified, replayed: false, requestId, eventType, normalizedEventType, providerStatus };
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
): { verified: boolean; replayed: boolean; requestId: string | null; eventType: string | null; normalizedEventType: string; providerStatus: string | null } {
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
      replayed: false,
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

  // Dedupe via event.hash (SignWell's per-delivery HMAC). Falls back to a stableStringify hash of
  // (event + document.id + status) when the field is absent.
  const providedHash = (input.payload as { event?: { hash?: unknown } })?.event?.hash;
  const eventKey = typeof providedHash === "string" && providedHash.length > 0
    ? providedHash
    : sha256(stableStringify({ eventType, documentId, providerStatus }));
  if (verified) {
    const claimed = tryClaimWebhookEvent(db, { provider: "signwell", eventKey, requestId, now });
    if (!claimed) {
      appendAuditEvent(db, {
        requestId,
        eventType: `signwell.webhook.${eventType ?? "unknown"}.replay`,
        payload: { verified, normalizedEventType, providerStatus, eventKey },
        now,
      });
      return { verified, replayed: true, requestId, eventType, normalizedEventType, providerStatus };
    }
  }

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

    // Map SignWell recipient IDs back to signers (recipient.id is "1","2",... matching signer.order).
    const recipients = Array.isArray((document as { recipients?: unknown })?.recipients)
      ? ((document as { recipients?: Array<{ id?: string; signed_at?: string | null; status?: string }> }).recipients ?? [])
      : [];
    if (recipients.length > 0) {
      try {
        const requestRow = getRequestRow(db, requestId);
        const signers = JSON.parse(requestRow.signers_json) as SignerInput[];
        const signersByOrder = new Map(signers.map((s) => [s.order, s]));
        for (const recipient of recipients) {
          if (!recipient.signed_at) continue;
          const order = Number(recipient.id ?? "0");
          const signer = Number.isFinite(order) ? signersByOrder.get(order) : undefined;
          if (!signer) continue;
          recordSignerSigningState(db, {
            requestId,
            signerEmail: signer.email,
            signerName: signer.name,
            signedAt: recipient.signed_at,
            source: "signwell",
            now,
          });
        }
      } catch {
        // Best-effort; webhook should never throw from a missing/malformed signer row.
      }
    }
  }

  return {
    verified,
    replayed: false,
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
): { verified: boolean; replayed: boolean; requestId: string | null; eventType: string | null } {
  const verified = verifyDropboxCallback(input.apiKey, input.payload);
  const requestId =
    input.requestId ??
    input.payload.signature_request?.metadata?.request_id ??
    null;
  const eventType = input.payload.event?.event_type ?? null;

  if (!requestId) {
    return { verified, replayed: false, requestId: null, eventType };
  }

  getRequestRow(db, requestId);

  const now = input.now ?? new Date();
  // Dedupe via Dropbox's event_hash (per-delivery HMAC of event_time+event_type with the API key).
  // Falls back to a (eventType, signatureRequestId, eventTime) hash when absent.
  const providedHash = input.payload.event?.event_hash;
  const eventKey = typeof providedHash === "string" && providedHash.length > 0
    ? providedHash
    : sha256(stableStringify({
        eventType,
        signatureRequestId: input.payload.signature_request?.signature_request_id ?? null,
        eventTime: input.payload.event?.event_time ?? null,
      }));
  if (verified) {
    const claimed = tryClaimWebhookEvent(db, { provider: "dropbox", eventKey, requestId, now });
    if (!claimed) {
      appendAuditEvent(db, {
        requestId,
        eventType: `dropbox.webhook.${eventType ?? "unknown"}.replay`,
        payload: { verified, eventKey },
        now,
      });
      return { verified, replayed: true, requestId, eventType };
    }
  }

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

    const signatures = Array.isArray(input.payload.signature_request?.signatures)
      ? (input.payload.signature_request!.signatures as Array<{ signer_email_address?: string; signer_email?: string; signer_name?: string; signed_at?: number | string | null }>)
      : [];
    for (const sig of signatures) {
      const email = (sig.signer_email_address ?? sig.signer_email ?? "").toString().trim();
      if (!email) continue;
      if (sig.signed_at === null || sig.signed_at === undefined) continue;
      const signedAt = typeof sig.signed_at === "number"
        ? new Date(sig.signed_at * 1000).toISOString()
        : new Date(sig.signed_at).toISOString();
      recordSignerSigningState(db, {
        requestId,
        signerEmail: email,
        signerName: sig.signer_name,
        signedAt,
        source: "dropbox",
        now,
      });
    }
  }

  return { verified, replayed: false, requestId, eventType };
}

export type EnrichedApproval = ApprovalRow & {
  tokenHint: string;
  expiresAt: string;
  approvedAt: string | null;
  usedAt: string | null;
  expired: boolean;
  signed: boolean;
};

export type SnapshotSignedByEntry = {
  email: string;
  name: string;
  signedAt: string;
  certFingerprintSha256?: string;
  certSubjectCommonName?: string;
  source?: string;
};

export type RequestSnapshotMetrics = {
  totalSigners: number;
  signedCount: number;
  pendingCount: number;
  declined: boolean;
  eventsTotal: number;
  eventsLastHour: number;
  fetchesLastHour: number;
  webhookReplaysLastHour: number;
  ageSeconds: number;
  timeToFirstSignSeconds: number | null;
  timeToCompleteSeconds: number | null;
};

export type RequestSnapshot = {
  request: RequestRow & {
    signatureIds: string[];
    normalizedProvider: SignProvider;
    documents: RequestDocument[];
    fields: SignatureField[];
    prefills: PrefillInput[];
  };
  approvals: EnrichedApproval[];
  signedBy: SnapshotSignedByEntry[] | null;
  declinedBy: string | null;
  declineReason: string | null;
  nextSteps: string[];
  metrics?: RequestSnapshotMetrics;
};

function buildNextSteps(input: {
  request: RequestRow & { normalizedProvider: SignProvider };
  approvals: EnrichedApproval[];
  signingState: LocalDocumentSigningState | null;
}): string[] {
  const { request, approvals, signingState } = input;
  const status = (request.status ?? "").toLowerCase();
  const provider = request.normalizedProvider;
  const steps: string[] = [];

  if (status === "created") {
    steps.push(`Run \`sign request send --request-id ${request.id} --provider ${provider}\` to dispatch.`);
    return steps;
  }

  if (status === "canceled" || status === "declined") {
    steps.push(`Request is terminal (status=${status}). Start a new request if needed.`);
    return steps;
  }

  if (status === "completed") {
    steps.push(`Run \`sign request fetch-final --request-id ${request.id} --provider ${provider}\` to download the signed PDF.`);
    steps.push(`Run \`sign audit verify --request-id ${request.id}\` to confirm the audit chain.`);
    return steps;
  }

  // status is "sent" / "partially_approved" / etc.
  if (provider === "local") {
    const pending = approvals.filter((approval) => !approval.signed);
    if (pending.length === 0) {
      steps.push(`All signers have signed; status will flip to completed on the next \`request status\` poll.`);
    }
    for (const approval of pending) {
      const expiryNote = approval.expired ? "EXPIRED" : `expires ${approval.expiresAt}`;
      steps.push(
        `Signer ${approval.signer_email} still needs to sign — token tokenHint=${approval.tokenHint} (${expiryNote}). ` +
        `Run \`sign sign --request-id ${request.id} --token <signer-token>\`.`,
      );
    }
    if (signingState?.declinedBy) {
      steps.push(`A signer declined (${signingState.declinedBy}); the request will not auto-recover.`);
    }
  } else {
    steps.push(`Use the provider's email or embedded sign URL to sign — signer-side commands are local-only.`);
    steps.push(`Run \`sign request watch --request-id ${request.id} --provider ${provider}\` to wait for completion.`);
  }
  return steps;
}

export type SignerSigningStateRow = {
  request_id: string;
  signer_email: string;
  signer_name: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  source: string;
  updated_at: string;
};

export function recordSignerSigningState(
  db: SqliteDb,
  input: {
    requestId: string;
    signerEmail: string;
    signerName?: string;
    signedAt?: string | null;
    declinedAt?: string | null;
    declineReason?: string | null;
    source: "local" | "dropbox" | "signwell" | "docusign";
    now?: Date;
  },
): void {
  const updatedAt = (input.now ?? new Date()).toISOString();
  // Merge: if a row already exists, preserve any existing non-null fields the caller didn't set.
  const existing = db.prepare(
    "SELECT * FROM signer_signing_states WHERE request_id = ? AND lower(signer_email) = lower(?)",
  ).get(input.requestId, input.signerEmail) as SignerSigningStateRow | undefined;
  const signedAt = input.signedAt ?? existing?.signed_at ?? null;
  const declinedAt = input.declinedAt ?? existing?.declined_at ?? null;
  const declineReason = input.declineReason ?? existing?.decline_reason ?? null;
  const signerName = input.signerName ?? existing?.signer_name ?? null;
  db.prepare(
    `INSERT INTO signer_signing_states (request_id, signer_email, signer_name, signed_at, declined_at, decline_reason, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id, signer_email) DO UPDATE SET
       signer_name = excluded.signer_name,
       signed_at = excluded.signed_at,
       declined_at = excluded.declined_at,
       decline_reason = excluded.decline_reason,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(
    input.requestId,
    input.signerEmail,
    signerName,
    signedAt,
    declinedAt,
    declineReason,
    input.source,
    updatedAt,
  );
}

export type SignerSigningStateView = {
  email: string;
  name: string;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  source: string;
};

export function listSignerSigningStates(db: SqliteDb, requestId: string): SignerSigningStateView[] {
  const rows = db.prepare(
    "SELECT * FROM signer_signing_states WHERE request_id = ? ORDER BY updated_at ASC",
  ).all(requestId) as SignerSigningStateRow[];
  return rows.map((row) => ({
    email: row.signer_email,
    name: row.signer_name ?? row.signer_email,
    signedAt: row.signed_at,
    declinedAt: row.declined_at,
    declineReason: row.decline_reason,
    source: row.source,
  }));
}

export function getRequestSnapshot(
  db: SqliteDb,
  requestId: string,
  opts: { now?: Date; includeMetrics?: boolean } = {},
): RequestSnapshot {
  const requestRow = getRequestRow(db, requestId);
  const request = serializeRequestRow(requestRow);
  const rawApprovals = listApprovalRows(db, requestId);
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  let signingState: LocalDocumentSigningState | null = null;
  if (request.normalizedProvider === "local" && request.provider_request_id) {
    try {
      signingState = getLocalDocumentSigningState(request.provider_request_id);
    } catch {
      signingState = null;
    }
  }

  // Merge signedBy/declined info from the cross-provider signing-states table.
  const states = listSignerSigningStates(db, requestId);
  const localSignedByMap = new Map(
    (signingState?.signedBy ?? []).map((entry) => [entry.email.trim().toLowerCase(), entry]),
  );
  const mergedSignedBy = states
    .filter((s) => s.signedAt !== null)
    .map((s) => {
      const localEntry = localSignedByMap.get(s.email.trim().toLowerCase());
      return {
        email: s.email,
        name: s.name,
        signedAt: s.signedAt!,
        ...(localEntry?.certFingerprintSha256 ? { certFingerprintSha256: localEntry.certFingerprintSha256 } : {}),
        ...(localEntry?.certSubjectCommonName ? { certSubjectCommonName: localEntry.certSubjectCommonName } : {}),
        source: s.source,
      };
    });
  const mergedDeclinedState = states.find((s) => s.declinedAt !== null) ?? null;

  const signedEmails = new Set(mergedSignedBy.map((entry) => entry.email.trim().toLowerCase()));

  const approvals: EnrichedApproval[] = rawApprovals.map((approval) => ({
    ...approval,
    tokenHint: approval.token_hint,
    expiresAt: approval.expires_at,
    approvedAt: approval.approved_at,
    usedAt: approval.used_at,
    expired: new Date(approval.expires_at).getTime() < nowMs,
    signed: signedEmails.has(approval.signer_email.trim().toLowerCase()),
  }));

  const nextSteps = buildNextSteps({ request, approvals, signingState });

  // For local provider, prefer the local-record signedBy[] (richer cert info from PR #23) when present.
  // For hosted providers, use the merged cross-provider table.
  const signedBy = mergedSignedBy.length > 0
    ? mergedSignedBy
    : (signingState?.signedBy ?? null);
  const declinedBy = mergedDeclinedState?.email ?? signingState?.declinedBy ?? null;
  const declineReason = mergedDeclinedState?.declineReason ?? signingState?.declineReason ?? null;

  let metrics: RequestSnapshotMetrics | undefined;
  if (opts.includeMetrics) {
    const oneHourAgo = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const totalEventsRow = db.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ?",
    ).get(requestId) as { n: number };
    const eventsLastHourRow = db.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ? AND created_at >= ?",
    ).get(requestId, oneHourAgo) as { n: number };
    const fetchesLastHourRow = db.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ? AND event_type = ? AND created_at >= ?",
    ).get(requestId, "request.signer_fetched_document", oneHourAgo) as { n: number };
    const replaysLastHourRow = db.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ? AND event_type LIKE '%.replay' AND created_at >= ?",
    ).get(requestId, oneHourAgo) as { n: number };
    const totalSigners = JSON.parse(requestRow.signers_json).length as number;
    const signedCount = mergedSignedBy.length;
    const earliestSign = mergedSignedBy.reduce<string | null>(
      (acc, entry) => (acc === null || entry.signedAt < acc ? entry.signedAt : acc),
      null,
    );
    const latestSign = mergedSignedBy.reduce<string | null>(
      (acc, entry) => (acc === null || entry.signedAt > acc ? entry.signedAt : acc),
      null,
    );
    const createdMs = new Date(requestRow.created_at).getTime();
    metrics = {
      totalSigners,
      signedCount,
      pendingCount: Math.max(0, totalSigners - signedCount),
      declined: declinedBy !== null,
      eventsTotal: totalEventsRow.n,
      eventsLastHour: eventsLastHourRow.n,
      fetchesLastHour: fetchesLastHourRow.n,
      webhookReplaysLastHour: replaysLastHourRow.n,
      ageSeconds: Math.max(0, Math.floor((nowMs - createdMs) / 1000)),
      timeToFirstSignSeconds: earliestSign
        ? Math.max(0, Math.floor((new Date(earliestSign).getTime() - createdMs) / 1000))
        : null,
      timeToCompleteSeconds:
        signedCount === totalSigners && totalSigners > 0 && latestSign
          ? Math.max(0, Math.floor((new Date(latestSign).getTime() - createdMs) / 1000))
          : null,
    };
  }

  return {
    request,
    approvals,
    signedBy,
    declinedBy,
    declineReason,
    nextSteps,
    ...(metrics ? { metrics } : {}),
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

export async function remindSigningRequest(
  db: SqliteDb,
  input: {
    requestId: string;
    provider?: SignProvider;
    apiKey?: string;
    email?: string;
    now?: Date;
  },
): Promise<{
  provider: SignProvider;
  providerRequestId: string;
  remoteResponse: unknown;
}> {
  const request = getRequestRow(db, input.requestId);
  const provider = input.provider ?? getPersistedProvider(request);
  const providerRequestId = getProviderRequestId(request);
  if (!providerRequestId) {
    throw new Error(`Request has not been sent to ${providerDisplayName(provider)} yet; nothing to remind.`);
  }
  const providerApi = getProviderApi(provider);
  if (!providerApi.remind) {
    throw new Error(`Reminders are not yet supported for ${providerDisplayName(provider)}.`);
  }
  const result = await providerApi.remind({
    providerRequestId,
    apiKey: input.apiKey,
    email: input.email,
  });
  const now = input.now ?? new Date();
  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.reminded",
    payload: { provider, providerRequestId, email: input.email ?? null },
    now,
  });
  return { provider, providerRequestId, remoteResponse: result.remoteResponse };
}

type ListSigningRequestsRow = {
  id: string;
  title: string;
  status: string;
  provider: string | null;
  provider_request_id: string | null;
  provider_status: string | null;
  signers_json: string;
  created_at: string;
  updated_at: string;
};

export type SigningRequestSummary = {
  id: string;
  title: string;
  status: string;
  provider: SignProvider | null;
  providerRequestId: string | null;
  providerStatus: string | null;
  signers: number;
  createdAt: string;
  updatedAt: string;
};

function buildListSigningRequestsQuery(input: { provider?: SignProvider; status?: string; limit?: number; since?: string }): { sql: string; params: (string | number | null)[] } {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.provider) {
    where.push("provider = ?");
    params.push(input.provider);
  }
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.since) {
    if (Number.isNaN(Date.parse(input.since))) {
      throw new SignCliError({
        code: "INVALID_ARGS",
        message: `--since must be an ISO 8601 timestamp; got ${JSON.stringify(input.since)}.`,
      });
    }
    where.push("datetime(created_at) >= datetime(?)");
    params.push(input.since);
  }
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.min(Number(input.limit), 500) : 100;
  const sql = `SELECT id, title, status, provider, provider_request_id, provider_status, signers_json, created_at, updated_at
     FROM requests
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY datetime(created_at) DESC
     LIMIT ${limit}`;
  return { sql, params };
}

function projectListSigningRequestsRow(row: ListSigningRequestsRow): SigningRequestSummary {
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
}

export function listSigningRequests(
  db: SqliteDb | DbBackend,
  input: { provider?: SignProvider; status?: string; limit?: number; since?: string } = {},
): SigningRequestSummary[] {
  const { sql, params } = buildListSigningRequestsQuery(input);
  const rows = asBackend(db).prepare(sql).all(...params) as ListSigningRequestsRow[];
  return rows.map(projectListSigningRequestsRow);
}

// Async sibling. Same query + projection, but via prepareAsync.
export async function listSigningRequestsAsync(
  backend: DbBackend,
  input: { provider?: SignProvider; status?: string; limit?: number; since?: string } = {},
): Promise<SigningRequestSummary[]> {
  const { sql, params } = buildListSigningRequestsQuery(input);
  const rows = await backend.prepareAsync(sql).all(...params) as ListSigningRequestsRow[];
  return rows.map(projectListSigningRequestsRow);
}

export function verifyRequestAuditChain(db: SqliteDb | DbBackend, requestId: string): AuditVerificationResult {
  getRequestRow(db, requestId);
  return verifyAuditChain(db, requestId);
}

// Async sibling — same call shape, but every DB op goes through prepareAsync
// so PostgresBackend works.
export async function verifyRequestAuditChainAsync(backend: DbBackend, requestId: string): Promise<AuditVerificationResult> {
  await getRequestRowAsync(backend, requestId);
  return verifyAuditChainAsync(backend, requestId);
}

export type AuditScanReport = {
  total: number;
  valid: number;
  invalid: number;
  results: Array<{
    requestId: string;
    title: string;
    status: string;
    valid: boolean;
    events: number;
    break: AuditVerificationResult["break"];
  }>;
};

function buildScanAllAuditChainsQuery(input: { provider?: SignProvider; status?: string; limit?: number }): { sql: string; params: (string | number | null)[] } {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.provider) { where.push("provider = ?"); params.push(input.provider); }
  if (input.status) { where.push("status = ?"); params.push(input.status); }
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.min(Number(input.limit), 5000) : 1000;
  const sql = `SELECT id, title, status FROM requests
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY datetime(created_at) DESC
     LIMIT ${limit}`;
  return { sql, params };
}

export function scanAllAuditChains(
  db: SqliteDb | DbBackend,
  input: { provider?: SignProvider; status?: string; limit?: number } = {},
): AuditScanReport {
  const backend = asBackend(db);
  const { sql, params } = buildScanAllAuditChainsQuery(input);
  const rows = backend.prepare(sql).all(...params) as Array<{ id: string; title: string; status: string }>;

  let valid = 0;
  let invalid = 0;
  const results: AuditScanReport["results"] = [];
  for (const row of rows) {
    const chain = verifyAuditChain(backend, row.id);
    results.push({
      requestId: row.id,
      title: row.title,
      status: row.status,
      valid: chain.valid,
      events: chain.events,
      break: chain.break,
    });
    if (chain.valid) valid += 1;
    else invalid += 1;
  }
  return { total: rows.length, valid, invalid, results };
}

// Async sibling — same query + sequential per-row verifyAuditChainAsync.
export async function scanAllAuditChainsAsync(
  backend: DbBackend,
  input: { provider?: SignProvider; status?: string; limit?: number } = {},
): Promise<AuditScanReport> {
  const { sql, params } = buildScanAllAuditChainsQuery(input);
  const rows = await backend.prepareAsync(sql).all(...params) as Array<{ id: string; title: string; status: string }>;
  let valid = 0;
  let invalid = 0;
  const results: AuditScanReport["results"] = [];
  for (const row of rows) {
    const chain = await verifyAuditChainAsync(backend, row.id);
    results.push({
      requestId: row.id,
      title: row.title,
      status: row.status,
      valid: chain.valid,
      events: chain.events,
      break: chain.break,
    });
    if (chain.valid) valid += 1;
    else invalid += 1;
  }
  return { total: rows.length, valid, invalid, results };
}

function findSignedPdfArtifact(db: SqliteDb, requestId: string): { id: string; path: string; created_at: string; metadata_json: string } | null {
  const row = db.prepare(
    `SELECT id, path, created_at, metadata_json
     FROM artifacts
     WHERE request_id = ? AND kind = 'signed_pdf'
     ORDER BY datetime(created_at) DESC
     LIMIT 1`,
  ).get(requestId) as { id: string; path: string; created_at: string; metadata_json: string } | undefined;
  return row ?? null;
}

/** A one-shot verdict over a signed PDF + the persisted signer list. Drives
 *  the verify-summary line and the CLI exit code (Item 2 of the product-
 *  readiness feedback). Verdicts are ordered by severity in `verdictRank`. */
export type VerifyVerdict =
  | "ok"
  | "warnings"
  | "digest_mismatch"
  | "no_signature"
  | "signer_mismatch";

export type VerifySummary = {
  signature_present: boolean;
  digest_ok: boolean;
  signer_match: boolean;
  warnings_count: number;
  /** Worst (least trustworthy) trust label across all signers in the PDF.
   *  Purely descriptive — does NOT affect the verdict. Useful for spotting
   *  "I expected a real-provider signature but got a self-signed local cert."
   *  Ordering (best → worst): ca_signed > self_signed_local > self_signed_other > unknown. */
  trust: TrustLabel;
  verdict: VerifyVerdict;
};

const TRUST_RANK: Record<TrustLabel, number> = {
  ca_signed: 3,
  self_signed_local: 2,
  self_signed_other: 1,
  unknown: 0,
};

function worstTrust(report: PdfSignatureReport): TrustLabel {
  let worst: TrustLabel = "ca_signed";
  let worstRank = TRUST_RANK.ca_signed;
  for (const sig of report.signatures) {
    for (const s of sig.signers) {
      if (TRUST_RANK[s.trust] < worstRank) {
        worst = s.trust;
        worstRank = TRUST_RANK[s.trust];
      }
    }
  }
  // No signatures means nothing to rate — leave the default "ca_signed"
  // (verdict will already be no_signature in that case, so this field is
  // irrelevant), but report "unknown" so a downstream "trust good?" check
  // can't accidentally pass on an unsigned file.
  if (!report.hasSignature) return "unknown";
  return worst;
}

function emailMatchesSubject(subject: string | null, email: string): boolean {
  if (!subject) return false;
  return subject.toLowerCase().includes(email.toLowerCase());
}

/** @internal Exposed for unit testing — call sites should use the higher-level
 *  inspectRequestSignedPdf which also handles persistence + auditing. */
export function computeVerifySummary(
  report: PdfSignatureReport,
  persistedSigners: SignerInput[],
): VerifySummary {
  const signature_present = report.hasSignature;
  // digest_ok requires that there's at least one signature AND every signature
  // we could parse cleanly matches its embedded message digest.
  const digest_ok = signature_present
    && report.signatures.every((sig) => sig.messageDigestMatches === true);
  // signer_match: every persisted signer must appear as the subject of at
  // least one signature (Persisted ⊆ PDF — catches missing signers, tolerates
  // extras per the design choice for Item 2).
  const signer_match = signature_present
    && persistedSigners.every((persisted) =>
      report.signatures.some((sig) =>
        sig.signers.some((s) => emailMatchesSubject(s.subject, persisted.email)),
      ),
    );
  const warnings_count = report.warnings.length
    + report.signatures.reduce((sum, sig) => sum + sig.parseWarnings.length, 0);
  // Precedence: most-severe wins. no_signature > digest_mismatch > signer_mismatch > warnings > ok.
  let verdict: VerifyVerdict;
  if (!signature_present) verdict = "no_signature";
  else if (!digest_ok) verdict = "digest_mismatch";
  else if (!signer_match) verdict = "signer_mismatch";
  else if (warnings_count > 0) verdict = "warnings";
  else verdict = "ok";
  return { signature_present, digest_ok, signer_match, warnings_count, trust: worstTrust(report), verdict };
}

/** Map a verify verdict to the CLI exit code. Distinct codes per failure
 *  class so CI scripts can branch. */
export function verifyVerdictExitCode(verdict: VerifyVerdict): 0 | 2 | 3 | 4 | 5 {
  switch (verdict) {
    case "ok":               return 0;
    case "warnings":         return 2;
    case "digest_mismatch":  return 3;
    case "no_signature":     return 4;
    case "signer_mismatch":  return 5;
  }
}

export async function inspectRequestSignedPdf(
  db: SqliteDb,
  input: { requestId: string; path?: string; now?: Date },
): Promise<{ source: "request" | "path"; report: PdfSignatureReport; summary: VerifySummary }> {
  let pdfPath = input.path;
  let source: "request" | "path" = "path";
  let persistedSigners: SignerInput[] = [];
  if (!pdfPath) {
    const row = getRequestRow(db, input.requestId);
    persistedSigners = JSON.parse(row.signers_json) as SignerInput[];
    const artifact = findSignedPdfArtifact(db, input.requestId);
    if (!artifact) {
      throw new Error("No signed PDF artifact found for this request. Run `request fetch-final` first or pass --path.");
    }
    pdfPath = artifact.path;
    source = "request";
  } else {
    // Path was explicit, but we still want the persisted signer list for the
    // signer_match check — the whole point of verifying against a request is
    // checking that the PDF came from the people we expected.
    try {
      const row = getRequestRow(db, input.requestId);
      persistedSigners = JSON.parse(row.signers_json) as SignerInput[];
    } catch {
      // Request not found in DB — skip signer_match (will be true by vacuous-
      // truth: zero persisted signers means everyone in PDF is acceptable).
      persistedSigners = [];
    }
  }
  const report = await inspectPdfSignatures(pdfPath);
  const summary = computeVerifySummary(report, persistedSigners);
  const now = input.now ?? new Date();
  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.signed_pdf_inspected",
    payload: {
      path: pdfPath,
      hasSignature: report.hasSignature,
      signatureCount: report.signatureCount,
      digestMatchAll: report.signatures.every((sig) => sig.messageDigestMatches === true),
      verdict: summary.verdict,
    },
    now,
  });
  return { source, report, summary };
}

export async function timestampRequestAuditChain(
  db: SqliteDb,
  input: { requestId: string; tsaUrl?: string; outPath?: string; now?: Date },
): Promise<{
  tsaUrl: string;
  hashSelf: string;
  digestHex: string;
  responseBytes: number;
  artifactPath: string;
  inspection: TimestampInspection;
}> {
  getRequestRow(db, input.requestId);
  const lastEvent = db.prepare(
    `SELECT hash_self FROM audit_events WHERE request_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(input.requestId) as { hash_self: string } | undefined;
  if (!lastEvent) {
    throw new Error("No audit events to timestamp.");
  }
  const digest = digestForChainHead(lastEvent.hash_self);
  const result = await issueRfc3161Timestamp({ digest, tsaUrl: input.tsaUrl });
  const path = await import("node:path");
  const fs = await import("node:fs");
  const outPath = input.outPath ?? path.resolve("artifacts", `${input.requestId}-audit.tsr`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.responseBuffer);

  const now = input.now ?? new Date();
  insertArtifactRow(db, {
    id: createId("art"),
    requestId: input.requestId,
    kind: "audit_timestamp",
    path: outPath,
    contentHash: sha256(result.responseBuffer),
    metadataJson: stableStringify({ tsaUrl: result.tsaUrl, bytes: result.responseBuffer.length, hashSelf: lastEvent.hash_self }),
    createdAt: nowIso(now),
  });

  const inspection = inspectTimestampResponse(result.responseBuffer, digest);

  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "audit.timestamped",
    payload: {
      tsaUrl: result.tsaUrl,
      bytes: result.responseBuffer.length,
      hashSelf: lastEvent.hash_self,
      granted: inspection.granted,
    },
    now,
  });

  return {
    tsaUrl: result.tsaUrl,
    hashSelf: lastEvent.hash_self,
    digestHex: digest.toString("hex"),
    responseBytes: result.responseBuffer.length,
    artifactPath: outPath,
    inspection,
  };
}

export async function exportAuditBundle(
  db: SqliteDb,
  input: { requestId: string; outDir: string; now?: Date },
): Promise<{
  outDir: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  manifestPath: string;
  chain: AuditVerificationResult;
}> {
  const request = getRequestRow(db, input.requestId);
  const path = await import("node:path");
  const fs = await import("node:fs");
  const outDir = path.resolve(input.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const chain = verifyAuditChain(db, input.requestId);
  const audit = listAuditEvents(db, input.requestId);
  const auditPayload = {
    request: serializeRequestRow(request),
    chain,
    events: audit,
  };
  const auditFile = path.join(outDir, "audit.json");
  fs.writeFileSync(auditFile, JSON.stringify(auditPayload, null, 2));

  const files: Array<{ name: string; sha256: string; bytes: number }> = [];
  function recordFile(filePath: string, name: string): void {
    const data = fs.readFileSync(filePath);
    files.push({ name, sha256: sha256(data), bytes: data.length });
  }
  recordFile(auditFile, "audit.json");

  const signedPdf = findSignedPdfArtifact(db, input.requestId);
  if (signedPdf && fs.existsSync(signedPdf.path)) {
    const dest = path.join(outDir, "signed.pdf");
    fs.copyFileSync(signedPdf.path, dest);
    recordFile(dest, "signed.pdf");
  }

  const tsrRow = db.prepare(
    `SELECT path FROM artifacts WHERE request_id = ? AND kind = 'audit_timestamp' ORDER BY datetime(created_at) DESC LIMIT 1`,
  ).get(input.requestId) as { path: string } | undefined;
  if (tsrRow && fs.existsSync(tsrRow.path)) {
    const dest = path.join(outDir, "audit.tsr");
    fs.copyFileSync(tsrRow.path, dest);
    recordFile(dest, "audit.tsr");
  }

  const manifest = {
    requestId: input.requestId,
    generatedAt: nowIso(input.now ?? new Date()),
    chainValid: chain.valid,
    files,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "audit.exported",
    payload: { outDir, files: files.map((file) => file.name), chainValid: chain.valid },
    now: input.now ?? new Date(),
  });

  return { outDir, files, manifestPath, chain };
}

export type BulkRowResult = {
  row: number;
  ok: boolean;
  requestId: string | null;
  signerEmail: string | null;
  error: string | null;
  providerRequestId: string | null;
  // Populated only when bulk runs against --provider local without --auto-approve-only:
  // the per-row signer token from createSigningRequest. Undefined for hosted providers
  // (where the token is not the auth artifact for signing) or when not requested.
  token: string | null;
  tokenExpiresAt: string | null;
};

export async function bulkSendFromCsv(
  db: SqliteDb,
  input: {
    rows: Array<Record<string, string>>;
    titleTemplate: string;
    documentPaths: string[];
    provider: SignProvider;
    apiKey?: string;
    testMode: boolean;
    tokenTtlMinutes?: number;
    onProgress?: (event: { row: number; total: number; phase: "send" | "create" | "done" | "error"; signerEmail?: string; requestId?: string; error?: string }) => void;
  },
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  results: BulkRowResult[];
}> {
  const onProgress = input.onProgress ?? (() => {});
  const results: BulkRowResult[] = [];
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index];
    const rowNumber = index + 1;
    const signerEmail = (row.email ?? row.signer_email ?? "").trim();
    const signerName = (row.name ?? row.signer_name ?? "").trim();
    if (!signerEmail || !signerName) {
      const error = "CSV row is missing name and/or email columns.";
      onProgress({ row: rowNumber, total: input.rows.length, phase: "error", error });
      results.push({
        row: rowNumber,
        ok: false,
        requestId: null,
        signerEmail: signerEmail || null,
        error,
        providerRequestId: null,
        token: null,
        tokenExpiresAt: null,
      });
      failed += 1;
      continue;
    }
    const title = input.titleTemplate
      .replaceAll("{{email}}", signerEmail)
      .replaceAll("{{name}}", signerName)
      .replaceAll("{{row}}", String(rowNumber));
    try {
      onProgress({ row: rowNumber, total: input.rows.length, phase: "create", signerEmail });
      const created = createSigningRequest(db, {
        title,
        documentPaths: input.documentPaths,
        signers: [{ name: signerName, email: signerEmail, order: 1 }],
        tokenTtlMinutes: input.tokenTtlMinutes ?? 30,
        provider: input.provider,
        autoApprove: true,
      });
      onProgress({ row: rowNumber, total: input.rows.length, phase: "send", signerEmail, requestId: created.requestId });
      const sent = await sendSigningRequest(db, {
        requestId: created.requestId,
        provider: input.provider,
        apiKey: input.apiKey,
        testMode: input.testMode,
      });
      onProgress({ row: rowNumber, total: input.rows.length, phase: "done", signerEmail, requestId: created.requestId });
      const issued = created.tokens.find((t) => t.signer.email === signerEmail) ?? created.tokens[0];
      results.push({
        row: rowNumber,
        ok: true,
        requestId: created.requestId,
        signerEmail,
        error: null,
        providerRequestId: sent.signatureRequestId,
        token: issued?.token ?? null,
        tokenExpiresAt: issued?.expiresAt ?? null,
      });
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress({ row: rowNumber, total: input.rows.length, phase: "error", signerEmail, error: message });
      results.push({
        row: rowNumber,
        ok: false,
        requestId: null,
        signerEmail,
        error: message,
        providerRequestId: null,
        token: null,
        tokenExpiresAt: null,
      });
      failed += 1;
    }
  }
  return { total: input.rows.length, succeeded, failed, results };
}

export async function runLocalDemo(
  db: SqliteDb,
  input: {
    documentPath?: string;
    outDir?: string;
    onProgress?: (line: string) => void;
    now?: Date;
  } = {},
): Promise<{
  requestId: string;
  documentId: string;
  signedPdfPath: string;
  auditChainValid: boolean;
  signatureCount: number;
  messageDigestVerified: boolean;
  bundleDir: string;
  attempts: number;
  elapsedMs: number;
}> {
  const onProgress = input.onProgress ?? (() => {});
  const path = await import("node:path");
  const fs = await import("node:fs");
  const outDir = path.resolve(input.outDir ?? "./demo-bundle");
  fs.mkdirSync(outDir, { recursive: true });

  let documentPath = input.documentPath;
  if (!documentPath) {
    const generatedPath = path.join(outDir, "demo-input.pdf");
    fs.writeFileSync(generatedPath, Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
4 0 obj << /Length 74 >> stream
BT /F1 14 Tf 60 720 Td (Sign CLI demo input. Sign locally to verify the flow.) Tj ET
endstream
endobj
trailer << /Root 1 0 R /Size 5 >>
%%EOF`, "latin1"));
    documentPath = generatedPath;
  }

  onProgress(`[demo] creating local request from ${documentPath}`);
  const created = createSigningRequest(db, {
    title: "Sign CLI demo",
    documentPath,
    signers: [{ name: "Demo Signer", email: "demo-signer@example.com", order: 1 }],
    tokenTtlMinutes: 30,
    provider: "local",
    autoApprove: true,
    now: input.now,
  });

  onProgress("[demo] sending via local provider");
  const sent = await sendSigningRequest(db, {
    requestId: created.requestId,
    provider: "local",
    testMode: true,
    now: input.now,
  });

  onProgress("[demo] watching status (local provider auto-completes after first poll)");
  const watch = await watchSigningRequestStatus(db, {
    requestId: created.requestId,
    provider: "local",
    intervalMs: 25,
    timeoutMs: 5000,
    fetchFinalPdf: true,
    outPath: path.join(outDir, "signed.pdf"),
    now: input.now,
    onPoll: (update) => onProgress(`[demo] poll attempt=${update.attempt} status=${update.status}${update.terminal ? ` terminal=${update.terminal}` : ""}`),
  });

  if (!watch.finalPdf) {
    throw new Error("Local demo: watch completed without a signed PDF.");
  }

  onProgress("[demo] inspecting embedded PKCS#7 signature");
  const inspection = await inspectRequestSignedPdf(db, {
    requestId: created.requestId,
    path: watch.finalPdf.path,
    now: input.now,
  });
  const messageDigestVerified = inspection.report.signatures.length > 0
    && inspection.report.signatures.every((sig) => sig.messageDigestMatches === true);

  onProgress("[demo] verifying audit chain");
  const audit = verifyRequestAuditChain(db, created.requestId);

  onProgress(`[demo] exporting bundle to ${outDir}`);
  await exportAuditBundle(db, { requestId: created.requestId, outDir, now: input.now });

  return {
    requestId: created.requestId,
    documentId: sent.signatureRequestId,
    signedPdfPath: watch.finalPdf.path,
    auditChainValid: audit.valid,
    signatureCount: inspection.report.signatureCount,
    messageDigestVerified,
    bundleDir: outDir,
    attempts: watch.attempts,
    elapsedMs: watch.elapsedMs,
  };
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

function ensureLocalProvider(request: RequestRow, provider: SignProvider): void {
  if (provider !== "local") {
    throw new SignCliError({
      code: "NON_LOCAL_PROVIDER",
      message: `Signer-side flow only supports --provider local; this request uses ${providerDisplayName(provider)}. Use the provider's email link to sign.`,
      hint: "Hosted providers deliver email/embedded sign URLs to recipients; only the local simulator exposes signer-side commands.",
      details: { requestId: request.id, provider },
    });
  }
  if (!getProviderRequestId(request)) {
    throw new SignCliError({
      code: "REQUEST_NOT_SENT",
      message: `Request ${request.id} has not been sent to the local provider yet; nothing to sign.`,
      hint: `Run \`sign request send --request-id ${request.id} --provider local\` first.`,
      details: { requestId: request.id },
    });
  }
}

function resolveSignerFromToken(
  db: SqliteDb,
  request: RequestRow,
  token: string,
  now: Date,
): { signer: SignerInput; approval: ApprovalRow } {
  const trimmed = (token ?? "").trim();
  if (!trimmed) {
    throw new SignCliError({
      code: "TOKEN_REQUIRED",
      message: "--token is required for signer-side commands.",
      hint: "Pass the per-signer token from the `tokens[]` array `request create` returned to the requester.",
    });
  }
  const tokenHash = sha256(trimmed);
  const approval = db.prepare(
    "SELECT * FROM approvals WHERE request_id = ? AND token_hash = ?",
  ).get(request.id, tokenHash) as ApprovalRow | undefined;
  if (!approval) {
    throw new SignCliError({
      code: "TOKEN_INVALID",
      message: `Token does not match any signer on request ${request.id}.`,
      hint: "Confirm the token + --request-id pair the requester sent you.",
      details: { requestId: request.id },
    });
  }
  if (new Date(approval.expires_at).getTime() < now.getTime()) {
    throw new SignCliError({
      code: "TOKEN_EXPIRED",
      message: `Token has expired (expiresAt=${approval.expires_at}).`,
      hint: "Ask the requester to re-issue with a longer --token-ttl-minutes, or re-run `request create`.",
      details: { requestId: request.id, expiresAt: approval.expires_at },
    });
  }
  return {
    signer: {
      name: approval.signer_name,
      email: approval.signer_email,
      order: approval.signer_order,
    },
    approval,
  };
}

function assertSignerEmailMatchesToken(
  signer: SignerInput,
  signerEmailFlag: string | undefined,
): void {
  if (!signerEmailFlag) return;
  const expected = signerEmailFlag.trim().toLowerCase();
  const actual = signer.email.trim().toLowerCase();
  if (expected !== actual) {
    throw new SignCliError({
      code: "TOKEN_SIGNER_MISMATCH",
      message: `--signer-email ${signerEmailFlag} does not match the signer (${signer.email}) the token authorizes.`,
      hint: "Drop --signer-email (the token alone is sufficient) or fix the email to match.",
      details: { tokenSigner: signer.email, flag: signerEmailFlag },
    });
  }
}

export type SignerSafetyChecks = {
  requireHash?: string;
  requireTitle?: string;
  requireSignerEmail?: string;
};

function applySignerSafetyChecks(
  request: RequestRow,
  signer: SignerInput,
  checks: SignerSafetyChecks,
): void {
  if (checks.requireHash) {
    const expected = checks.requireHash.trim().toLowerCase();
    const actual = (request.document_hash ?? "").trim().toLowerCase();
    if (expected !== actual) {
      throw new SignCliError({
        code: "PRE_SIGN_HASH_MISMATCH",
        message: `Pre-sign safety check failed: --require-hash ${expected} does not match request document hash ${actual}.`,
        hint: "Re-fetch the document with `signer fetch-document` and confirm the SHA-256 the requester told you to expect.",
        details: { expected, actual },
      });
    }
  }
  if (checks.requireTitle) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(checks.requireTitle);
    } catch (error) {
      throw new SignCliError({
        code: "PRE_SIGN_TITLE_BAD_REGEX",
        message: `--require-title is not a valid regular expression: ${(error as Error).message}`,
        details: { input: checks.requireTitle },
      });
    }
    if (!pattern.test(request.title)) {
      throw new SignCliError({
        code: "PRE_SIGN_TITLE_MISMATCH",
        message: `Pre-sign safety check failed: title ${JSON.stringify(request.title)} does not match --require-title /${checks.requireTitle}/.`,
        details: { title: request.title, pattern: checks.requireTitle },
      });
    }
  }
  if (checks.requireSignerEmail) {
    const expected = checks.requireSignerEmail.trim().toLowerCase();
    const actual = signer.email.trim().toLowerCase();
    if (expected !== actual) {
      throw new SignCliError({
        code: "PRE_SIGN_SIGNER_MISMATCH",
        message: `Pre-sign safety check failed: --require-signer-email ${expected} does not match resolved signer ${actual}.`,
        details: { expected, actual },
      });
    }
  }
}

export type SignerSignResult = {
  requestId: string;
  providerRequestId: string;
  signerEmail: string;
  signerName: string;
  requestStatus: string;
  signedBy: Array<{ email: string; name: string; signedAt: string }>;
  totalSigners: number;
  remainingSigners: number;
  signedAt: string;
  idempotent?: boolean;
};

export function signSigningRequest(
  db: SqliteDb,
  input: {
    requestId: string;
    token: string;
    signerEmail?: string;
    signerName?: string;
    idempotencyKey?: string;
    now?: Date;
    /** When supplied with `strictProvider: true`, fail loudly if the request
     *  was created against a different provider than what's being asked to
     *  sign it now. Drives the strict-mode feature from Item 1 of the
     *  product-readiness feedback. */
    runtimeProvider?: SignProvider;
    strictProvider?: boolean;
    /** Visible signature image to stamp on the PDF before PAdES sealing (local provider only). */
    signatureImage?: ImageInput;
    /** Explicit placement for the signature image; overrides any SignatureField the sender placed. */
    signatureImagePosition?: StampPosition;
  } & SignerSafetyChecks,
): SignerSignResult {
  if (input.idempotencyKey) {
    const cached = lookupIdempotencyKey<SignerSignResult>(db, "sign", input.idempotencyKey);
    if (cached.hit) return { ...cached.value, idempotent: true };
  }
  const request = getRequestRow(db, input.requestId);
  const provider = getPersistedProvider(request);
  if (input.runtimeProvider !== undefined && input.strictProvider) {
    assertProviderMatchesPersisted(input.runtimeProvider, provider, true);
  }
  ensureLocalProvider(request, provider);
  const now = input.now ?? new Date();
  const { signer } = resolveSignerFromToken(db, request, input.token, now);
  assertSignerEmailMatchesToken(signer, input.signerEmail);
  applySignerSafetyChecks(request, signer, {
    requireHash: input.requireHash,
    requireTitle: input.requireTitle,
    requireSignerEmail: input.requireSignerEmail,
  });

  const providerRequestId = getProviderRequestId(request)!;
  const beforeRecord = readLocalDocument(providerRequestId);
  const normalizedSigner = signer.email.trim().toLowerCase();
  const alreadySigned = beforeRecord.signedBy.some(
    (entry) => entry.email.trim().toLowerCase() === normalizedSigner,
  );
  if (alreadySigned) {
    throw new SignCliError({
      code: "SIGNER_ALREADY_SIGNED",
      message: `Signer ${signer.email} has already signed request ${request.id}.`,
      hint: "Each token can sign its slot at most once; if you need to undo, the requester must `request cancel` and start over.",
      details: { requestId: request.id, signer: signer.email },
    });
  }
  const result = signLocalDocument(providerRequestId, {
    signerEmail: signer.email,
    signerName: input.signerName ?? signer.name,
    now,
    signatureImage: input.signatureImage,
    signatureImagePosition: input.signatureImagePosition,
  });

  recordSignerSigningState(db, {
    requestId: request.id,
    signerEmail: signer.email,
    signerName: input.signerName ?? signer.name,
    signedAt: result.signedAt,
    source: "local",
    now,
  });

  const requestStatus = result.status === "completed" ? "completed" : "sent";
  persistRequestProviderMetadata(db, {
    requestId: request.id,
    provider,
    providerRequestId,
    providerStatus: result.status,
    now,
  });
  updateRequestStatus(db, request.id, requestStatus, now);

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.signed_by_signer",
    payload: {
      provider,
      providerRequestId,
      signerEmail: signer.email,
      signerName: input.signerName ?? signer.name,
      signedBy: result.signedBy,
      totalSigners: result.totalSigners,
      remainingSigners: result.remainingSigners,
      requestStatus,
    },
    now,
  });

  const finalResult: SignerSignResult = {
    requestId: request.id,
    providerRequestId,
    signerEmail: signer.email,
    signerName: input.signerName ?? signer.name,
    requestStatus,
    signedBy: result.signedBy,
    totalSigners: result.totalSigners,
    remainingSigners: result.remainingSigners,
    signedAt: result.signedAt,
  };
  if (input.idempotencyKey) {
    persistIdempotencyKey(db, {
      scope: "sign",
      key: input.idempotencyKey,
      requestId: request.id,
      value: finalResult,
      now,
    });
  }
  return finalResult;
}

export type SignerDeclineResult = {
  requestId: string;
  providerRequestId: string;
  signerEmail: string;
  reason: string | null;
  declinedAt: string;
};

export function declineSigningRequestAsSigner(
  db: SqliteDb,
  input: { requestId: string; token: string; signerEmail?: string; reason?: string; now?: Date },
): SignerDeclineResult {
  const request = getRequestRow(db, input.requestId);
  const provider = getPersistedProvider(request);
  ensureLocalProvider(request, provider);
  const now = input.now ?? new Date();
  const { signer } = resolveSignerFromToken(db, request, input.token, now);
  assertSignerEmailMatchesToken(signer, input.signerEmail);
  const providerRequestId = getProviderRequestId(request)!;
  const result = declineLocalDocument(providerRequestId, {
    signerEmail: signer.email,
    reason: input.reason,
    now,
  });

  recordSignerSigningState(db, {
    requestId: request.id,
    signerEmail: signer.email,
    signerName: signer.name,
    declinedAt: result.declinedAt,
    declineReason: result.declineReason,
    source: "local",
    now,
  });

  persistRequestProviderMetadata(db, {
    requestId: request.id,
    provider,
    providerRequestId,
    providerStatus: result.status,
    now,
  });
  updateRequestStatus(db, request.id, "declined", now);

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.signer_declined",
    payload: {
      provider,
      providerRequestId,
      signerEmail: signer.email,
      reason: result.declineReason,
    },
    now,
  });

  return {
    requestId: request.id,
    providerRequestId,
    signerEmail: signer.email,
    reason: result.declineReason,
    declinedAt: result.declinedAt,
  };
}

export type InboxTokenInfo = {
  signerEmail: string;
  tokenHint: string;
  expiresAt: string;
  expired: boolean;
  expiresSoon: boolean;
};

export type SignerInboxItem = LocalSignerInboxEntry & { tokens: InboxTokenInfo[] };

const INBOX_EXPIRES_SOON_MINUTES = 5;

function loadInboxTokens(
  db: SqliteDb,
  requestId: string,
  signers: SignerInput[],
  now: Date,
): InboxTokenInfo[] {
  const rows = db.prepare(
    "SELECT signer_email, token_hint, expires_at FROM approvals WHERE request_id = ?",
  ).all(requestId) as Array<{ signer_email: string; token_hint: string; expires_at: string }>;
  const known = new Set(signers.map((s) => s.email.trim().toLowerCase()));
  const nowMs = now.getTime();
  const soonThreshold = INBOX_EXPIRES_SOON_MINUTES * 60_000;
  return rows
    .filter((row) => known.has(row.signer_email.trim().toLowerCase()))
    .map((row) => {
      const expMs = new Date(row.expires_at).getTime();
      const expired = expMs < nowMs;
      return {
        signerEmail: row.signer_email,
        tokenHint: row.token_hint,
        expiresAt: row.expires_at,
        expired,
        expiresSoon: !expired && expMs - nowMs < soonThreshold,
      };
    });
}

export function listSignerInbox(
  db: SqliteDb,
  input: { signerEmail?: string; now?: Date } = {},
): SignerInboxItem[] {
  const inbox = listLocalSignerInbox(input.signerEmail);
  const now = input.now ?? new Date();
  return inbox.map((entry) => {
    let requestId = entry.requestId;
    if (!requestId) {
      const row = db.prepare(
        "SELECT id FROM requests WHERE provider = 'local' AND provider_request_id = ?",
      ).get(entry.documentId) as { id: string } | undefined;
      requestId = row?.id ?? null;
    }
    const tokens = requestId ? loadInboxTokens(db, requestId, entry.signers, now) : [];
    return { ...entry, requestId, tokens };
  });
}

export type ReissueSignerTokenResult = {
  requestId: string;
  signerEmail: string;
  token: string;
  tokenHint: string;
  expiresAt: string;
};

export function reissueSignerToken(
  db: SqliteDb,
  input: { requestId: string; signerEmail: string; tokenTtlMinutes?: number; now?: Date },
): ReissueSignerTokenResult {
  const request = getRequestRow(db, input.requestId);
  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const normalizedEmail = input.signerEmail.trim().toLowerCase();
  const signer = signers.find((s) => s.email.trim().toLowerCase() === normalizedEmail);
  if (!signer) {
    throw new SignCliError({
      code: "SIGNER_NOT_RECIPIENT",
      message: `Signer ${input.signerEmail} is not a recipient on request ${request.id}.`,
      details: { requestId: request.id },
    });
  }
  const provider = getPersistedProvider(request);
  if (provider === "local" && getProviderRequestId(request)) {
    try {
      const state = getLocalDocumentSigningState(getProviderRequestId(request)!);
      const alreadySigned = state.signedBy.some(
        (entry) => entry.email.trim().toLowerCase() === normalizedEmail,
      );
      if (alreadySigned) {
        throw new SignCliError({
          code: "SIGNER_ALREADY_SIGNED",
          message: `Signer ${signer.email} has already signed request ${request.id}; reissuing the token has no effect.`,
          details: { requestId: request.id, signer: signer.email },
        });
      }
    } catch (error) {
      if (error instanceof SignCliError) throw error;
      // record missing on disk — proceed with reissue
    }
  }
  const approvalRow = db.prepare(
    "SELECT id FROM approvals WHERE request_id = ? AND lower(signer_email) = lower(?)",
  ).get(request.id, signer.email) as { id: string } | undefined;
  if (!approvalRow) {
    throw new SignCliError({
      code: "INTERNAL",
      message: `No approval row found for ${signer.email} on request ${request.id}.`,
    });
  }
  const ttl = Number.isFinite(input.tokenTtlMinutes) && (input.tokenTtlMinutes ?? 0) > 0
    ? input.tokenTtlMinutes!
    : 30;
  const now = input.now ?? new Date();
  const newToken = createToken();
  const newHash = sha256(newToken);
  const newHint = tokenHint(newToken);
  const expiresAt = nowIso(new Date(now.getTime() + ttl * 60_000));
  reissueApprovalTokenRow(db, approvalRow.id, newHash, newHint, expiresAt);

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.signer_token_reissued",
    payload: {
      signerEmail: signer.email,
      tokenHint: newHint,
      expiresAt,
      ttlMinutes: ttl,
    },
    now,
  });

  return {
    requestId: request.id,
    signerEmail: signer.email,
    token: newToken,
    tokenHint: newHint,
    expiresAt,
  };
}

export type BulkResendOutcome = {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    row: number;
    requestId: string | null;
    signerEmail: string | null;
    ok: boolean;
    token: string | null;
    tokenHint: string | null;
    expiresAt: string | null;
    error: { code: string; message: string } | null;
  }>;
};

// Bulk re-issue signer tokens from a roster of {requestId, signerEmail}.
// Per-row failures are captured (signer-not-recipient, already-signed, missing
// request) so a single bad record can't poison the batch. Caller controls the
// default TTL via tokenTtlMinutes; per-row override comes from the row itself.
export function bulkReissueSignerTokens(
  db: SqliteDb,
  input: {
    rows: Array<{ requestId?: string; signerEmail?: string; tokenTtlMinutes?: number }>;
    tokenTtlMinutes?: number;
    now?: Date;
    onProgress?: (event: { row: number; total: number; phase: "reissuing" | "done" | "error"; requestId?: string; signerEmail?: string; error?: string }) => void;
  },
): BulkResendOutcome {
  const onProgress = input.onProgress ?? (() => {});
  const results: BulkResendOutcome["results"] = [];
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < input.rows.length; i += 1) {
    const row = input.rows[i];
    const rowNumber = i + 1;
    const requestId = row.requestId?.trim() ?? "";
    const signerEmail = row.signerEmail?.trim() ?? "";
    if (!requestId || !signerEmail) {
      const error = "row is missing request_id and/or signer_email";
      onProgress({ row: rowNumber, total: input.rows.length, phase: "error", requestId, signerEmail, error });
      results.push({
        row: rowNumber,
        requestId: requestId || null,
        signerEmail: signerEmail || null,
        ok: false,
        token: null, tokenHint: null, expiresAt: null,
        error: { code: "INVALID_ARGS", message: error },
      });
      failed += 1;
      continue;
    }
    onProgress({ row: rowNumber, total: input.rows.length, phase: "reissuing", requestId, signerEmail });
    try {
      const outcome = reissueSignerToken(db, {
        requestId,
        signerEmail,
        tokenTtlMinutes: row.tokenTtlMinutes ?? input.tokenTtlMinutes,
        now: input.now,
      });
      results.push({
        row: rowNumber,
        requestId: outcome.requestId,
        signerEmail: outcome.signerEmail,
        ok: true,
        token: outcome.token,
        tokenHint: outcome.tokenHint,
        expiresAt: outcome.expiresAt,
        error: null,
      });
      succeeded += 1;
      onProgress({ row: rowNumber, total: input.rows.length, phase: "done", requestId, signerEmail });
    } catch (error) {
      const code = error instanceof SignCliError ? error.code : "INTERNAL";
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        row: rowNumber,
        requestId,
        signerEmail,
        ok: false,
        token: null, tokenHint: null, expiresAt: null,
        error: { code, message },
      });
      failed += 1;
      onProgress({ row: rowNumber, total: input.rows.length, phase: "error", requestId, signerEmail, error: message });
    }
  }
  return { total: input.rows.length, succeeded, failed, results };
}

export type FetchUnsignedDocumentResult = {
  requestId: string;
  providerRequestId: string;
  signerEmail: string;
  title: string;
  bytes: number;
  sha256: string;
  outPath: string | null;
};

export function fetchUnsignedDocumentForSigner(
  db: SqliteDb,
  input: { requestId: string; token: string; signerEmail?: string; outPath?: string; now?: Date },
): FetchUnsignedDocumentResult {
  const request = getRequestRow(db, input.requestId);
  const provider = getPersistedProvider(request);
  ensureLocalProvider(request, provider);
  const now = input.now ?? new Date();
  const { signer } = resolveSignerFromToken(db, request, input.token, now);
  assertSignerEmailMatchesToken(signer, input.signerEmail);

  // Per-request fetch rate limit: SIGN_LOCAL_MAX_FETCHES_PER_HOUR caps how
  // often any signer can fetch a given request's unsigned PDF in the past
  // hour. Counts existing request.signer_fetched_document events in the
  // audit chain so the limit is durable across CLI invocations.
  const limitRaw = process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR;
  if (limitRaw) {
    const limit = Number(limitRaw);
    if (Number.isFinite(limit) && limit >= 0) {
      const cutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ? AND event_type = ? AND created_at >= ?",
      ).get(request.id, "request.signer_fetched_document", cutoff) as { n: number };
      if (row.n >= limit) {
        throw new SignCliError({
          code: "RATE_LIMITED",
          message: `Request ${request.id} exceeded SIGN_LOCAL_MAX_FETCHES_PER_HOUR=${limit} (current=${row.n}).`,
          hint: "Lower the agent's poll rate, or raise/unset SIGN_LOCAL_MAX_FETCHES_PER_HOUR.",
          details: { requestId: request.id, limit, currentInWindow: row.n },
        });
      }
    }
  }

  const providerRequestId = getProviderRequestId(request)!;
  const document = readLocalDocument(providerRequestId);

  let outPath: string | null = null;
  if (input.outPath) {
    const resolved = path.resolve(input.outPath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, document.pdf);
    outPath = resolved;
  }

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.signer_fetched_document",
    payload: {
      provider,
      providerRequestId,
      signerEmail: signer.email,
      bytes: document.bytes,
      sha256: document.sha256,
      outPath,
    },
    now,
  });

  return {
    requestId: request.id,
    providerRequestId,
    signerEmail: signer.email,
    title: document.title,
    bytes: document.bytes,
    sha256: document.sha256,
    outPath,
  };
}

export type SignerPolicyOutcome = {
  requestId: string;
  signerEmail: string;
  decision: PolicyDecision;
  applied: boolean;
  result: SignerSignResult | SignerDeclineResult | null;
};

// Pure read: load the request from the DB, derive the policy-evaluation context
// (title, documentSha256, signerEmail), and run evaluatePolicy. No state
// mutation, no signer token required. Use case: "would this in-flight or
// completed request still pass under my new spec?"
//
// signerEmail defaults to the first recipient's email if not provided. This
// matches the implicit single-signer case the CLI's existing `policy try`
// command uses.
export function rerunPolicyForRequest(
  db: SqliteDb,
  input: { requestId: string; spec: PolicySpec; signerEmail?: string },
): {
  requestId: string;
  ctx: { title: string; documentSha256: string; signerEmail: string };
  decision: PolicyDecision;
} {
  const request = getRequestRow(db, input.requestId);
  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const signerEmail = input.signerEmail
    ?? signers[0]?.email
    ?? "";
  const ctx = {
    title: request.title,
    documentSha256: request.document_hash ?? "",
    signerEmail,
  };
  const decision = evaluatePolicy(input.spec, ctx);
  return { requestId: request.id, ctx, decision };
}

export function runSignerPolicy(
  db: SqliteDb,
  input: {
    requestId: string;
    token: string;
    spec: PolicySpec;
    dryRun?: boolean;
    now?: Date;
  },
): SignerPolicyOutcome {
  const request = getRequestRow(db, input.requestId);
  const provider = getPersistedProvider(request);
  ensureLocalProvider(request, provider);
  const now = input.now ?? new Date();
  const { signer } = resolveSignerFromToken(db, request, input.token, now);

  const decision = evaluatePolicy(input.spec, {
    title: request.title,
    documentSha256: request.document_hash ?? "",
    signerEmail: signer.email,
  });

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.signer_policy_evaluated",
    payload: {
      signerEmail: signer.email,
      action: decision.action,
      matchedRuleIndex: decision.matchedRuleIndex,
      reason: decision.reason,
      dryRun: Boolean(input.dryRun),
    },
    now,
  });

  if (input.dryRun || decision.action === "report") {
    return {
      requestId: request.id,
      signerEmail: signer.email,
      decision,
      applied: false,
      result: null,
    };
  }

  if (decision.action === "sign") {
    // Cross-check: enforce expectations as require-* on the underlying sign call so any drift
    // between policy evaluation and state mutation is caught with a structured error.
    const expectations = input.spec.expectations;
    const result = signSigningRequest(db, {
      requestId: request.id,
      token: input.token,
      requireHash: expectations?.documentSha256,
      requireTitle: expectations?.titleMatches,
      requireSignerEmail: expectations?.signerEmail,
      now,
    });
    return {
      requestId: request.id,
      signerEmail: signer.email,
      decision,
      applied: true,
      result,
    };
  }

  // decline
  const declineResult = declineSigningRequestAsSigner(db, {
    requestId: request.id,
    token: input.token,
    reason: decision.reason ?? "Declined by policy.",
    now,
  });
  return {
    requestId: request.id,
    signerEmail: signer.email,
    decision,
    applied: true,
    result: declineResult,
  };
}

export type LocalDocumentResource = {
  requestId: string;
  providerRequestId: string;
  title: string;
  pdf: Buffer;
  bytes: number;
  sha256: string;
};

export function readLocalDocumentForResource(db: SqliteDb, requestId: string): LocalDocumentResource {
  const request = getRequestRow(db, requestId);
  const provider = getPersistedProvider(request);
  ensureLocalProvider(request, provider);
  const providerRequestId = getProviderRequestId(request)!;
  const document = readLocalDocument(providerRequestId);
  return {
    requestId: request.id,
    providerRequestId,
    title: document.title,
    pdf: document.pdf,
    bytes: document.bytes,
    sha256: document.sha256,
  };
}

export type ReceiptResult = {
  outDir: string;
  manifestPath: string;
  signaturePath: string;
  certPath: string;
  manifestSha256: string;
  signatureBytes: number;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  chain: AuditVerificationResult;
};

export async function exportRequestReceipt(
  db: SqliteDb,
  input: { requestId: string; outDir: string; now?: Date },
): Promise<ReceiptResult> {
  const bundle = await exportAuditBundle(db, {
    requestId: input.requestId,
    outDir: input.outDir,
    now: input.now,
  });
  const fs = await import("node:fs");
  const cryptoMod = await import("node:crypto");
  const { loadOrCreateLocalSigner } = await import("./local-keys.js");

  const manifestBytes = fs.readFileSync(bundle.manifestPath);
  const manifestHash = sha256(manifestBytes);
  const signer = loadOrCreateLocalSigner();
  const signerObj = cryptoMod.createSign("RSA-SHA256");
  signerObj.update(manifestBytes);
  const signature = signerObj.sign(signer.privateKeyPem);

  const pathMod = await import("node:path");
  const signaturePath = pathMod.join(bundle.outDir, "manifest.sig");
  const certPath = pathMod.join(bundle.outDir, "manifest.cert.pem");
  fs.writeFileSync(signaturePath, signature);
  fs.writeFileSync(certPath, signer.certificatePem);

  const now = input.now ?? new Date();
  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.receipt_signed",
    payload: {
      outDir: bundle.outDir,
      manifestSha256: manifestHash,
      signatureBytes: signature.length,
      signerSubject: signer.certificate.subject,
    },
    now,
  });

  return {
    outDir: bundle.outDir,
    manifestPath: bundle.manifestPath,
    signaturePath,
    certPath,
    manifestSha256: manifestHash,
    signatureBytes: signature.length,
    files: bundle.files,
    chain: bundle.chain,
  };
}

export type SignerPolicyAllOutcome = {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    requestId: string;
    ok: boolean;
    decision: PolicyDecision | null;
    applied: boolean;
    error: { code: string; message: string } | null;
  }>;
};

export function runSignerPolicyAll(
  db: SqliteDb,
  input: {
    signerEmail?: string;
    tokens: Record<string, string>;
    spec: PolicySpec;
    dryRun?: boolean;
    now?: Date;
  },
): SignerPolicyAllOutcome {
  const inbox = listSignerInbox(db, { signerEmail: input.signerEmail, now: input.now });
  const candidates = inbox.filter((entry) => entry.requestId && input.tokens[entry.requestId]);
  let succeeded = 0;
  let failed = 0;
  const results: SignerPolicyAllOutcome["results"] = [];
  for (const entry of candidates) {
    const requestId = entry.requestId!;
    const token = input.tokens[requestId];
    try {
      const outcome = runSignerPolicy(db, {
        requestId,
        token,
        spec: input.spec,
        dryRun: input.dryRun,
        now: input.now,
      });
      results.push({
        requestId,
        ok: true,
        decision: outcome.decision,
        applied: outcome.applied,
        error: null,
      });
      succeeded += 1;
    } catch (error) {
      const code = error instanceof SignCliError ? error.code : "INTERNAL";
      const message = error instanceof Error ? error.message : String(error);
      results.push({ requestId, ok: false, decision: null, applied: false, error: { code, message } });
      failed += 1;
    }
  }
  return { total: candidates.length, succeeded, failed, results };
}

export async function exportAuditChainAsJsonLd(
  db: SqliteDb,
  input: { requestId: string; outPath: string; now?: Date },
): Promise<{ outPath: string; bytes: number; events: number }> {
  const { renderAuditChainAsJsonLd } = await import("./audit-jsonld.js");
  const fs = await import("node:fs");
  const pathMod = await import("node:path");
  const requestRow = getRequestRow(db, input.requestId);
  const request = serializeRequestRow(requestRow);
  const events = listAuditEvents(db, input.requestId);
  const signers = JSON.parse(requestRow.signers_json) as SignerInput[];
  const snapshot = getRequestSnapshot(db, input.requestId, { now: input.now });
  const json = renderAuditChainAsJsonLd({
    request: {
      id: request.id,
      title: request.title,
      status: request.status,
      provider: request.normalizedProvider,
      documentSha256: requestRow.document_hash ?? null,
    },
    signers: signers.map((s) => ({ email: s.email, name: s.name, order: s.order })),
    signedBy: snapshot.signedBy?.map((s) => ({ email: s.email, name: s.name, signedAt: s.signedAt })) ?? null,
    events,
    now: input.now,
  });
  const resolved = pathMod.resolve(input.outPath);
  fs.mkdirSync(pathMod.dirname(resolved), { recursive: true });
  const text = JSON.stringify(json, null, 2);
  fs.writeFileSync(resolved, text);

  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "audit.exported_jsonld",
    payload: { outPath: resolved, bytes: text.length, events: events.length },
    now: input.now ?? new Date(),
  });

  return { outPath: resolved, bytes: text.length, events: events.length };
}

export type AuditHeadProof = {
  requestId: string;
  events: number;
  hashSelf: string;
  signature: string;
  signatureBytes: number;
  signerSubject: string;
  signerCertificatePem: string;
  signedAt: string;
};

// Signs the latest audit_events.hash_self for the request with the local CLI
// key, producing a small standalone proof a verifier can check with openssl
// or the matching X.509 cert. Records audit.head_signed in the chain so the
// proof itself is anchored.
export async function signAuditHead(
  db: SqliteDb,
  input: { requestId: string; outPath?: string; now?: Date },
): Promise<AuditHeadProof> {
  const cryptoMod = await import("node:crypto");
  const { loadOrCreateLocalSigner } = await import("./local-keys.js");
  getRequestRow(db, input.requestId);
  const lastEvent = db.prepare(
    "SELECT hash_self FROM audit_events WHERE request_id = ? ORDER BY id DESC LIMIT 1",
  ).get(input.requestId) as { hash_self: string } | undefined;
  if (!lastEvent) {
    throw new Error(`No audit events to sign for request ${input.requestId}.`);
  }
  const signer = loadOrCreateLocalSigner();
  const signerObj = cryptoMod.createSign("RSA-SHA256");
  signerObj.update(Buffer.from(lastEvent.hash_self, "utf8"));
  const signatureBuf = signerObj.sign(signer.privateKeyPem);
  const now = input.now ?? new Date();
  const eventsCountRow = db.prepare(
    "SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ?",
  ).get(input.requestId) as { n: number };
  const proof: AuditHeadProof = {
    requestId: input.requestId,
    events: eventsCountRow.n,
    hashSelf: lastEvent.hash_self,
    signature: signatureBuf.toString("base64"),
    signatureBytes: signatureBuf.length,
    signerSubject: signer.certificate.subject ?? "unknown",
    signerCertificatePem: signer.certificatePem,
    signedAt: now.toISOString(),
  };
  if (input.outPath) {
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const resolved = pathMod.resolve(input.outPath);
    fs.mkdirSync(pathMod.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(proof, null, 2));
  }
  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "audit.head_signed",
    payload: {
      hashSelf: lastEvent.hash_self,
      events: proof.events,
      signatureBytes: proof.signatureBytes,
      signerSubject: proof.signerSubject,
    },
    now,
  });
  return proof;
}

export async function verifyAuditHeadProof(proof: AuditHeadProof): Promise<{ ok: boolean; signerSubject: string }> {
  const cryptoMod = await import("node:crypto");
  const cert = new cryptoMod.X509Certificate(proof.signerCertificatePem);
  const verify = cryptoMod.createVerify("RSA-SHA256");
  verify.update(Buffer.from(proof.hashSelf, "utf8"));
  return {
    ok: verify.verify(cert.publicKey, Buffer.from(proof.signature, "base64")),
    signerSubject: cert.subject ?? "",
  };
}

export type BulkReceiptOutcome = {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    requestId: string;
    title: string;
    status: string;
    ok: boolean;
    outDir: string | null;
    error: { code: string; message: string } | null;
  }>;
};

export async function issueAuditReceiptsBulk(
  db: SqliteDb,
  input: {
    outDir: string;
    provider?: SignProvider;
    status?: string;
    limit?: number;
    onProgress?: (event: { row: number; total: number; requestId: string; phase: "issuing" | "done" | "error"; error?: string }) => void;
    now?: Date;
  },
): Promise<BulkReceiptOutcome> {
  const fs = await import("node:fs");
  const pathMod = await import("node:path");
  const onProgress = input.onProgress ?? (() => {});

  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.provider) { where.push("provider = ?"); params.push(input.provider); }
  if (input.status) { where.push("status = ?"); params.push(input.status); }
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.min(Number(input.limit), 5000) : 1000;
  const rows = db.prepare(
    `SELECT id, title, status FROM requests
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY datetime(created_at) DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<{ id: string; title: string; status: string }>;

  fs.mkdirSync(pathMod.resolve(input.outDir), { recursive: true });
  const results: BulkReceiptOutcome["results"] = [];
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rowOutDir = pathMod.join(pathMod.resolve(input.outDir), row.id);
    onProgress({ row: i + 1, total: rows.length, requestId: row.id, phase: "issuing" });
    try {
      const eventCount = (db.prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ?",
      ).get(row.id) as { n: number } | undefined)?.n ?? 0;
      if (eventCount === 0) {
        throw new SignCliError({
          code: "INVALID_SPEC",
          message: `Request ${row.id} has no audit events; refusing to issue a receipt for an empty chain.`,
        });
      }
      await exportRequestReceipt(db, { requestId: row.id, outDir: rowOutDir, now: input.now });
      results.push({ requestId: row.id, title: row.title, status: row.status, ok: true, outDir: rowOutDir, error: null });
      succeeded += 1;
      onProgress({ row: i + 1, total: rows.length, requestId: row.id, phase: "done" });
    } catch (error) {
      const err = error as { code?: unknown; message?: string };
      const code = typeof err?.code === "string" ? err.code : "INTERNAL";
      const message = typeof err?.message === "string" ? err.message : String(error);
      results.push({ requestId: row.id, title: row.title, status: row.status, ok: false, outDir: null, error: { code, message } });
      failed += 1;
      onProgress({ row: i + 1, total: rows.length, requestId: row.id, phase: "error", error: message });
    }
  }
  return { total: rows.length, succeeded, failed, results };
}

// --- Receipt re-signing -----------------------------------------------------
// After db rotate-keys, prior receipt manifests are still signed by the OLD
// key. They remain verifiable as long as the old cert hangs around, but
// auditors who want to verify everything against the LIVE key can call this
// to walk each previously-issued receipt and overwrite manifest.sig +
// manifest.cert.pem with fresh material.
//
// Source of truth for "where are the receipts" is the audit chain itself
// (request.receipt_signed events carry payload.outDir). Receipt directories
// that have moved or been deleted are reported as failures rather than
// aborting the batch.

export type ReSignReceiptsOutcome = {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    requestId: string;
    outDir: string;
    ok: boolean;
    error: { code: string; message: string } | null;
  }>;
};

export async function reSignAllReceipts(
  db: SqliteDb,
  input: { now?: Date } = {},
): Promise<ReSignReceiptsOutcome> {
  const fs = await import("node:fs");
  const pathMod = await import("node:path");
  const cryptoMod = await import("node:crypto");
  const { loadOrCreateLocalSigner } = await import("./local-keys.js");
  const signer = loadOrCreateLocalSigner();
  // Each request's most recent receipt dir wins — re-running an export
  // overwrites the same dir, so the latest event_id row is the live receipt.
  const rows = db.prepare(
    `SELECT request_id, payload_json
     FROM (
       SELECT request_id, payload_json, ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY id DESC) AS rn
       FROM audit_events
       WHERE event_type = 'request.receipt_signed'
     ) WHERE rn = 1`,
  ).all() as Array<{ request_id: string; payload_json: string }>;
  const results: ReSignReceiptsOutcome["results"] = [];
  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    let outDir = "";
    try {
      const payload = JSON.parse(row.payload_json) as { outDir?: unknown };
      outDir = typeof payload.outDir === "string" ? payload.outDir : "";
    } catch {
      // fall through
    }
    if (!outDir) {
      results.push({ requestId: row.request_id, outDir, ok: false, error: { code: "INTERNAL", message: "outDir missing from request.receipt_signed payload" } });
      failed += 1;
      continue;
    }
    const manifestPath = pathMod.join(outDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      results.push({ requestId: row.request_id, outDir, ok: false, error: { code: "INTERNAL", message: `manifest.json missing at ${manifestPath}` } });
      failed += 1;
      continue;
    }
    try {
      const manifestBytes = fs.readFileSync(manifestPath);
      const signerObj = cryptoMod.createSign("RSA-SHA256");
      signerObj.update(manifestBytes);
      const signature = signerObj.sign(signer.privateKeyPem);
      fs.writeFileSync(pathMod.join(outDir, "manifest.sig"), signature);
      fs.writeFileSync(pathMod.join(outDir, "manifest.cert.pem"), signer.certificatePem);
      appendAuditEvent(db, {
        requestId: row.request_id,
        eventType: "request.receipt_resigned",
        payload: {
          outDir,
          manifestSha256: sha256(manifestBytes),
          signatureBytes: signature.length,
          signerSubject: signer.certificate.subject,
        },
        now: input.now,
      });
      results.push({ requestId: row.request_id, outDir, ok: true, error: null });
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ requestId: row.request_id, outDir, ok: false, error: { code: "INTERNAL", message } });
      failed += 1;
    }
  }
  return { total: rows.length, succeeded, failed, results };
}
