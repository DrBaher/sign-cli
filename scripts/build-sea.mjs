import { copyFile, chmod, mkdir, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { inject } from "postject";
import { readFile } from "node:fs/promises";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const bundlePath = path.join(distDir, "cli.bundled.cjs");
const blobPath = path.join(distDir, "sign.blob");

const platform = os.platform();
const arch = os.arch();
const binarySuffix = platform === "win32" ? ".exe" : "";
const binaryName = `sign-${platform}-${arch}${binarySuffix}`;
const outputPath = path.join(distDir, binaryName);

await mkdir(distDir, { recursive: true });

try {
  await stat(bundlePath);
} catch {
  console.error("dist/cli.bundled.cjs is missing. Run `npm run bundle` first.");
  process.exit(1);
}

console.log(`Generating SEA blob via Node ${process.version}...`);
execFileSync(process.execPath, [
  "--experimental-sea-config",
  "scripts/sea.config.json",
], { stdio: "inherit" });

console.log(`Copying ${process.execPath} -> ${outputPath}`);
await copyFile(process.execPath, outputPath);
await chmod(outputPath, 0o755);

// macOS: the copied node binary carries Apple's code signature, which postject
// injection invalidates — the OS then SIGKILLs the result ("code object is not
// signed"). Strip the signature before injecting and re-sign ad-hoc after, per
// the Node SEA docs. codesign is part of the Xcode CLT, present on GitHub's
// macos runners.
if (platform === "darwin") {
  console.log("Removing inherited code signature (macOS)...");
  execFileSync("codesign", ["--remove-signature", outputPath], { stdio: "inherit" });
}

console.log("Injecting bundle into binary via postject...");
const blob = await readFile(blobPath);
await inject(outputPath, "NODE_SEA_BLOB", blob, {
  // Node's SEA binary embeds the fuse as NODE_SEA_FUSE_<hash>; postject otherwise
  // defaults to its own POSTJECT_SENTINEL_<hash>, which isn't in the Node binary
  // (the cause of "Could not find the sentinel ..."). The hash is constant across
  // Node releases. See nodejs.org/api/single-executable-applications.
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  machoSegmentName: platform === "darwin" ? "NODE_SEA" : undefined,
});

if (platform === "darwin") {
  console.log("Ad-hoc re-signing the binary (macOS)...");
  execFileSync("codesign", ["--sign", "-", outputPath], { stdio: "inherit" });
}

const finalStat = await stat(outputPath);
const sizeMb = (finalStat.size / (1024 * 1024)).toFixed(1);
console.log(`✓ Built ${path.relative(rootDir, outputPath)} (${sizeMb} MiB)`);
