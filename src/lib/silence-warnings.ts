// Node emits `ExperimentalWarning: SQLite is an experimental feature ...` (and a
// companion `--trace-warnings` hint) to stderr the first time `node:sqlite` is
// loaded. That noise corrupts otherwise machine-readable CLI output, so we filter
// out only ExperimentalWarning here — every other warning still reaches stderr.
//
// This module is intended to be imported FIRST (before any module that pulls in
// node:sqlite), since ESM evaluates imports in source order. It honors an opt-out:
// set SIGN_SHOW_WARNINGS=1 to restore Node's default behavior.
import process from "node:process";

if (process.env.SIGN_SHOW_WARNINGS !== "1") {
  const originalEmitWarning = process.emitWarning.bind(process);
  // process.emitWarning has several overloads; normalize enough to read the type.
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const options = rest[0];
    const type = typeof options === "string"
      ? options
      : (options as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning") {
      return;
    }
    return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
