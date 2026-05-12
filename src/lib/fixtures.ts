// Locator for the canonical unsigned PDF fixture (Item 4 of the product-
// readiness feedback). Tests should call canonicalUnsignedPdfPath() instead
// of rolling their own minimal `%PDF-1.4...%%EOF` blob — the fixture is a
// real, pdf-lib-loadable single-page document, byte-deterministic across
// runs, regenerable via scripts/generate-canonical-unsigned-pdf.ts.

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Filename of the canonical fixture. Versioned (`-v1`) so a future format
 *  change (e.g. adding a second page or switching to PDF/A) gets a new file
 *  rather than silently breaking tests that hash the bytes. */
export const CANONICAL_UNSIGNED_PDF_FIXTURE = "canonical-unsigned-v1.pdf";

/** Absolute path to the canonical unsigned PDF fixture. Resolves relative
 *  to the package root (../../fixtures from this file) so it works from both
 *  src/ during typecheck-style imports and dist/ at runtime. */
export function canonicalUnsignedPdfPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/lib/fixtures.ts → ../../fixtures
  // dist/lib/fixtures.js → ../../fixtures
  return path.resolve(here, "..", "..", "fixtures", CANONICAL_UNSIGNED_PDF_FIXTURE);
}
