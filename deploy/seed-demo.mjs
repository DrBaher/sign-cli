#!/usr/bin/env node
// Seed the hosted-demo DB with a handful of sample requests so the bundled
// web dashboard isn't empty on first load. Idempotent against a freshly-wiped
// data dir; we expect entrypoint.sh to call us right after `rm -rf data/`.
//
// We shell out to ./dist/cli.js rather than importing internals so the seed
// path exercises the same surface a user would hit. Failures are non-fatal:
// a partially seeded demo is still better than a 502.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CLI = path.resolve("dist/cli.js");
const DATA_DIR = process.env.SIGN_DB_PATH
  ? path.dirname(process.env.SIGN_DB_PATH)
  : path.resolve("data");
const DOCS_DIR = path.join(DATA_DIR, "demo-docs");
mkdirSync(DOCS_DIR, { recursive: true });

function tinyPdf(label) {
  const stream = `BT /F1 14 Tf 60 720 Td (${label}) Tj ET`;
  return Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
      `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n` +
      `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream\nendobj\n` +
      `trailer << /Root 1 0 R /Size 5 >>\n%%EOF\n`,
    "latin1",
  );
}

function run(args, { allowFail = false } = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SIGN_ERROR_FORMAT: "json",
      SIGN_ALLOW_ABSOLUTE_DOCS: "1",
    },
  });
  if (r.status !== 0 && !allowFail) {
    process.stderr.write(`seed: ${args.join(" ")} failed\n${r.stderr}\n`);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.stderr.write(`seed: ${args.join(" ")} non-fatal failure\n${r.stderr}\n`);
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return r.stdout.trim();
  }
}

const samples = [
  {
    title: "Mutual NDA — Acme × Globex",
    doc: "nda.pdf",
    signers: [
      { name: "Alice Demo", email: "alice@demo.local", order: 1 },
      { name: "Bob Demo", email: "bob@demo.local", order: 2 },
    ],
    autoComplete: false,
  },
  {
    title: "Statement of Work — Q2 engagement",
    doc: "sow.pdf",
    signers: [{ name: "Carol Demo", email: "carol@demo.local", order: 1 }],
    autoComplete: true,
  },
  {
    title: "Vendor onboarding — data-processing addendum",
    doc: "dpa.pdf",
    signers: [
      { name: "Dan Demo", email: "dan@demo.local", order: 1 },
      { name: "Eve Demo", email: "eve@demo.local", order: 2 },
      { name: "Frank Demo", email: "frank@demo.local", order: 3 },
    ],
    autoComplete: false,
  },
  {
    title: "Contractor offer letter",
    doc: "offer.pdf",
    signers: [{ name: "Grace Demo", email: "grace@demo.local", order: 1 }],
    autoComplete: false,
  },
];

let signed = 0;
for (const sample of samples) {
  const docPath = path.join(DOCS_DIR, sample.doc);
  writeFileSync(docPath, tinyPdf(sample.title));
  const signerArgs = sample.signers.flatMap((s) => [
    "--signer",
    `name:${s.name},email:${s.email},order:${s.order}`,
  ]);
  const created = run([
    "request",
    "create",
    "--provider",
    "local",
    "--title",
    sample.title,
    "--document",
    docPath,
    ...signerArgs,
    "--auto-approve",
    "true",
  ]);
  if (!created?.requestId) continue;

  // Push to the local provider so it shows up in the signer inbox.
  run(["request", "send", "--request-id", created.requestId, "--provider", "local"], {
    allowFail: true,
  });

  // For the "auto-complete" sample, poll status with autocomplete on so the
  // request transitions to completed and the audit chain gets a sign event.
  // SIGN_LOCAL_COMPLETE_AFTER=0 makes the first poll flip status to completed.
  if (sample.autoComplete) {
    spawnSync(
      "node",
      [CLI, "request", "status", "--request-id", created.requestId, "--provider", "local"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SIGN_LOCAL_AUTOCOMPLETE: "true",
          SIGN_LOCAL_COMPLETE_AFTER: "0",
        },
      },
    );
    signed += 1;
  }
  process.stdout.write(`seeded ${created.requestId}: ${sample.title}\n`);
}

// Fire one dry-run anchor so `audit anchors-list` returns something even
// without network egress. Real anchors hit a TSA — we skip those by default.
run(["audit", "anchor", "--dry-run", "true"], { allowFail: true });

process.stdout.write(`seed complete (${samples.length} requests sent, ${signed} signed)\n`);
