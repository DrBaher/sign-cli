import crypto from "node:crypto";
import { readFileSync, mkdirSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadOrCreateSignerKeyPair } from "./local-keys.js";
import { signPdfLocally, signPdfLocallyMultiSigner } from "./local-pdf-signer.js";
import {
  detectMimeFromBytes,
  mimeToExt,
  stampImageOnPdf,
  type StampOptions,
  stampTextOnPdf,
  type ImageInput,
  type StampPosition,
} from "./pdf-image-stamp.js";
import { sha256 } from "./util.js";
import type { PrefillInput, SignerInput } from "./util.js";
import type { SignatureField } from "./field-placement.js";

export type LocalSendInput = {
  documentPath?: string;
  documentPaths?: string[];
  templateId?: string;
  title: string;
  signers: SignerInput[];
  prefills?: PrefillInput[];
  metadata: Record<string, string>;
  embeddedSigning?: boolean;
  /** Per-signer visible-signature placements, forwarded by the sender. */
  fields?: SignatureField[];
};

function storeDir(): string {
  return process.env.SIGN_LOCAL_STORE_DIR ?? "./data/local-provider";
}

type LocalDocumentRecord = {
  id: string;
  title: string;
  status: "sent" | "completed" | "canceled" | "declined";
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
  /** Sender-supplied signature placements. Phase-2 visible-signature lookup. */
  fields?: SignatureField[];
  signedBy: Array<{
    email: string;
    name: string;
    signedAt: string;
    certFingerprintSha256?: string;
    certSubjectCommonName?: string;
    /** Path to the rasterized signature image (PNG/JPG) on disk. */
    imagePath?: string;
    /** Where the image should be drawn before PAdES sealing. */
    imagePosition?: StampPosition;
    /** Additional positions to stamp the SAME image (`--auto-place all` etc.).
     *  Kept separate from `imagePosition` so old single-stamp records on disk
     *  remain readable without migration. */
    imageExtraPositions?: StampPosition[];
    /** Stamp options (aspect ratio, auto-crop) captured from the signer's
     *  `sign sign` invocation; replayed at stamp-time so the final visual
     *  matches the signer's request. */
    imageStampOptions?: StampOptions;
    /** When set, render this text (typically the signer's name) as a visible
     *  signature using a built-in italic font instead of an image. Mutually
     *  exclusive with imagePath. */
    nameSignatureText?: string;
  }>;
  declinedBy: string | null;
  declineReason: string | null;
};

function recordPath(id: string): string {
  return path.join(storeDir(), `${id}.json`);
}

function readRecord(id: string): LocalDocumentRecord {
  const filePath = recordPath(id);
  if (!existsSync(filePath)) {
    throw new Error(`Local provider: document ${id} not found.`);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as LocalDocumentRecord;
  if (!Array.isArray(parsed.signedBy)) parsed.signedBy = [];
  if (parsed.declinedBy === undefined) parsed.declinedBy = null;
  if (parsed.declineReason === undefined) parsed.declineReason = null;
  return parsed;
}

function writeRecord(record: LocalDocumentRecord): void {
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2), "utf8");
}

