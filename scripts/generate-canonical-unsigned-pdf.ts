// One-shot generator for fixtures/canonical-unsigned-v1.pdf.
//
// The output is a real, valid PDF that pdf-lib can load + stamp — not the
// hand-written "%PDF-1.4\n%nothing\n%%EOF" placeholder some tests still use.
// Run via `npm run build && node dist/scripts/generate-canonical-unsigned-pdf.js`.
//
// We pin every timestamp + the /ID array so the output is byte-deterministic
// across runs (machine clock doesn't leak in). If pdf-lib's output ever
// changes (e.g. version bump shifts byte offsets), regenerate by re-running
// this script and commit the new bytes — fixtures/canonical-unsigned-v1.pdf
// is the authoritative file, this script is documentation of how it was made.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFHexString, PDFName, PDFArray, StandardFonts } from "pdf-lib";

async function main() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Canonical Unsigned Fixture — sign-cli");
  pdf.setAuthor("sign-cli");
  pdf.setSubject("Test fixture for the sign-cli end-to-end flow.");
  pdf.setKeywords(["sign-cli", "fixture", "unsigned"]);
  pdf.setProducer("sign-cli scripts/generate-canonical-unsigned-pdf.ts");
  pdf.setCreator("sign-cli");
  // Fixed epoch ⇒ deterministic bytes.
  const epoch = new Date("2026-01-01T00:00:00.000Z");
  pdf.setCreationDate(epoch);
  pdf.setModificationDate(epoch);

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]); // US Letter
  page.setFont(font);
  page.drawText("Canonical Unsigned Fixture", { x: 72, y: 720, size: 24 });
  page.drawText("(sign-cli — fixtures/canonical-unsigned-v1.pdf)", { x: 72, y: 690, size: 12 });
  page.drawText("This PDF is intentionally unsigned. Use it as a known-clean", { x: 72, y: 640, size: 12 });
  page.drawText("starting point for testing the sign-cli create / send / sign", { x: 72, y: 620, size: 12 });
  page.drawText("flow without rolling your own minimal PDF in every test setup.", { x: 72, y: 600, size: 12 });
  page.drawText("Reproduce: npm run build && node dist/scripts/generate-canonical-unsigned-pdf.js", { x: 72, y: 540, size: 9 });

  // Pin the trailer /ID so the file is byte-identical across machines. pdf-lib
  // generates a randomized /ID by default — overwrite it with a fixed hex pair
  // derived from the fixture name + version.
  const fixedId = PDFHexString.of("63616e6f6e6963616c2d756e7369676e65642d31"); // "canonical-unsigned-1"
  const idArray = pdf.context.obj([fixedId, fixedId]) as PDFArray;
  pdf.context.trailerInfo.ID = idArray;

  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
  const outPath = path.resolve("fixtures/canonical-unsigned-v1.pdf");
  writeFileSync(outPath, bytes);
  console.log(`wrote ${outPath} (${bytes.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
