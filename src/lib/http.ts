import { redactHeaders, redactString, collectKnownSecrets } from "./secret.js";

export type RetryFetchOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  retryOnStatuses?: number[];
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  shouldRetry?: (response: Response | null, attempt: number, error: unknown) => boolean;
  debugSink?: (line: string) => void;
};

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const diff = date - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

function resolveMaxRetries(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const env = process.env.SIGN_HTTP_MAX_RETRIES;
  if (env !== undefined) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return 3;
}

function resolveBaseDelay(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const env = process.env.SIGN_HTTP_BASE_DELAY_MS;
  if (env !== undefined) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return 1000;
}

function debugEnabled(): boolean {
  const flag = (process.env.SIGN_DEBUG ?? "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(flag);
}

function defaultDebugSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

function summarizeHeaders(init?: RequestInit): Record<string, string> {
  if (!init?.headers) return {};
  const raw = init.headers;
  const flat: Record<string, unknown> = {};
  if (raw instanceof Headers) {
    raw.forEach((value, key) => { flat[key] = value; });
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw) flat[key] = value;
  } else {
    Object.assign(flat, raw as Record<string, unknown>);
  }
  return redactHeaders(flat);
}

export async function retryFetch(
  url: string,
  init?: RequestInit,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const maxRetries = resolveMaxRetries(options.maxRetries);
  const baseDelayMs = resolveBaseDelay(options.baseDelayMs);
  const retryStatuses = options.retryOnStatuses ?? DEFAULT_RETRY_STATUSES;
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;
  const debug = options.debugSink ?? (debugEnabled() ? defaultDebugSink : null);
  const knownSecrets = collectKnownSecrets();

  if (debug) {
    debug(`[http] -> ${init?.method ?? "GET"} ${redactString(url, knownSecrets)} headers=${JSON.stringify(summarizeHeaders(init))}`);
  }

  let attempt = 0;
  let lastError: unknown = null;
  while (true) {
    let response: Response | null = null;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
    }

    const isRetryableStatus = response !== null && retryStatuses.includes(response.status);
    const networkFailure = response === null;
    const customRetry = options.shouldRetry?.(response, attempt, lastError);
    const shouldRetry = (customRetry ?? (networkFailure || isRetryableStatus)) && attempt < maxRetries;

    if (!shouldRetry) {
      if (response) {
        if (debug) debug(`[http] <- ${response.status} ${response.statusText} (attempt ${attempt + 1})`);
        return response;
      }
      if (debug) debug(`[http] <- network error: ${lastError instanceof Error ? lastError.message : String(lastError)} (attempt ${attempt + 1})`);
      throw lastError ?? new Error("retryFetch failed without a response.");
    }

    const retryAfterMs = response ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const backoffMs = baseDelayMs * Math.pow(2, attempt);
    const delayMs = retryAfterMs ?? backoffMs;
    if (debug) debug(`[http] retry status=${response?.status ?? "network-error"} delay=${delayMs}ms (attempt ${attempt + 1})`);
    await sleep(delayMs);
    attempt += 1;
  }
}
