// `sign workflow nda` — end-to-end: render the bundled (or user-supplied)
// mutual-NDA Markdown template with the caller's values, write the PDF to
// disk, then create a signing request with the two named parties.
//
// Item 7 of the product-readiness feedback. The point is to collapse what
// is otherwise a 4-step recipe — render template → write PDF → resolve
// signers → create request — into a single command for the most common
// pre-canned contract.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  placeholders,
  renderTemplateToPdf,
  type TemplateValues,
} from "./template-render.js";
import {
  createSigningRequest,
  type CreateRequestInput,
  type CreateRequestResult,
} from "./signing-service.js";
import type { SqliteDb } from "./db.js";
import type { SignProvider } from "./providers.js";
import type { SignerInput } from "./util.js";

/** Path to the bundled mutual-NDA template. Resolves relative to this
 *  module so it works both from src/ (tests) and dist/ (production). */
export function bundledMutualNdaPath(): string {
  // src/lib/workflow-nda.ts → ../../fixtures/templates/mutual-nda.md
  // dist/lib/workflow-nda.js → ../../fixtures/templates/mutual-nda.md
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "fixtures", "templates", "mutual-nda.md");
}

/** Keys the mutual-NDA template uses to derive a default request title. */
const DEFAULT_TITLE_KEYS = {
  partyA: "PARTY_A_NAME",
  partyB: "PARTY_B_NAME",
} as const;

export type NdaWorkflowOptions = {
  /** Path to a Markdown template file. Defaults to the bundled mutual-NDA. */
  templatePath?: string;
  /** Substitution values for `{{KEY}}` placeholders in the template. */
  values: TemplateValues;
  /** Party A's email address (signer order 1). */
  partyAEmail: string;
  /** Party B's email address (signer order 2). */
  partyBEmail: string;
  /** Where to write the rendered PDF. Parent dirs are created if missing. */
  outPath: string;
  /** Override the request title. Defaults to
   *  `Mutual NDA — {{PARTY_A_NAME}} & {{PARTY_B_NAME}}` when those keys exist,
   *  else `Mutual NDA`. */
  title?: string;
  /** If true, the request is auto-approved + immediately sent. */
  autoApprove?: boolean;
  provider?: SignProvider;
  /** Token TTL in minutes for both signers. Default 60. */
  tokenTtlMinutes?: number;
  /** Override Party A's display name (defaults to PARTY_A_SIGNATORY or "Party A"). */
  partyAName?: string;
  /** Override Party B's display name (defaults to PARTY_B_SIGNATORY or "Party B"). */
  partyBName?: string;
};

export type NdaWorkflowResult = {
  ok: true;
  templateUsed: "bundled" | "custom";
  templatePath: string;
  pdfPath: string;
  pdfBytes: number;
  placeholders: string[];
  /** Resolved title — explicit override, or derived from PARTY_*_NAME. */
  title: string;
  /** Resolved signer list, mirrored from what was passed to createSigningRequest
   *  so callers don't have to dig through `request.tokens[].signer` to find it. */
  signers: SignerInput[];
  request: CreateRequestResult;
};

function deriveDefaultTitle(values: TemplateValues): string {
  const a = values[DEFAULT_TITLE_KEYS.partyA];
  const b = values[DEFAULT_TITLE_KEYS.partyB];
  if (a && b) return `Mutual NDA — ${a} & ${b}`;
  return "Mutual NDA";
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(path.resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function runNdaWorkflow(
  db: SqliteDb,
  opts: NdaWorkflowOptions,
): Promise<NdaWorkflowResult> {
  if (opts.partyAEmail === opts.partyBEmail) {
    throw new Error("Party A and Party B must use different email addresses.");
  }
  const templatePath = opts.templatePath ?? bundledMutualNdaPath();
  if (!existsSync(templatePath)) {
    throw new Error(`NDA template not found: ${templatePath}`);
  }
  const templateUsed: "bundled" | "custom" =
    opts.templatePath === undefined ? "bundled" : "custom";

  const templateSource = readFileSync(templatePath, "utf8");
  const placeholderKeys = placeholders(templateSource);

  // Render → bytes. substitute() inside throws with a consolidated list of
  // missing keys, so the user sees every gap at once.
  const pdfBytes = await renderTemplateToPdf(templateSource, opts.values);

  ensureParentDir(opts.outPath);
  writeFileSync(opts.outPath, pdfBytes);

  const partyAName =
    opts.partyAName ?? opts.values["PARTY_A_SIGNATORY"] ?? "Party A";
  const partyBName =
    opts.partyBName ?? opts.values["PARTY_B_SIGNATORY"] ?? "Party B";

  const signers: SignerInput[] = [
    { name: partyAName, email: opts.partyAEmail, order: 1 },
    { name: partyBName, email: opts.partyBEmail, order: 2 },
  ];

  const title = opts.title ?? deriveDefaultTitle(opts.values);

  const createInput: CreateRequestInput = {
    title,
    documentPath: opts.outPath,
    signers,
    tokenTtlMinutes: opts.tokenTtlMinutes ?? 60,
    ...(opts.autoApprove !== undefined ? { autoApprove: opts.autoApprove } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
  const request = createSigningRequest(db, createInput);

  return {
    ok: true,
    templateUsed,
    templatePath,
    pdfPath: path.resolve(opts.outPath),
    pdfBytes: pdfBytes.length,
    placeholders: placeholderKeys,
    title,
    signers,
    request,
  };
}
