export type LogMode = "human" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  mode: LogMode;
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export function resolveLogMode(flag?: string): LogMode {
  const raw = (flag ?? process.env.SIGN_LOG_FORMAT ?? "human").trim().toLowerCase();
  return raw === "json" ? "json" : "human";
}

export function createLogger(options: { mode?: LogMode; sink?: (line: string) => void } = {}): Logger {
  const mode = options.mode ?? resolveLogMode();
  const sink = options.sink ?? ((line: string) => {
    process.stderr.write(`${line}\n`);
  });

  function format(level: LogLevel, message: string, fields?: Record<string, unknown>): string {
    if (mode === "json") {
      return JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...fields,
      });
    }
    if (!fields || Object.keys(fields).length === 0) {
      return `[${level}] ${message}`;
    }
    const flat = Object.entries(fields)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    return `[${level}] ${message} ${flat}`;
  }

  function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    sink(format(level, message, fields));
  }

  return {
    mode,
    log,
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
  };
}
