import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stampTextOnPdf } from "../lib/pdf-image-stamp.js";
import { canonicalUnsignedPdfPath } from "../lib/fixtures.js";
import { PDFDocument, decodePDFRawStream } from "pdf-lib";

const CLI = path.resolve("dist/cli.js");

function runCli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("node", [CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function parseJsonAfterBanner(out: string): unknown {
  // CLI prints a banner line + extra newlines; the JSON document is at the
  // end of stdout. Find the first '{' and parse from there.
  const idx = out.indexOf("{");
  if (idx < 0) throw new Error(`no JSON in output: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(idx));
}

/** Decompress every content stream on the requested page, return the decoded
 *  bytes as latin1. pdf-lib emits text as <hex> literals (e.g.
 *  `<426168657220416C2048616B696D> Tj`), so use `pageContainsText` for the
 *  semantic check rather than grepping raw bytes. */
async function decodedPageStreams(pdfBytes: Buffer, pageNumber: number): Promise<string> {
  const pdf = await PDFDocument.load(pdfBytes);
  const page = pdf.getPage(pageNumber - 1);
  const Contents = page.node.Contents();
  if (!Contents) return "";
  // pdf-lib's Contents may be a single stream or an array of streams; the
  // .asArray() accessor handles both.
  const refs = "asArray" in Contents ? (Contents as { asArray: () => Array<unknown> }).asArray() : [Contents];
  let out = "";
  for (const ref of refs) {
    const stream = pdf.context.lookup(ref as never);
    if (stream && (stream as { decode?: unknown }).decode) {
      // already a stream — decode directly
      out += Buffer.from(decodePDFRawStream(stream as never).decode()).toString("latin1");
    } else if (stream) {
      out += Buffer.from(decodePDFRawStream(stream as never).decode()).toString("latin1");
    }
  }
  return out;
}

async function pageContainsText(pdfBytes: Buffer, pageNumber: number, text: string): Promise<boolean> {
  const decoded = await decodedPageStreams(pdfBytes, pageNumber);
  const hexForm = Buffer.from(text, "latin1").toString("hex").toUpperCase();
  // pdf-lib uses uppercase hex; check both as a safety net.
  return decoded.includes(hexForm) || decoded.includes(hexForm.toLowerCase()) || decoded.includes(text);
}

test("stampTextOnPdf: draws text on the page and the rendered string survives in the decoded content stream", async () => {
  const src = readFileSync(canonicalUnsignedPdfPath());
  const out = await stampTextOnPdf(src, "Baher Al Hakim", {
    page: 1, x: 100, y: 100, width: 180, height: 50,
  });
  // pdf-lib emits text as `<hex> Tj` inside compressed content streams, so
  // a raw bytes-grep won't find it. Decompress and look for the hex form.
  assert.ok(await pageContainsText(out, 1, "Baher Al Hakim"), "stamped text should be in the decoded page content stream");
  assert.ok(out.length > src.length, "stamped PDF should be larger than source");
});

test("stampTextOnPdf: rejects empty text, zero-size rectangle, out-of-range page", async () => {
  const src = readFileSync(canonicalUnsignedPdfPath());
  await assert.rejects(
    () => stampTextOnPdf(src, "   ", { page: 1, x: 0, y: 0, width: 100, height: 50 }),
    /text is empty/,
  );
  await assert.rejects(
    () => stampTextOnPdf(src, "x", { page: 1, x: 0, y: 0, width: 0, height: 50 }),
    /width and height must be > 0/,
  );
  await assert.rejects(
    () => stampTextOnPdf(src, "x", { page: 99, x: 0, y: 0, width: 100, height: 50 }),
    /out of range/,
  );
});

test("stampTextOnPdf: autosizes long text so it fits the rectangle", async () => {
  const src = readFileSync(canonicalUnsignedPdfPath());
  // A very long signature in a narrow rectangle — should not throw, should fit.
  const out = await stampTextOnPdf(
    src,
    "A Very Long Signer Name With Many Words That Would Otherwise Overflow",
    { page: 1, x: 100, y: 100, width: 200, height: 50 },
  );
  assert.ok(out.length > src.length);
});

test("CLI sign --name-signature renders the signer name into the signed PDF", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "namesig-cli-"));
  try {
    const dbPath = path.join(tmp, "s.db");
    const docPath = path.join(tmp, "doc.pdf");
    writeFileSync(docPath, readFileSync(canonicalUnsignedPdfPath()));

    const env = {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
      SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    };

    // Create + auto-approve as the local provider
    const createOut = runCli(
      ["--provider", "local", "request", "create",
        "--title", "Name-sig test", "--document", docPath,
        "--signer", "name:Baher Al Hakim,email:baher@e.com,order:1",
        "--auto-approve", "true"],
      env,
    );
    assert.equal(createOut.status, 0, `create failed: ${createOut.stderr}`);
    const created = parseJsonAfterBanner(createOut.stdout) as { requestId: string; tokens: Array<{ token: string }> };

    // Send (local)
    const sendOut = runCli(
      ["--provider", "local", "request", "send", "--request-id", created.requestId],
      env,
    );
    assert.equal(sendOut.status, 0, `send failed: ${sendOut.stderr}`);

    // Sign with --name-signature (literal string form)
    const signOut = runCli(
      ["sign",
        "--request-id", created.requestId, "--token", created.tokens[0].token,
        "--name-signature", "Baher Al Hakim",
        "--image-page", "1", "--image-x", "100", "--image-y", "100",
        "--image-width", "180", "--image-height", "50"],
      env,
    );
    assert.equal(signOut.status, 0, `sign failed: ${signOut.stderr}`);

    // Fetch the final signed PDF and confirm the name landed in the bytes.
    const signedPath = path.join(tmp, "signed.pdf");
    const fetchOut = runCli(
      ["--provider", "local", "request", "fetch-final", "--request-id", created.requestId, "--out", signedPath],
      env,
    );
    assert.equal(fetchOut.status, 0, `fetch-final failed: ${fetchOut.stderr}`);

    const signedBytes = readFileSync(signedPath);
    assert.ok(await pageContainsText(signedBytes, 1, "Baher Al Hakim"), "rendered name should appear in signed PDF page content");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI sign --name-signature true uses --signer-name as the text", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "namesig-true-"));
  try {
    const dbPath = path.join(tmp, "s.db");
    const docPath = path.join(tmp, "doc.pdf");
    writeFileSync(docPath, readFileSync(canonicalUnsignedPdfPath()));

    const env = {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
      SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    };

    const createOut = runCli(
      ["--provider", "local", "request", "create", "--title", "T", "--document", docPath,
        "--signer", "name:Alice,email:alice@e.com,order:1", "--auto-approve", "true"],
      env,
    );
    const created = parseJsonAfterBanner(createOut.stdout) as { requestId: string; tokens: Array<{ token: string }> };
    runCli(["--provider", "local", "request", "send", "--request-id", created.requestId], env);

    // --name-signature true + --signer-name "Custom Override"
    const signOut = runCli(
      ["sign",
        "--request-id", created.requestId, "--token", created.tokens[0].token,
        "--name-signature", "true",
        "--signer-name", "Custom Override",
        "--image-page", "1", "--image-x", "100", "--image-y", "100",
        "--image-width", "180", "--image-height", "50"],
      env,
    );
    assert.equal(signOut.status, 0, `sign failed: ${signOut.stderr}`);

    const signedPath = path.join(tmp, "signed.pdf");
    runCli(["--provider", "local", "request", "fetch-final", "--request-id", created.requestId, "--out", signedPath], env);
    const signedBytes = readFileSync(signedPath);
    assert.ok(await pageContainsText(signedBytes, 1, "Custom Override"), "rendered name should match --signer-name");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI sign rejects --name-signature true without --signer-name", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "namesig-missing-"));
  try {
    const dbPath = path.join(tmp, "s.db");
    const docPath = path.join(tmp, "doc.pdf");
    writeFileSync(docPath, readFileSync(canonicalUnsignedPdfPath()));

    const env = {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
      SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    };

    const createOut = runCli(
      ["--provider", "local", "request", "create", "--title", "T", "--document", docPath,
        "--signer", "name:Alice,email:alice@e.com,order:1", "--auto-approve", "true"],
      env,
    );
    const created = parseJsonAfterBanner(createOut.stdout) as { requestId: string; tokens: Array<{ token: string }> };
    runCli(["--provider", "local", "request", "send", "--request-id", created.requestId], env);

    const signOut = runCli(
      ["sign", "--request-id", created.requestId, "--token", created.tokens[0].token,
        "--name-signature", "true",
        "--image-page", "1", "--image-x", "100", "--image-y", "100",
        "--image-width", "180", "--image-height", "50"],
      env,
    );
    assert.notEqual(signOut.status, 0, "should fail when --name-signature true is set without --signer-name");
    assert.match(signOut.stderr + signOut.stdout, /NAME_SIGNATURE_MISSING_TEXT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI sign rejects both --signature-image and --name-signature at once", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "namesig-both-"));
  try {
    const dbPath = path.join(tmp, "s.db");
    const docPath = path.join(tmp, "doc.pdf");
    writeFileSync(docPath, readFileSync(canonicalUnsignedPdfPath()));
    const imgPath = path.join(tmp, "img.png");
    // Smallest valid PNG (1x1 transparent).
    writeFileSync(imgPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));

    const env = {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
      SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    };

    const createOut = runCli(
      ["--provider", "local", "request", "create", "--title", "T", "--document", docPath,
        "--signer", "name:Alice,email:alice@e.com,order:1", "--auto-approve", "true"],
      env,
    );
    const created = parseJsonAfterBanner(createOut.stdout) as { requestId: string; tokens: Array<{ token: string }> };
    runCli(["--provider", "local", "request", "send", "--request-id", created.requestId], env);

    const signOut = runCli(
      ["sign", "--request-id", created.requestId, "--token", created.tokens[0].token,
        "--signature-image", imgPath,
        "--name-signature", "Alice",
        "--image-page", "1", "--image-x", "100", "--image-y", "100",
        "--image-width", "180", "--image-height", "50"],
      env,
    );
    assert.notEqual(signOut.status, 0, "should fail when both flags are set");
    assert.match(signOut.stderr + signOut.stdout, /SIGN_VISIBLE_SIG_BOTH/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI sign --name-signature without any position errors with a useful hint", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "namesig-nopos-"));
  try {
    const dbPath = path.join(tmp, "s.db");
    const docPath = path.join(tmp, "doc.pdf");
    writeFileSync(docPath, readFileSync(canonicalUnsignedPdfPath()));

    const env = {
      SIGN_DB_PATH: dbPath,
      SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
      SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    };

    const createOut = runCli(
      ["--provider", "local", "request", "create", "--title", "T", "--document", docPath,
        "--signer", "name:Alice,email:alice@e.com,order:1", "--auto-approve", "true"],
      env,
    );
    const created = parseJsonAfterBanner(createOut.stdout) as { requestId: string; tokens: Array<{ token: string }> };
    runCli(["--provider", "local", "request", "send", "--request-id", created.requestId], env);

    // No --image-* coords + no --field on create → should error with a hint
    const signOut = runCli(
      ["sign", "--request-id", created.requestId, "--token", created.tokens[0].token,
        "--name-signature", "Alice"],
      env,
    );
    assert.notEqual(signOut.status, 0, "should fail with missing position");
    const combined = signOut.stderr + signOut.stdout;
    assert.match(combined, /--name-signature was provided but no position is available/);
    assert.match(combined, /--image-page/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
