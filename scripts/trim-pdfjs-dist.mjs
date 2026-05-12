// trim-pdfjs-dist: post-install cleanup that drops files we never use from
// pdfjs-dist's node_modules tree. Brings the install footprint from ~36 MB
// down to ~7.5 MB without affecting the only thing we import from pdfjs-dist:
// text-position extraction via `pdfjs-dist/legacy/build/pdf.mjs`.
//
// What we drop and why:
//
//   build/               — non-legacy ESM build, duplicate of legacy/. We
//                          only import from `legacy/build/pdf.mjs`.
//   web/                 — pdf.js's HTML viewer assets; never loaded in Node.
//   image_decoders/      — alternate entry point we never import.
//   wasm/                — JPEG2000/JBIG2 WASM decoders, needed only when
//                          rendering pages with those image codecs. Text
//                          extraction never touches them.
//   cmaps/               — CJK character-map files. Loaded only when the
//                          caller passes a `cMapUrl` to `getDocument()` AND
//                          the PDF uses CIDFontType0/2. We don't pass it
//                          and our anchor patterns are English-only.
//   standard_fonts/      — Standard-14 font data, loaded only when the caller
//                          passes `standardFontDataUrl`. We pass `undefined`.
//   **/*.map             — sourcemaps. Used only on errors, and we'd rather
//                          have a smaller install than a prettier stack trace
//                          on a pdfjs internal error.
//
// Safety properties:
//
//   1. Idempotent — running this script repeatedly is fine; rm with
//      force=true is a no-op if the target is already gone.
//
//   2. Scoped to OUR copy of pdfjs-dist. We resolve via `import.meta.url`,
//      so when sign-cli is installed as a dependency of someone else's
//      project and pdfjs-dist is hoisted to their root node_modules
//      (NOT under sign-cli's), our local path won't exist and we skip.
//      We never modify a consumer's pdfjs-dist.
//
//   3. No-op when pdfjs-dist isn't installed (e.g., `npm ci
//      --omit=optional` or a deps prune).

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pdfjsRoot = join(here, "..", "node_modules", "pdfjs-dist");

if (!existsSync(pdfjsRoot)) {
  // Either pdfjs-dist isn't installed, or sign-cli is itself installed as a
  // dependency and pdfjs-dist got hoisted out of our tree. Either way, the
  // safe behavior is to skip — we never want to reach up into a consumer's
  // node_modules.
  process.exit(0);
}

const dirsToRemove = [
  "build",
  "web",
  "image_decoders",
  "wasm",
  "cmaps",
  "standard_fonts",
];

let bytesDropped = 0;

function pathSize(p) {
  // Best-effort directory size — used only for the console summary.
  try {
    const stat = statSync(p);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const entry of readdirSync(p)) total += pathSize(join(p, entry));
    return total;
  } catch {
    return 0;
  }
}

for (const dir of dirsToRemove) {
  const target = join(pdfjsRoot, dir);
  if (existsSync(target)) {
    bytesDropped += pathSize(target);
    rmSync(target, { recursive: true, force: true });
  }
}

// Walk what's left and drop sourcemaps.
function dropMapsIn(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      dropMapsIn(full);
    } else if (entry.endsWith(".map")) {
      bytesDropped += stat.size;
      rmSync(full, { force: true });
    }
  }
}
dropMapsIn(pdfjsRoot);

const mb = (bytesDropped / 1024 / 1024).toFixed(1);
if (bytesDropped > 0) {
  console.log(
    `[trim-pdfjs-dist] removed ${mb} MB of unused pdfjs-dist assets ` +
      `(non-legacy build, viewer assets, image/WASM decoders, CJK cmaps, ` +
      `standard fonts, sourcemaps). Text extraction is unaffected.`,
  );
}
