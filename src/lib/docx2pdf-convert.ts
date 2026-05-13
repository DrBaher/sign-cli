// Thin shell around the docx2pdf-cli companion tool. We don't re-implement
// any conversion logic here, and we don't re-expose docx2pdf-cli's flags
// (backend, timeout, fidelity, etc.) — the integration is intentionally
// minimal so docx2pdf-cli stays the single source of truth for converter
// behavior. Callers that want backend control should invoke docx2pdf-cli
// directly first and pass the resulting PDF to `sign document`.
//
// What we do here:
//   1. Resolve `docx2pdf-cli/src/cli.js` via require.resolve so the same
//      binary works in dev and after `npm install`.
//   2. Spawn it with `--json --quiet`, writing the PDF to a temp dir.
//   3. Parse the trailing JSON line to surface the backend that was used
//      (informational; reported back through `sign document`'s output).
//   4. On failure, surface the JSON `error` field (falling back to a few
//      lines of stderr) inside a `DOCX_CONVERSION_FAILED` SignCliError,
//      with a hint to run `npx docx2pdf --doctor` for diagnostics.
//
// What we DON'T do:
//   - Backend selection (handled by docx2pdf-cli's --backend flag if used
//     directly).
//   - Fidelity / strict mode toggles.
//   - Timeout overrides.
//   - Batch conversion (out of scope for sign document).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { SignCliError } from "./sign-error.js";

const require = createRequire(import.meta.url);

export type ConvertResult = {
  /** Path to the produced PDF inside a temp directory. */
  pdfPath: string;
  /** Backend docx2pdf-cli used (parsed from its JSON output). */
  backendUsed?: string;
  /** Caller must invoke this once they're done reading `pdfPath`. */
  cleanup: () => void;
};

const DOCX_LIKE_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".rtf"]);

export function isDocxLikePath(inputPath: string): boolean {
  return DOCX_LIKE_EXTENSIONS.has(path.extname(inputPath).toLowerCase());
}

/**
 * Convert a word-processing document to PDF. Caller MUST call
 * `result.cleanup()` once done with `result.pdfPath`.
 */
export async function convertDocxToPdf(inputPath: string): Promise<ConvertResult> {
  let docx2pdfBin: string;
  try {
    docx2pdfBin = require.resolve("docx2pdf-cli/src/cli.js");
  } catch {
    throw new SignCliError({
      code: "DOCX_CONVERSION_FAILED",
      message: "docx2pdf-cli is not installed alongside sign-cli.",
      hint:
        "It's a runtime dep — try `npm install docx2pdf-cli` (may have been " +
        "pruned), or pass a PDF directly to `sign document` instead of a DOCX.",
    });
  }

  try { statSync(inputPath); } catch (err) {
    throw new SignCliError({
      code: "INVALID_ARGS",
      message: `Input file not found: ${inputPath}`,
      hint: (err as { message?: string }).message,
    });
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "sign-doc-convert-"));
  const outPath = path.join(tmpDir, "converted.pdf");

  const result = spawnSync("node", [docx2pdfBin, "--json", "--quiet", inputPath, outPath], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    let detail: string | undefined;
    try {
      const last = (result.stdout ?? "").trim().split(/\r?\n/).pop();
      if (last) {
        const parsed = JSON.parse(last) as { error?: { message?: string }; message?: string };
        detail = parsed.error?.message ?? parsed.message;
      }
    } catch { /* fall through to stderr */ }
    if (!detail) detail = (result.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" ");
    throw new SignCliError({
      code: "DOCX_CONVERSION_FAILED",
      message: `docx2pdf failed (exit ${result.status}): ${detail || "no diagnostic available"}`,
      hint:
        "Run `npx docx2pdf --doctor` to see which backends (LibreOffice, Pages, " +
        "Word, Gotenberg, ConvertAPI, textutil) are available in your environment. " +
        "For backend overrides, run docx2pdf directly first and pass the resulting PDF " +
        "to `sign document`.",
    });
  }

  let backendUsed: string | undefined;
  try {
    const last = (result.stdout ?? "").trim().split(/\r?\n/).pop();
    if (last) backendUsed = (JSON.parse(last) as { backend?: string }).backend;
  } catch { /* informational only */ }

  return {
    pdfPath: outPath,
    backendUsed,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}
