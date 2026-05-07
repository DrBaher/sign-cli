import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SignProvider } from "./providers.js";

export type WizardIo = {
  prompt(question: string): Promise<string>;
  log(line: string): void;
};

export function createDefaultIo(): { io: WizardIo; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    io: {
      prompt: async (question) => (await rl.question(question)).trim(),
      log: (line) => process.stdout.write(`${line}\n`),
    },
    close: () => rl.close(),
  };
}

export type InitAnswers = {
  provider: SignProvider;
  values: Record<string, string>;
};

const PROVIDER_FIELDS: Record<SignProvider, Array<{ key: string; description: string; secret?: boolean; default?: string }>> = {
  dropbox: [
    { key: "DROPBOX_SIGN_API_KEY", description: "Dropbox Sign API key", secret: true },
    { key: "DROPBOX_SIGN_TEST_MODE", description: "Use test mode while validating?", default: "true" },
    { key: "DROPBOX_SIGN_CLIENT_ID", description: "Client ID for embedded signing (optional)" },
  ],
  signwell: [
    { key: "SIGNWELL_API_KEY", description: "SignWell API key", secret: true },
    { key: "SIGNWELL_BASE_URL", description: "SignWell base URL", default: "https://www.signwell.com/api/v1" },
    { key: "SIGNWELL_TEST_MODE", description: "Use test mode while validating?", default: "true" },
    { key: "SIGNWELL_WEBHOOK_SECRET", description: "Webhook secret (defaults to API key when blank)" },
  ],
  docusign: [
    { key: "DOCUSIGN_INTEGRATION_KEY", description: "DocuSign integration key" },
    { key: "DOCUSIGN_USER_ID", description: "User GUID to impersonate" },
    { key: "DOCUSIGN_ACCOUNT_ID", description: "Account ID" },
    { key: "DOCUSIGN_BASE_PATH", description: "Base path", default: "https://demo.docusign.net/restapi" },
    { key: "DOCUSIGN_PRIVATE_KEY_PATH", description: "Path to RSA private key file", default: "./keys/docusign-private.key" },
  ],
  local: [],
};

export async function collectInitAnswers(io: WizardIo): Promise<InitAnswers> {
  io.log("Welcome to sign! This wizard writes a .env file for the provider you pick.");
  io.log("Choose a provider: 1) Dropbox Sign  2) DocuSign  3) SignWell");
  let provider: SignProvider | null = null;
  while (!provider) {
    const answer = (await io.prompt("Provider [1-3]: ")).toLowerCase();
    if (["1", "dropbox", "dropbox-sign"].includes(answer)) provider = "dropbox";
    else if (["2", "docusign"].includes(answer)) provider = "docusign";
    else if (["3", "signwell"].includes(answer)) provider = "signwell";
    else io.log(`Unrecognized choice: ${answer}.`);
  }

  const values: Record<string, string> = { SIGN_PROVIDER: provider, SIGN_DB_PATH: "./data/sign.db" };
  for (const field of PROVIDER_FIELDS[provider]) {
    const suffix = field.default ? ` [${field.default}]` : "";
    const note = field.secret ? " (will not echo to .env in plaintext on disk; treat as secret)" : "";
    const answer = await io.prompt(`${field.description}${suffix}: `);
    values[field.key] = answer.length > 0 ? answer : (field.default ?? "");
    if (note) io.log(note);
  }
  return { provider, values };
}

export type WizardWriteResult = {
  envPath: string;
  written: number;
  preserved: number;
};

export function writeEnvFile(answers: InitAnswers, options: { path?: string } = {}): WizardWriteResult {
  const envPath = path.resolve(options.path ?? ".env");
  const existing: Record<string, string> = {};
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      existing[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
  }
  let written = 0;
  let preserved = 0;
  for (const [key, value] of Object.entries(answers.values)) {
    if (value === "") {
      if (existing[key] === undefined) existing[key] = "";
      else preserved += 1;
      continue;
    }
    existing[key] = value;
    written += 1;
  }
  const lines = Object.entries(existing).map(([key, value]) => `${key}=${value}`);
  writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
  return { envPath, written, preserved };
}
