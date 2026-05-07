import type { SqliteDb } from "./db.js";
import { getRequestSnapshot } from "./signing-service.js";

export type FieldDiff = { field: string; before: unknown; after: unknown };

export type SignerDiff = {
  added: Array<{ email: string; name: string; order: number }>;
  removed: Array<{ email: string; name: string; order: number }>;
  same: Array<{ email: string; name: string; order: number }>;
};

export type RequestDiffResult = {
  beforeRequestId: string;
  afterRequestId: string;
  identical: boolean;
  fieldDiffs: FieldDiff[];
  signerDiff: SignerDiff;
  documentChanged: boolean;
  documentSha256: { before: string | null; after: string | null };
};

const TRACKED_FIELDS = ["title", "status", "provider", "template_id"] as const;

export function diffRequests(
  db: SqliteDb,
  before: string,
  after: string,
): RequestDiffResult {
  const beforeSnap = getRequestSnapshot(db, before);
  const afterSnap = getRequestSnapshot(db, after);

  const fieldDiffs: FieldDiff[] = [];
  for (const field of TRACKED_FIELDS) {
    const a = (beforeSnap.request as unknown as Record<string, unknown>)[field];
    const b = (afterSnap.request as unknown as Record<string, unknown>)[field];
    if ((a ?? null) !== (b ?? null)) {
      fieldDiffs.push({ field, before: a ?? null, after: b ?? null });
    }
  }

  const beforeSigners = JSON.parse(beforeSnap.request.signers_json) as Array<{ email: string; name: string; order: number }>;
  const afterSigners = JSON.parse(afterSnap.request.signers_json) as Array<{ email: string; name: string; order: number }>;
  const beforeEmails = new Set(beforeSigners.map((s) => s.email.trim().toLowerCase()));
  const afterEmails = new Set(afterSigners.map((s) => s.email.trim().toLowerCase()));
  const signerDiff: SignerDiff = {
    added: afterSigners.filter((s) => !beforeEmails.has(s.email.trim().toLowerCase())),
    removed: beforeSigners.filter((s) => !afterEmails.has(s.email.trim().toLowerCase())),
    same: afterSigners.filter((s) => beforeEmails.has(s.email.trim().toLowerCase())),
  };

  const beforeHash = beforeSnap.request.document_hash ?? null;
  const afterHash = afterSnap.request.document_hash ?? null;
  const documentChanged = (beforeHash ?? "") !== (afterHash ?? "");

  return {
    beforeRequestId: beforeSnap.request.id,
    afterRequestId: afterSnap.request.id,
    identical:
      fieldDiffs.length === 0 &&
      signerDiff.added.length === 0 &&
      signerDiff.removed.length === 0 &&
      !documentChanged,
    fieldDiffs,
    signerDiff,
    documentChanged,
    documentSha256: { before: beforeHash, after: afterHash },
  };
}
