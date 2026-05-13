// One-shot orchestrator for `sign document`: takes a DOCX or PDF input,
// converts to PDF if needed, auto-detects a signature-field rectangle,
// stamps the signature image (or rendered name), and PAdES-seals the
// result — all in a single command.
//
// Design notes:
//
//   - The signing-side state (audit chain, signer entries, intermediate
//     artifacts) lives in a TEMP database for the duration of the call,
//     so we never pollute the user's main `./data/sign.db`. The temp dir
//     is removed at the end regardless of success/failure.
//
//   - The DOCX→PDF step is delegated to `docx2pdf-cli` (companion CLI in
//     this repo's deps). PDF inputs skip that step entirely.
//
//   - Signer email defaults to `<slugified-name>@local.invalid` for
//     self-sign flows so the caller doesn't have to invent one.
//
//   - The output PDF is the same byte sequence that would come out of
//     `sign sign` on a real signing request — same PAdES envelope, same
//     visible-signature stamp, same audit chain (just in the temp DB
//     instead of the user's persistent one).

import { spawnSync as _spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { selectAutoPlaceCandidates, type AutoPlaceMode } from "./auto-place-selector.js";
import { openDatabase } from "./db.js";
import { convertDocxToPdf, isDocxLikePath } from "./docx2pdf-convert.js";
import type { ImageInput, StampOptions, StampPosition } from "./pdf-image-stamp.js";
import { detectSignatureFields } from "./signature-field-detection.js";
import { SignCliError } from "./sign-error.js";
import {
  createSigningRequest,
  fetchFinalSignedPdf,
  sendSigningRequest,
  signSigningRequest,
  verifyRequestAuditChain,
} from "./signing-service.js";
import { assessStampQuality, type QualityWarning } from "./stamp-quality.js";

void _spawnSync; // silence unused-import warning; spawnSync usage is in docx2pdf-convert

export type SignDocumentInput = {
  /** Path to the input document — .docx, .doc, .odt, .rtf, or .pdf. */
  inputPath: string;
  /** Path to write the final sealed PDF. */
  outPath: string;
  /** Signer's full name (printed on the signature cert + record). */
  signerName: string;
  /** Optional. Defaults to `<slugified-name>@local.invalid`. */
  signerEmail?: string;
  /** Optional title. Defaults to the basename of inputPath. */
  title?: string;
  /** Visible signature image (mutually exclusive with nameSignatureText). */
  signatureImage?: ImageInput;
  /** Visible signature as rendered text (mutually exclusive with signatureImage). */
  nameSignatureText?: string;
  /**
   * Placement mode. Defaults to `{ kind: "first" }` so the most common
   * one-shot flow (single signature anchor → sign there) "just works".
   * Pass `{ kind: "none" }` to force explicit `imagePosition`.
   */
  autoPlaceMode?: AutoPlaceMode;
  /** Explicit position; overrides auto-place. */
  imagePosition?: StampPosition;
  /** Stamp render options (aspect ratio, auto-crop). Defaults applied at stamp time. */
  signatureImageOptions?: StampOptions;
};

export type SignDocumentResult = {
  ok: true;
  input: string;
  output: string;
  bytes: number;
  converted: boolean;
  converterBackend?: string;
  signedAt: string;
  placements: StampPosition[];
  warnings: QualityWarning[];
  verify: {
    chainValid: boolean;
    events: number;
    signers: number;
  };
};

export async function signDocumentOneShot(input: SignDocumentInput): Promise<SignDocumentResult> {
  if (!input.signatureImage && !input.nameSignatureText) {
    throw new SignCliError({
      code: "MISSING_FLAG",
      message: "sign document requires either --signature-image or --name-signature.",
      hint: "Pass --signature-image <path|data-url> or --name-signature \"Your Name\".",
    });
  }
  if (input.signatureImage && input.nameSignatureText) {
    throw new SignCliError({
      code: "SIGN_VISIBLE_SIG_BOTH",
      message: "--signature-image and --name-signature are mutually exclusive.",
      hint: "Pick one — pass --signature-image for an image or --name-signature for a rendered-text stamp.",
    });
  }

  // ── 1. Convert DOCX → PDF if needed ─────────────────────────────────────
  let workingPdfPath = input.inputPath;
  let converted = false;
  let converterBackend: string | undefined;
  let cleanupConvert: (() => void) | undefined;
  if (isDocxLikePath(input.inputPath)) {
    const conv = await convertDocxToPdf(input.inputPath);
    workingPdfPath = conv.pdfPath;
    converted = true;
    converterBackend = conv.backendUsed;
    cleanupConvert = conv.cleanup;
  }

  // ── 2. Temp signing-flow env (isolated db + key + store dirs) ──────────
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "sign-document-"));
  const tempDbPath = path.join(tmpRoot, "s.db");
  const savedEnv = {
    keyDir: process.env.SIGN_LOCAL_KEY_DIR,
    storeDir: process.env.SIGN_LOCAL_STORE_DIR,
    allowAbsolute: process.env.SIGN_ALLOW_ABSOLUTE_DOCS,
  };
  process.env.SIGN_LOCAL_KEY_DIR = path.join(tmpRoot, "keys");
  process.env.SIGN_LOCAL_STORE_DIR = path.join(tmpRoot, "store");
  // Allow absolute paths for our own tempfiles; the user-facing CLI flag
  // is unaffected (this env var is scoped to the temp signing-flow run).
  process.env.SIGN_ALLOW_ABSOLUTE_DOCS = "1";

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(tempDbPath);

    // ── 3. Auto-place dispatch — runs BEFORE creating the request so a ────
    // failure (no candidates, ambiguous, etc.) errors out cleanly before
    // any audit events are written, even to the temp DB.
    const pdfBytes = readFileSync(workingPdfPath);
    let primary: StampPosition | undefined = input.imagePosition;
    let extras: StampPosition[] = [];
    if (!primary) {
      const detection = await detectSignatureFields(pdfBytes);
      const mode = input.autoPlaceMode ?? { kind: "first" };
      if (mode.kind !== "none") {
        const sel = selectAutoPlaceCandidates(detection.signatureCandidates, mode);
        if (!sel.ok) {
          throw new SignCliError({
            code: sel.errorCode,
            message: sel.message,
            hint: sel.hint,
            details: { candidates: sel.allCandidates },
          });
        }
        const [first, ...rest] = sel.chosen;
        primary = {
          page: first.page, x: first.x, y: first.y, width: first.width, height: first.height,
        };
        extras = rest.map((c) => ({ page: c.page, x: c.x, y: c.y, width: c.width, height: c.height }));
      }
    }
    if (!primary) {
      throw new SignCliError({
        code: "MISSING_FLAG",
        message: "sign document needs a stamp position: pass --auto-place <selector> or --image-page/--image-x/--image-y/--image-width/--image-height.",
      });
    }

    // ── 4. Create + send + sign — single signer (self-sign) ─────────────
    const signerEmail = input.signerEmail ?? `${slugifyEmail(input.signerName)}@local.invalid`;
    const created = createSigningRequest(db, {
      title: input.title ?? path.basename(input.inputPath, path.extname(input.inputPath)),
      documentPath: path.resolve(workingPdfPath),
      signers: [{ name: input.signerName, email: signerEmail, order: 1 }],
      provider: "local",
      autoApprove: true,
      tokenTtlMinutes: 60,
    });

    await sendSigningRequest(db, { requestId: created.requestId, testMode: false });

    const signed = signSigningRequest(db, {
      requestId: created.requestId,
      token: created.tokens[0].token,
      signerName: input.signerName,
      signatureImage: input.signatureImage,
      signatureImagePosition: primary,
      ...(extras.length > 0 ? { signatureImageExtraPositions: extras } : {}),
      signatureImageOptions: input.signatureImageOptions,
      nameSignatureText: input.nameSignatureText,
    });

    // ── 5. Pull the sealed PDF + copy to the user's --out ───────────────
    const finalIntermediate = path.join(tmpRoot, "final.pdf");
    const fetched = await fetchFinalSignedPdf(db, {
      requestId: created.requestId,
      outPath: finalIntermediate,
    });
    copyFileSync(finalIntermediate, input.outPath);

    // ── 6. Verify (audit chain + structural quality on the sealed PDF) ──
    const verify = verifyRequestAuditChain(db, created.requestId);
    const finalBytes = readFileSync(input.outPath);
    const allWarnings: QualityWarning[] = [];
    for (const pos of [primary, ...extras]) {
      const w = await assessStampQuality({
        pdfBytes: finalBytes,
        page: pos.page, x: pos.x, y: pos.y, width: pos.width, height: pos.height,
      });
      allWarnings.push(...w);
    }

    return {
      ok: true,
      input: input.inputPath,
      output: input.outPath,
      bytes: fetched.bytes,
      converted,
      converterBackend,
      signedAt: signed.signedAt,
      placements: [primary, ...extras],
      warnings: allWarnings,
      verify: {
        chainValid: verify.valid,
        events: verify.events,
        signers: 1,
      },
    };
  } finally {
    db?.close?.();
    if (savedEnv.keyDir === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = savedEnv.keyDir;
    if (savedEnv.storeDir === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = savedEnv.storeDir;
    if (savedEnv.allowAbsolute === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = savedEnv.allowAbsolute;
    rmSync(tmpRoot, { recursive: true, force: true });
    cleanupConvert?.();
  }
}

function slugifyEmail(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "")
    || "signer";
}
