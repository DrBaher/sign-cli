import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

const rootDir = process.cwd();
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");

await rm(distDir, { recursive: true, force: true });

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(fullPath);
      }
      return [fullPath];
    }),
  );
  return files.flat();
}

const files = await walk(srcDir);

for (const file of files) {
  const relativePath = path.relative(srcDir, file);
  const outputPath = path.join(
    distDir,
    relativePath.replace(/\.ts$/u, ".js"),
  );

  await mkdir(path.dirname(outputPath), { recursive: true });

  if (!file.endsWith(".ts")) {
    const raw = await readFile(file);
    await writeFile(outputPath, raw);
    continue;
  }

  const source = await readFile(file, "utf8");
  const compiled = stripTypeScriptTypes(source, {
    mode: "transform",
    sourceMap: false,
  });
  await writeFile(outputPath, compiled, "utf8");
}