function autoCompleteEnabled(): boolean {
  const flag = (process.env.SIGN_LOCAL_AUTOCOMPLETE ?? "true").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(flag);
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

function findSignerByEmail(record: LocalDocumentRecord, email: string): SignerInput | null {
  const normalized = email.trim().toLowerCase();
  return record.signers.find((signer) => signer.email.trim().toLowerCase() === normalized) ?? null;
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
    ...(input.fields && input.fields.length > 0 ? { fields: input.fields } : {}),
    signedBy: [],
    declinedBy: null,
    declineReason: null,
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
  if (record.status === "sent" && autoCompleteEnabled()) {
    record.pollCount += 1;
    if (record.pollCount > autoCompleteThreshold()) {
      record.status = "completed";
      record.signedAt = new Date().toISOString();
    }
    writeRecord(record);
  } else if (record.status === "sent") {
    record.pollCount += 1;
    writeRecord(record);
  }
  const statusLabel =
    record.status === "sent"
      ? "Sent"
      : record.status === "completed"
        ? "Completed"
        : record.status === "declined"
          ? "Declined"
          : "Canceled";
  return {
    id: record.id,
    status: statusLabel,
    recipients: record.signers.map((signer, index) => ({
      id: recipientId(index),
      status: record.status,
      email: signer.email,
    })),
    signed_by: record.signedBy,
    declined_by: record.declinedBy,
    decline_reason: record.declineReason,
    metadata: record.metadata,
    template_id: record.templateId,
  };
}

export async function downloadLocalCompletedPdf(documentId: string): Promise<Buffer> {
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

  // Stamp each signer's visible signature (image or rendered-name text) onto
  // the source PDF *before* PAdES sealing. The stamp bytes become part of
  // the signed /ByteRange, so any post-signing tamper of the stamp breaks
  // the cryptographic verification.
  for (const entry of record.signedBy) {
    if (!entry.imagePosition) continue;
    if (entry.imagePath) {
      if (!existsSync(entry.imagePath)) {
        throw new Error(
          `Local provider: signer ${entry.email} has imagePath=${entry.imagePath} but the file is missing.`,
        );
      }
      const stampOptions = entry.imageStampOptions ?? {};
      sourcePdf = await stampImageOnPdf(
        sourcePdf,
        { kind: "file", path: entry.imagePath },
        entry.imagePosition,
        stampOptions,
      );
      // Replay any extra positions (e.g. --auto-place all). Each extra is
      // stamped with the SAME image bytes and SAME options, just at a new
      // rectangle. The stamping pipeline writes idempotently to the PDF, so
      // re-loading + re-saving per stamp is fine for the modest counts we
      // expect (typically 1–5).
      for (const pos of entry.imageExtraPositions ?? []) {
        sourcePdf = await stampImageOnPdf(
          sourcePdf,
          { kind: "file", path: entry.imagePath },
          pos,
          stampOptions,
        );
      }
    } else if (entry.nameSignatureText) {
      sourcePdf = await stampTextOnPdf(
        sourcePdf,
        entry.nameSignatureText,
        entry.imagePosition,
      );
    }
  }

  // Use per-signer keys for the embedded PAdES signature(s) when we have signedBy
  // entries — one PKCS#7 dict per signer, each with that signer's own cert.
  const dir = storeDir();
  mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${documentId}.signed.pdf`);
  let signedPdf: Buffer;
  if (record.signedBy.length > 0) {
    const multi = signPdfLocallyMultiSigner(
      sourcePdf,
      record.signedBy.map((entry) => ({
        keyPair: loadOrCreateSignerKeyPair({ email: entry.email, name: entry.name }),
        signerLabel: entry.email,
        signingTime: entry.signedAt ? new Date(entry.signedAt) : undefined,
      })),
    );
    signedPdf = multi.signedPdf;
  } else {
    const result = signPdfLocally(sourcePdf);
    signedPdf = result.signedPdf;
  }
  writeFileSync(outPath, signedPdf);
  record.signedPdfPath = outPath;
  writeRecord(record);
  return signedPdf;
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

export type LocalSignerInboxEntry = {
  documentId: string;
  requestId: string | null;
  title: string;
  status: LocalDocumentRecord["status"];
  signers: SignerInput[];
  signedBy: LocalDocumentRecord["signedBy"];
  declinedBy: string | null;
  declineReason: string | null;
  createdAt: string;
};

function recordToInboxEntry(record: LocalDocumentRecord): LocalSignerInboxEntry {
  return {
    documentId: record.id,
    requestId: typeof record.metadata?.request_id === "string" ? record.metadata.request_id : null,
    title: record.title,
    status: record.status,
    signers: record.signers,
    signedBy: record.signedBy,
    declinedBy: record.declinedBy,
    declineReason: record.declineReason,
    createdAt: record.createdAt,
  };
}

export function listLocalSignerInbox(signerEmail?: string): LocalSignerInboxEntry[] {
  const dir = storeDir();
  if (!existsSync(dir)) return [];
  const normalizedEmail = signerEmail?.trim().toLowerCase() ?? null;
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const entries: LocalSignerInboxEntry[] = [];
  for (const name of files) {
    let record: LocalDocumentRecord;
    try {
      record = readRecord(name.replace(/\.json$/u, ""));
    } catch {
      continue;
    }
    if (record.status !== "sent") continue;
    const signedEmails = new Set(record.signedBy.map((entry) => entry.email.trim().toLowerCase()));
    const matchingSigners = normalizedEmail
      ? record.signers.filter((signer) => signer.email.trim().toLowerCase() === normalizedEmail)
      : record.signers;
    if (matchingSigners.length === 0) continue;
    const pending = matchingSigners.some((signer) => !signedEmails.has(signer.email.trim().toLowerCase()));
    if (!pending) continue;
    entries.push(recordToInboxEntry(record));
  }
  return entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export type LocalDocumentSigningState = {
  documentId: string;
  status: LocalDocumentRecord["status"];
  signedBy: LocalDocumentRecord["signedBy"];
  declinedBy: string | null;
  declineReason: string | null;
};

export function getLocalDocumentSigningState(documentId: string): LocalDocumentSigningState {
  const record = readRecord(documentId);
  return {
    documentId: record.id,
    status: record.status,
    signedBy: record.signedBy,
    declinedBy: record.declinedBy,
    declineReason: record.declineReason,
  };
}

export type LocalDocumentReadResult = {
  documentId: string;
  title: string;
  signers: SignerInput[];
  signedBy: LocalDocumentRecord["signedBy"];
  status: LocalDocumentRecord["status"];
  pdf: Buffer;
  sha256: string;
  bytes: number;
};

export function readLocalDocument(documentId: string): LocalDocumentReadResult {
  const record = readRecord(documentId);
  let pdf: Buffer;
  if (record.documentPaths.length > 0) {
    pdf = readFileSync(record.documentPaths[0]);
  } else {
    pdf = Buffer.from(`%PDF-1.4
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
  return {
    documentId: record.id,
    title: record.title,
    signers: record.signers,
    signedBy: record.signedBy,
    status: record.status,
    pdf,
    sha256: sha256(pdf),
    bytes: pdf.length,
  };
}

export type SignLocalDocumentResult = {
  documentId: string;
  status: LocalDocumentRecord["status"];
  signedBy: LocalDocumentRecord["signedBy"];
  totalSigners: number;
  remainingSigners: number;
  signedAt: string;
};

export function signLocalDocument(
  documentId: string,
  input: {
    signerEmail: string;
    signerName?: string;
    now?: Date;
    /**
     * Optional visible signature image. When provided, the bytes are written to
     * disk under the local store and the path is recorded on the signer's entry.
     * `downloadLocalCompletedPdf` stamps it onto the PDF before PAdES sealing.
     */
    signatureImage?: ImageInput;
    signatureImagePosition?: StampPosition;
    /** Stamp options (aspect ratio, auto-crop) for the visible-image path. */
    signatureImageOptions?: StampOptions;
    /** Extra stamp positions (multi-candidate `--auto-place all` etc.). */
    signatureImageExtraPositions?: StampPosition[];
    /**
     * Alternative to `signatureImage`: render the given text (typically the
     * signer name) as a visible signature using a built-in italic font.
     * Mutually exclusive with `signatureImage` — both set is a caller bug
     * and will throw.
     */
    nameSignatureText?: string;
  },
): SignLocalDocumentResult {
  const record = readRecord(documentId);
  if (record.status === "canceled" || record.status === "declined") {
    throw new Error(`Local provider: document ${documentId} is ${record.status}; cannot sign.`);
  }
  const signer = findSignerByEmail(record, input.signerEmail);
  if (!signer) {
    throw new Error(`Local provider: ${input.signerEmail} is not a signer on document ${documentId}.`);
  }
  // Reject the caller bug of asking for both at once before doing any work.
  if (input.signatureImage && input.nameSignatureText) {
    throw new Error(
      `Local provider: --signature-image and --name-signature are mutually exclusive. ` +
        `Pass one or the other.`,
    );
  }
  // Resolve the visible-signature placement: explicit position wins; otherwise
  // fall back to the SignatureField the sender placed for this signer (by
  // signerOrder = the signer's index in record.signers, matching how
  // field-placement.ts ties fields to signer ordinals).
  const wantsVisibleStamp = Boolean(input.signatureImage || input.nameSignatureText);
  let resolvedPosition: StampPosition | undefined = input.signatureImagePosition;
  if (wantsVisibleStamp && !resolvedPosition && record.fields && record.fields.length > 0) {
    const signerOrder = record.signers.findIndex(
      (s) => s.email.trim().toLowerCase() === signer.email.trim().toLowerCase(),
    );
    if (signerOrder >= 0) {
      const match = record.fields.find(
        (f) => f.signerOrder === signerOrder && f.type === "signature" &&
          typeof f.page === "number" &&
          typeof f.x === "number" && typeof f.y === "number" &&
          typeof f.width === "number" && typeof f.height === "number",
      );
      if (match) {
        resolvedPosition = {
          page: match.page!,
          x: match.x!,
          y: match.y!,
          width: match.width!,
          height: match.height!,
        };
      }
    }
  }
  if (wantsVisibleStamp && !resolvedPosition) {
    const which = input.signatureImage ? "--signature-image" : "--name-signature";
    throw new Error(
      `Local provider: ${which} was provided but no position is available. ` +
        `Pass --image-page/--image-x/--image-y/--image-width/--image-height, or have the sender ` +
        `place a SignatureField (signerOrder=${record.signers.findIndex(
          (s) => s.email.trim().toLowerCase() === signer.email.trim().toLowerCase(),
        )}) at request-create time.`,
    );
  }

  // Persist the image bytes to disk so the eventual PDF assembly can pick them
  // up. One file per signer per document — keyed on a sha-ish slug so multiple
  // signs across documents don't collide. The extension is driven by the
  // detected mime so SVG inputs land as .svg (and get rasterized later, at
  // stamp time, at the resolution that fits the actual PDF rectangle).
  let imagePath: string | undefined;
  if (input.signatureImage && resolvedPosition) {
    const dir = path.join(storeDir(), "signatures");
    mkdirSync(dir, { recursive: true });
    const slug = sha256(`${documentId}::${signer.email.trim().toLowerCase()}`).slice(0, 16);
    const bytes = input.signatureImage.kind === "buffer"
      ? input.signatureImage.data
      : readFileSync(input.signatureImage.path);
    const mime = input.signatureImage.kind === "buffer"
      ? input.signatureImage.mime
      : detectMimeFromBytes(bytes);
    imagePath = path.join(dir, `${slug}.${mimeToExt(mime)}`);
    writeFileSync(imagePath, bytes);
  }

  const normalized = signer.email.trim().toLowerCase();
  const alreadySigned = record.signedBy.some((entry) => entry.email.trim().toLowerCase() === normalized);
  const now = input.now ?? new Date();
  const signedAt = now.toISOString();
  if (!alreadySigned) {
    const signerKey = loadOrCreateSignerKeyPair({
      email: signer.email,
      name: input.signerName ?? signer.name,
    });
    record.signedBy.push({
      email: signer.email,
      name: input.signerName ?? signer.name,
      signedAt,
      certFingerprintSha256: signerKey.fingerprintSha256,
      certSubjectCommonName: signerKey.subjectCommonName,
      ...(imagePath ? { imagePath } : {}),
      ...(input.nameSignatureText ? { nameSignatureText: input.nameSignatureText } : {}),
      ...(resolvedPosition ? { imagePosition: resolvedPosition } : {}),
      ...(input.signatureImageExtraPositions && input.signatureImageExtraPositions.length > 0
        ? { imageExtraPositions: input.signatureImageExtraPositions } : {}),
      ...(input.signatureImageOptions ? { imageStampOptions: input.signatureImageOptions } : {}),
    });
  } else if ((imagePath || input.nameSignatureText) && resolvedPosition) {
    // Re-signing with a new visible-signature spec: update the existing entry
    // rather than adding a duplicate.
    const existing = record.signedBy.find((entry) => entry.email.trim().toLowerCase() === normalized);
    if (existing) {
      if (imagePath) {
        existing.imagePath = imagePath;
        delete existing.nameSignatureText;
      } else if (input.nameSignatureText) {
        existing.nameSignatureText = input.nameSignatureText;
        delete existing.imagePath;
      }
      existing.imagePosition = resolvedPosition;
    }
  }
  const totalSigners = record.signers.length;
  if (record.signedBy.length >= totalSigners) {
    record.status = "completed";
    record.signedAt = record.signedAt ?? signedAt;
  }
  writeRecord(record);
  return {
    documentId: record.id,
    status: record.status,
    signedBy: record.signedBy,
    totalSigners,
    remainingSigners: Math.max(0, totalSigners - record.signedBy.length),
    signedAt,
  };
}

export type DeclineLocalDocumentResult = {
  documentId: string;
  status: LocalDocumentRecord["status"];
  declinedBy: string;
  declineReason: string | null;
  declinedAt: string;
};

export function declineLocalDocument(
  documentId: string,
  input: { signerEmail: string; reason?: string; now?: Date },
): DeclineLocalDocumentResult {
  const record = readRecord(documentId);
  if (record.status === "completed") {
    throw new Error(`Local provider: document ${documentId} is already completed; cannot decline.`);
  }
  if (record.status === "canceled") {
    throw new Error(`Local provider: document ${documentId} is canceled; cannot decline.`);
  }
  const signer = findSignerByEmail(record, input.signerEmail);
  if (!signer) {
    throw new Error(`Local provider: ${input.signerEmail} is not a signer on document ${documentId}.`);
  }
  const declinedAt = (input.now ?? new Date()).toISOString();
  record.status = "declined";
  record.declinedBy = signer.email;
  record.declineReason = input.reason ?? null;
  writeRecord(record);
  return {
    documentId: record.id,
    status: record.status,
    declinedBy: signer.email,
    declineReason: record.declineReason,
    declinedAt,
  };
}
