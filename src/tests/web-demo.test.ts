import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpApiServer } from "../lib/http-api.js";
import { inspectPdfSignatures } from "../lib/pdf-signature.js";
import { createDb, makeTempDb } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function fetchPath(server: http.Server, urlPath: string, headers: Record<string, string> = {}): Promise<Response> {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return fetch(`http://127.0.0.1:${port}${urlPath}`, { redirect: "manual", headers });
}

test("sign serve --web-demo serves index.html same-origin without auth", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const webDemoDir = path.resolve("fixtures/web-demo");
  const server = startHttpApiServer({ db, port: 0, webDemoDir, authToken: "shhh" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    // GET / redirects to /web-demo/index.html
    const root = await fetchPath(server, "/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/web-demo/index.html");

    // The actual HTML loads without an auth token
    const html = await fetchPath(server, "/web-demo/index.html");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    const body = await html.text();
    assert.match(body, /sign-cli web demo/);

    // app.js loads
    const js = await fetchPath(server, "/web-demo/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    // sample-signed.pdf fixture is served with application/pdf so the browser
    // previews it inline instead of treating it as a binary download.
    const pdf = await fetchPath(server, "/web-demo/sample-signed.pdf");
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-type") ?? "", /application\/pdf/);

    // The fixture must be signed with a per-signer cert (CN includes the
    // signer's email), not the generic org cert. Guards against the
    // fixture-generation script accidentally falling through to
    // loadOrCreateLocalSigner() — which previously shipped a misleading
    // "CN=Sign CLI Local Signer" subject in the demo download.
    const fixturePath = path.join(repoRoot, "fixtures", "web-demo", "sample-signed.pdf");
    const inspection = await inspectPdfSignatures(fixturePath);
    assert.equal(inspection.signatureCount, 1, "fixture has exactly one signature");
    assert.equal(inspection.signatures[0].messageDigestMatches, true, "fixture digest must match");
    const subjectBlob = inspection.signatures[0].signers.map((c) => c.subject ?? "").join(" | ");
    assert.match(subjectBlob, /@/, `fixture cert subject must include an email (got: ${subjectBlob})`);

    // The embedded signature image must contain *visible* content, not just
    // be a near-empty rectangle. Previous regressions:
    //   - <text> SVG with no font (resvg-wasm ships zero fonts)  → ~355 B PNG
    //   - <text> SVG with stroke flourish but no rendered glyphs → ~917 B PNG
    // The current path-based signature produces ≥ 3 KB image XObjects.
    // Conservative threshold of 1500 B for the largest image catches both
    // historical regressions with margin.
    const fixtureBytes = readFileSync(fixturePath);
    const fixtureText = fixtureBytes.toString("latin1");
    const imageLengths: number[] = [];
    const imageRe = /\/Subtype\s*\/Image\b[\s\S]*?\/Length\s+(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = imageRe.exec(fixtureText)) !== null) imageLengths.push(parseInt(match[1], 10));
    assert.ok(imageLengths.length >= 1, "fixture must embed at least one image XObject");
    const largest = Math.max(...imageLengths);
    assert.ok(
      largest >= 1500,
      `fixture's largest embedded image is only ${largest} bytes — likely an empty / blank rectangle. ` +
      `Regenerate via \`node scripts/generate-signed-fixture.mjs\` and visually verify the signature is visible.`,
    );

    // /v1/* still gated by the auth token
    const api = await fetchPath(server, "/v1/health");
    assert.equal(api.status, 401);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("sign serve --web-demo blocks path traversal attempts", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const webDemoDir = path.resolve("fixtures/web-demo");
  const server = startHttpApiServer({ db, port: 0, webDemoDir });
  await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    const traversal = await fetchPath(server, "/web-demo/../package.json");
    // Browsers normalize ../ before sending, but raw HTTP clients may not — confirm the
    // server still refuses to step outside the demo dir.
    assert.ok(traversal.status === 403 || traversal.status === 404);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("sign serve without --web-demo returns 404 for /web-demo/index.html", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    const res = await fetchPath(server, "/web-demo/index.html");
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});
