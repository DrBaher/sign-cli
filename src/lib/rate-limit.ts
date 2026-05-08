// Token-bucket rate limiter, per-key. Used by `sign serve` to throttle the
// HTTP API per client IP. Keep the implementation tiny and deterministic so
// it can be unit-tested with an injectable clock.
//
// Each key (e.g. an IP address) gets a bucket of `capacity` tokens that
// refills at `refillPerSec` tokens/second up to `capacity`. Each request
// consumes one token; if the bucket is empty, take() returns false and the
// caller responds 429.
//
// Buckets are cleaned up after `idleEvictMs` of inactivity so a long-running
// server doesn't accumulate one bucket per attacker IP forever.

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;       // tokens remaining after this request (clamped to 0)
  retryAfterSeconds: number; // 0 when allowed; ceil seconds until 1 token is available otherwise
  capacity: number;
};

export type TokenBucketOptions = {
  capacity: number;
  refillPerSec: number;
  // Defaults to Date.now; tests override.
  now?: () => number;
  idleEvictMs?: number;
};

type Bucket = { tokens: number; lastRefillMs: number; lastSeenMs: number };

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly idleEvictMs: number;

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.capacity) || opts.capacity <= 0) {
      throw new Error("TokenBucketLimiter capacity must be a positive number.");
    }
    if (!Number.isFinite(opts.refillPerSec) || opts.refillPerSec <= 0) {
      throw new Error("TokenBucketLimiter refillPerSec must be a positive number.");
    }
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? Date.now;
    this.idleEvictMs = opts.idleEvictMs ?? 5 * 60_000;
  }

  take(key: string): RateLimitDecision {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: now, lastSeenMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedMs = now - bucket.lastRefillMs;
      if (elapsedMs > 0) {
        const refill = (elapsedMs / 1000) * this.refillPerSec;
        bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
        bucket.lastRefillMs = now;
      }
      bucket.lastSeenMs = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: 0,
        capacity: this.capacity,
      };
    }
    const deficit = 1 - bucket.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / this.refillPerSec));
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
      capacity: this.capacity,
    };
  }

  // Drop buckets that haven't been touched recently. Caller can run this on a
  // timer or on each take() call (cheaper to do it occasionally).
  evictIdle(): number {
    const cutoff = this.now() - this.idleEvictMs;
    let evicted = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeenMs < cutoff) {
        this.buckets.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  size(): number {
    return this.buckets.size;
  }
}
