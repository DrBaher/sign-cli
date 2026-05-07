import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendAuditEvent, verifyAuditChain } from "./audit.js";
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
import { inspectPdfSignatures, type PdfSignatureReport } from "./pdf-signature.js";
import { digestForChainHead, inspectTimestampResponse, issueRfc3161Timestamp, type TimestampInspection } from "./timestamp.js";
import {
  parseFieldSpec,
  type SignatureField,
} from "./field-placement.js";
import {
  cancelLocalDocument,
  checkLocalAccount,
  declineLocalDocument,
  downloadLocalCompletedPdf,
  fetchLocalDocumentStatus,
  fetchLocalEmbeddedSignUrl,
  listLocalSignerInbox,
  normalizeLocalStatus,
  readLocalDocument,
  remindLocalDocument,
  sendLocalDocument,
  signLocalDocument,
  type LocalSignerInboxEntry,
} from "./local-provider.js";
import { resolveSignProvider, type SignProvider } from "./providers.js";
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
    function localSendCommon(input: { request: RequestRow; signers: SignerInput[]; documents: RequestDocument[]; embedded: boolean; templateId?: string; prefills?: PrefillInput[] }) {
      const result = sendLocalDocument({
        documentPath: input.documents[0]?.path,
        documentPaths: input.documents.map((doc) => doc.path),
        templateId: input.templateId,
        title: input.request.title,
        signers: input.signers,
        prefills: input.prefills,
        metadata: { request_id: input.request.id, document_hash: input.request.document_hash },
        embeddedSigning: input.embedded,
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
        return localSendCommon({ request: input.request, signers: input.signers, documents: input.documents, embedded: false });
      },
      async sendEmbedded(input) {
        return localSendCommon({ request: input.request, signers: input.signers, documents: input.documents, embedded: true });
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

export function createSigningRequest(
  db: SqliteDb,
  input: CreateRequestInput,
): {
  requestId: string;
  documentHash: string;
  documents: RequestDocument[];
  templateId: string | null;
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
    db.prepare(
      `INSERT INTO artifacts (id, request_id, kind, path, content_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("art"),
      requestId,
      "document",
      document.path,
      document.hash,
      stableStringify({ title: input.title, name: document.name }),
      createdAt,
    );
  }

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
      primaryHash,
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

  return { requestId, documentHash: primaryHash, documents, tokens, templateId: input.templateId ?? null };
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
    force?: boolean;
    now?: Date;
    providerSend?: () => Promise<ProviderSendResult>;
    sendRequest?: typeof sendSignatureRequest;
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
  const provider = input.provider ?? getPersistedProvider(request);
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

export async function inspectRequestSignedPdf(
  db: SqliteDb,
  input: { requestId: string; path?: string; now?: Date },
): Promise<{ source: "request" | "path"; report: PdfSignatureReport }> {
  let pdfPath = input.path;
  let source: "request" | "path" = "path";
  if (!pdfPath) {
    getRequestRow(db, input.requestId);
    const artifact = findSignedPdfArtifact(db, input.requestId);
    if (!artifact) {
      throw new Error("No signed PDF artifact found for this request. Run `request fetch-final` first or pass --path.");
    }
    pdfPath = artifact.path;
    source = "request";
  }
  const report = await inspectPdfSignatures(pdfPath);
  const now = input.now ?? new Date();
  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.signed_pdf_inspected",
    payload: {
      path: pdfPath,
      hasSignature: report.hasSignature,
      signatureCount: report.signatureCount,
      digestMatchAll: report.signatures.every((sig) => sig.messageDigestMatches === true),
    },
    now,
  });
  return { source, report };
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
  db.prepare(
    `INSERT INTO artifacts (id, request_id, kind, path, content_hash, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createId("art"),
    input.requestId,
    "audit_timestamp",
    outPath,
    sha256(result.responseBuffer),
    stableStringify({ tsaUrl: result.tsaUrl, bytes: result.responseBuffer.length, hashSelf: lastEvent.hash_self }),
    nowIso(now),
  );

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
      results.push({ row: rowNumber, ok: false, requestId: null, signerEmail: signerEmail || null, error, providerRequestId: null });
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
      results.push({ row: rowNumber, ok: true, requestId: created.requestId, signerEmail, error: null, providerRequestId: sent.signatureRequestId });
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress({ row: rowNumber, total: input.rows.length, phase: "error", signerEmail, error: message });
      results.push({ row: rowNumber, ok: false, requestId: null, signerEmail, error: message, providerRequestId: null });
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
    throw new Error(
      `Signer-side flow only supports --provider local; this request uses ${providerDisplayName(provider)}. ` +
      `Use the provider's email link to sign.`,
    );
  }
  if (!getProviderRequestId(request)) {
    throw new Error(
      `Request ${request.id} has not been sent to the local provider yet; nothing to sign.`,
    );
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
    throw new Error("--token is required for signer-side commands.");
  }
  const tokenHash = sha256(trimmed);
  const approval = db.prepare(
    "SELECT * FROM approvals WHERE request_id = ? AND token_hash = ?",
  ).get(request.id, tokenHash) as ApprovalRow | undefined;
  if (!approval) {
    throw new Error(`Token does not match any signer on request ${request.id}.`);
  }
  if (new Date(approval.expires_at).getTime() < now.getTime()) {
    throw new Error(`Token has expired (expiresAt=${approval.expires_at}).`);
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
    throw new Error(
      `--signer-email ${signerEmailFlag} does not match the signer (${signer.email}) the token authorizes.`,
    );
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
      throw new Error(
        `Pre-sign safety check failed: --require-hash ${expected} does not match request document hash ${actual}.`,
      );
    }
  }
  if (checks.requireTitle) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(checks.requireTitle);
    } catch (error) {
      throw new Error(`--require-title is not a valid regular expression: ${(error as Error).message}`);
    }
    if (!pattern.test(request.title)) {
      throw new Error(
        `Pre-sign safety check failed: title ${JSON.stringify(request.title)} does not match --require-title /${checks.requireTitle}/.`,
      );
    }
  }
  if (checks.requireSignerEmail) {
    const expected = checks.requireSignerEmail.trim().toLowerCase();
    const actual = signer.email.trim().toLowerCase();
    if (expected !== actual) {
      throw new Error(
        `Pre-sign safety check failed: --require-signer-email ${expected} does not match resolved signer ${actual}.`,
      );
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
};

export function signSigningRequest(
  db: SqliteDb,
  input: {
    requestId: string;
    token: string;
    signerEmail?: string;
    signerName?: string;
    now?: Date;
  } & SignerSafetyChecks,
): SignerSignResult {
  const request = getRequestRow(db, input.requestId);
  const provider = getPersistedProvider(request);
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
    throw new Error(`Signer ${signer.email} has already signed request ${request.id}.`);
  }
  const result = signLocalDocument(providerRequestId, {
    signerEmail: signer.email,
    signerName: input.signerName ?? signer.name,
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

  return {
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

export type SignerInboxItem = LocalSignerInboxEntry;

export function listSignerInbox(
  db: SqliteDb,
  input: { signerEmail?: string } = {},
): SignerInboxItem[] {
  const inbox = listLocalSignerInbox(input.signerEmail);
  // Hydrate requestId from DB when local record doesn't have it (defensive — sendLocalDocument already stores it).
  return inbox.map((entry) => {
    if (entry.requestId) return entry;
    const row = db.prepare(
      "SELECT id FROM requests WHERE provider = 'local' AND provider_request_id = ?",
    ).get(entry.documentId) as { id: string } | undefined;
    return row ? { ...entry, requestId: row.id } : entry;
  });
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
