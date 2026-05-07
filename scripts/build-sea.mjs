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

console.log("Injecting bundle into binary via postject...");
const blob = await readFile(blobPath);
await inject(outputPath, "NODE_SEA_BLOB", blob, {
  sentinelFusesPath: undefined,
  machoSegmentName: platform === "darwin" ? "NODE_SEA" : undefined,
});

const finalStat = await stat(outputPath);
const sizeMb = (finalStat.size / (1024 * 1024)).toFixed(1);
console.log(`✓ Built ${path.relative(rootDir, outputPath)} (${sizeMb} MiB)`);
