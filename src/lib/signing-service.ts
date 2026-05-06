import { readFileSync } from "node:fs";
import path from "node:path";
import { appendAuditEvent } from "./audit.js";
import type { SqliteDb } from "./db.js";
import { fetchSignatureRequestStatus, sendSignatureRequest } from "./dropbox-sign.js";
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

export type CreateRequestInput = {
  title: string;
  documentPath: string;
  signers: SignerInput[];
  tokenTtlMinutes: number;
  now?: Date;
};

type RequestRow = {
  id: string;
  title: string;
  document_path: string;
  document_hash: string;
  status: string;
  dropbox_signature_request_id: string | null;
  dropbox_status: string | null;
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

export function createSigningRequest(db: SqliteDb, input: CreateRequestInput): {
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
      id, title, document_path, document_hash, status, dropbox_signature_request_id, dropbox_status, signers_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    input.title,
    documentPath,
    documentHash,
    "created",
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

  appendAuditEvent(db, {
    requestId,
    eventType: "request.created",
    payload: {
      title: input.title,
      documentPath,
      documentHash,
      signers: sortedSigners,
      tokenTtlMinutes: input.tokenTtlMinutes,
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
  input: { requestId: string; apiKey: string; testMode: boolean; now?: Date },
): Promise<{
  signatureRequestId: string;
  responseBody: unknown;
}> {
  const request = getRequestRow(db, input.requestId);
  const signers = JSON.parse(request.signers_json) as SignerInput[];
  const result = await sendSignatureRequest({
    apiKey: input.apiKey,
    documentPath: request.document_path,
    title: request.title,
    signers,
    metadata: {
      request_id: request.id,
      document_hash: request.document_hash,
    },
    testMode: input.testMode,
  });

  const now = input.now ?? new Date();
  db.prepare(
    `UPDATE requests
     SET status = ?, dropbox_signature_request_id = ?, dropbox_status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    "sent",
    result.signatureRequestId,
    "sent",
    nowIso(now),
    input.requestId,
  );

  appendAuditEvent(db, {
    requestId: input.requestId,
    eventType: "request.sent",
    payload: {
      signatureRequestId: result.signatureRequestId,
      testMode: input.testMode,
    },
    now,
  });

  return {
    signatureRequestId: result.signatureRequestId,
    responseBody: result.responseBody,
  };
}

export async function getSigningRequestStatus(
  db: SqliteDb,
  input: { requestId: string; apiKey: string; now?: Date },
): Promise<{
  request: RequestRow;
  remoteStatus: unknown;
}> {
  const request = getRequestRow(db, input.requestId);
  if (!request.dropbox_signature_request_id) {
    throw new Error("Request has not been sent to Dropbox Sign yet.");
  }
  const remoteStatus = await fetchSignatureRequestStatus(
    input.apiKey,
    request.dropbox_signature_request_id,
  );

  const remote = remoteStatus as any;
  const signatureRequest = remote?.signatureRequest ?? remote?.signature_request ?? null;
  const statusValue = signatureRequest?.isComplete || signatureRequest?.is_complete
    ? "completed"
    : signatureRequest?.statusCode ?? signatureRequest?.status_code ?? "sent";

  const now = input.now ?? new Date();
  db.prepare("UPDATE requests SET dropbox_status = ?, updated_at = ? WHERE id = ?").run(
    String(statusValue),
    nowIso(now),
    request.id,
  );

  appendAuditEvent(db, {
    requestId: request.id,
    eventType: "request.status_checked",
    payload: {
      dropboxSignatureRequestId: request.dropbox_signature_request_id,
      dropboxStatus: statusValue,
    },
    now,
  });

  return { request: getRequestRow(db, request.id), remoteStatus };
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
    db.prepare(
      "UPDATE requests SET dropbox_signature_request_id = COALESCE(dropbox_signature_request_id, ?), updated_at = ? WHERE id = ?",
    ).run(input.payload.signature_request.signature_request_id, nowIso(now), requestId);
  }

  return { verified, requestId, eventType };
}

export function getRequestSnapshot(db: SqliteDb, requestId: string): {
  request: RequestRow;
  approvals: ApprovalRow[];
} {
  return {
    request: getRequestRow(db, requestId),
    approvals: listApprovalRows(db, requestId),
  };
}
