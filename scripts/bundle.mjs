import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const outFile = path.join(rootDir, "dist", "cli.bundled.cjs");
await mkdir(path.dirname(outFile), { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: outFile,
  external: [
    "node:*",
    "@dropbox/sign",
  ],
  legalComments: "none",
  logLevel: "info",
});

await chmod(outFile, 0o755);
console.log(`bundle written to ${path.relative(rootDir, outFile)}`);
