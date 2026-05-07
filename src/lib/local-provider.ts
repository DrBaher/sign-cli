import crypto from "node:crypto";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { signPdfLocally } from "./local-pdf-signer.js";
import type { PrefillInput, SignerInput } from "./util.js";

export type LocalSendInput = {
  documentPath?: string;
  documentPaths?: string[];
  templateId?: string;
  title: string;
  signers: SignerInput[];
  prefills?: PrefillInput[];
  metadata: Record<string, string>;
  embeddedSigning?: boolean;
};

const STORE_DIR = process.env.SIGN_LOCAL_STORE_DIR ?? "./data/local-provider";

type LocalDocumentRecord = {
  id: string;
  title: string;
  status: "sent" | "completed" | "canceled";
  documentPaths: string[];
  templateId: string | null;
  signers: SignerInput[];
  prefills: PrefillInput[];
  metadata: Record<string, string>;
  embeddedSigning: boolean;
  pollCount: number;
  createdAt: string;
  signedAt: string | null;
  signedPdfPath: string | null;
};

function recordPath(id: string): string {
  return path.join(STORE_DIR, `${id}.json`);
}

function readRecord(id: string): LocalDocumentRecord {
  const filePath = recordPath(id);
  if (!existsSync(filePath)) {
    throw new Error(`Local provider: document ${id} not found.`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeRecord(record: LocalDocumentRecord): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2), "utf8");
}

function makeDocumentId(): string {
  return `local_${crypto.randomBytes(8).toString("hex")}`;
}

function recipientId(index: number): string {
  return `local_recipient_${index + 1}`;
}

function autoCompleteThreshold(): number {
  const raw = process.env.SIGN_LOCAL_COMPLETE_AFTER;
  if (!raw) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
}

export function sendLocalDocument(input: LocalSendInput): {
  documentId: string;
  recipientIds: string[];
  status: string;
  responseBody: unknown;
  embeddedRecipients?: Array<{ id: string; email: string; embeddedSigningUrl: string }>;
} {
  const documentPaths = input.templateId
    ? []
    : ((input.documentPaths && input.documentPaths.length > 0) ? input.documentPaths : (input.documentPath ? [input.documentPath] : []));
  const id = makeDocumentId();
  const record: LocalDocumentRecord = {
    id,
    title: input.title,
    status: "sent",
    documentPaths,
    templateId: input.templateId ?? null,
    signers: input.signers,
    prefills: input.prefills ?? [],
    metadata: input.metadata,
    embeddedSigning: Boolean(input.embeddedSigning),
    pollCount: 0,
    createdAt: new Date().toISOString(),
    signedAt: null,
    signedPdfPath: null,
  };
  writeRecord(record);

  const recipientIds = input.signers.map((_, index) => recipientId(index));
  const embeddedRecipients = input.embeddedSigning
    ? input.signers.map((signer, index) => ({
      id: recipientId(index),
      email: signer.email,
      embeddedSigningUrl: `data:text/html,${encodeURIComponent(`<html><body><h2>Local provider sign view</h2><p>${signer.email} would sign here.</p><p>Document: ${input.title}</p></body></html>`)}`,
    }))
    : undefined;

  return {
    documentId: id,
    recipientIds,
    status: "sent",
    responseBody: {
      provider: "local",
      id,
      title: record.title,
      status: "sent",
      embedded_signing: record.embeddedSigning,
      recipients: input.signers.map((signer, index) => ({
        id: recipientId(index),
        email: signer.email,
        ...(record.embeddedSigning ? { embedded_signing_url: embeddedRecipients?.[index].embeddedSigningUrl } : {}),
      })),
      template_id: record.templateId,
      metadata: record.metadata,
    },
    ...(embeddedRecipients ? { embeddedRecipients } : {}),
  };
}

export function fetchLocalDocumentStatus(documentId: string): unknown {
  const record = readRecord(documentId);
  if (record.status === "sent") {
    record.pollCount += 1;
    if (record.pollCount > autoCompleteThreshold()) {
      record.status = "completed";
      record.signedAt = new Date().toISOString();
    }
    writeRecord(record);
  }
  return {
    id: record.id,
    status: record.status === "sent" ? "Sent" : record.status === "completed" ? "Completed" : "Canceled",
    recipients: record.signers.map((signer, index) => ({
      id: recipientId(index),
      status: record.status,
      email: signer.email,
    })),
    metadata: record.metadata,
    template_id: record.templateId,
  };
}

export function downloadLocalCompletedPdf(documentId: string): Buffer {
  const record = readRecord(documentId);
  if (record.status !== "completed") {
    throw new Error(`Local provider: document ${documentId} is not completed yet (status=${record.status}).`);
  }
  if (record.signedPdfPath && existsSync(record.signedPdfPath)) {
    return readFileSync(record.signedPdfPath);
  }

  let sourcePdf: Buffer;
  if (record.documentPaths.length > 0) {
    sourcePdf = readFileSync(record.documentPaths[0]);
  } else {
    sourcePdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 18 Tf 60 720 Td (Local provider template ${record.templateId ?? ""}) Tj ET
endstream
endobj
trailer << /Root 1 0 R /Size 5 >>
%%EOF`, "latin1");
  }

  const isPdf = sourcePdf.length >= 5 && sourcePdf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!isPdf) {
    sourcePdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
4 0 obj << /Length 80 >> stream
BT /F1 14 Tf 60 720 Td (Local provider signed: ${record.title}) Tj ET
endstream
endobj
trailer << /Root 1 0 R /Size 5 >>
%%EOF`, "latin1");
  }

  const result = signPdfLocally(sourcePdf);
  mkdirSync(STORE_DIR, { recursive: true });
  const outPath = path.join(STORE_DIR, `${documentId}.signed.pdf`);
  writeFileSync(outPath, result.signedPdf);
  record.signedPdfPath = outPath;
  writeRecord(record);
  return result.signedPdf;
}

export function cancelLocalDocument(documentId: string): unknown {
  const record = readRecord(documentId);
  record.status = "canceled";
  writeRecord(record);
  return { id: documentId, status: "canceled" };
}

export function remindLocalDocument(documentId: string): unknown {
  readRecord(documentId);
  return { id: documentId, reminder: "queued" };
}

export function checkLocalAccount(): { name: string; email: string } {
  return { name: "Sign CLI local simulator", email: "local@simulator" };
}

export function fetchLocalEmbeddedSignUrl(documentId: string, recipientIdValue: string): { signUrl: string; expiresAt: number | null } {
  const record = readRecord(documentId);
  const recipientIndex = record.signers.findIndex((_, index) => recipientId(index) === recipientIdValue);
  if (recipientIndex === -1) {
    throw new Error(`Local provider: recipient ${recipientIdValue} not found on document ${documentId}.`);
  }
  const signer = record.signers[recipientIndex];
  return {
    signUrl: `data:text/html,${encodeURIComponent(`<html><body><h2>Local provider sign view</h2><p>${signer.email} would sign here.</p><p>Document: ${record.title}</p></body></html>`)}`,
    expiresAt: null,
  };
}

export function normalizeLocalStatus(remoteStatus: unknown): string {
  const remote = remoteStatus as Record<string, unknown> | null;
  const raw = typeof remote?.status === "string" ? remote.status : "unknown";
  return raw.toLowerCase();
}
