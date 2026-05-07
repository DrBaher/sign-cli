export type RetryFetchOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  retryOnStatuses?: number[];
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  shouldRetry?: (response: Response | null, attempt: number, error: unknown) => boolean;
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
      if (response) return response;
      throw lastError ?? new Error("retryFetch failed without a response.");
    }

    const retryAfterMs = response ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const backoffMs = baseDelayMs * Math.pow(2, attempt);
    const delayMs = retryAfterMs ?? backoffMs;
    await sleep(delayMs);
    attempt += 1;
  }
}
