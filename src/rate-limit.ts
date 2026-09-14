// Self-harnessing rate limiter for OpenEvidence.
//
// OpenEvidence's cookie-based web API does not document a public
// X-RateLimit-* contract, so this module defends on three fronts:
//
//   1. Sliding-window self-throttle  -> never burst above configured RPM.
//   2. Priority queue                -> stat > urgent > routine > research.
//   3. Backoff on 429 / 5xx          -> exponential with jitter, honors Retry-After.
//
// Header parsing is opportunistic: if the server happens to surface
// X-RateLimit-* or Retry-After we believe it, otherwise we rely on our
// own client-side counters.
//
// All time / sleep is injectable so the tests run in milliseconds.

export type ClinicalPriority = "stat" | "urgent" | "routine" | "research";

export const PRIORITY_ORDER: ClinicalPriority[] = ["stat", "urgent", "routine", "research"];

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequestsPerWindow: number;
  burstCap: number;
  targetUsagePercent: number;
  maxConcurrent: number;
  retry: RetryConfig;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxRequestsPerWindow: 60,
  burstCap: 6,
  targetUsagePercent: 80,
  maxConcurrent: 4,
  retry: {
    maxRetries: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterMs: 500,
  },
};

export interface RateLimitMetrics {
  requestsInWindow: number;
  usagePercent: number;
  headroom: number;
  active: number;
  queued: Record<ClinicalPriority, number>;
  serverRemaining: number | null;
  serverResetAt: string | null;
  retryAfterUntil: string | null;
}

export interface RateLimitError extends Error {
  status?: number;
  retryAfterMs?: number;
  headers?: HeaderLike;
}

export type HeaderLike = Headers | Record<string, string | string[] | undefined>;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

function headerGet(headers: HeaderLike | undefined, key: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get(key);
  }
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (Array.isArray(v)) return v[0] ?? null;
    return v ?? null;
  }
  return null;
}

function parsePositiveInt(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

interface QueueEntry {
  resolve: () => void;
}

export class RateLimitController {
  private requestTimes: number[] = [];
  private active = 0;
  private readonly queues: Record<ClinicalPriority, QueueEntry[]> = {
    stat: [],
    urgent: [],
    routine: [],
    research: [],
  };

  private serverRemaining: number | null = null;
  private serverResetMs: number | null = null;
  private retryAfterUntilMs: number | null = null;

  constructor(
    public readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /**
   * Reserve a slot before issuing a request. Resolves when it is safe to
   * proceed. Always pair with {@link release} in a finally block.
   *
   * Slot ownership rule: this.active represents claimed concurrency slots.
   * tryClaimConcurrency atomically increments it, and release() hands the
   * slot off to the next priority waiter rather than free-then-reacquire.
   */
  async acquire(priority: ClinicalPriority = "routine"): Promise<void> {
    if (!this.tryClaimConcurrency(priority)) {
      await new Promise<void>((resolve) => {
        this.queues[priority].push({ resolve });
      });
      // Slot already claimed for us by release().
    }
    while (true) {
      const wait = this.computeWaitMs();
      if (wait <= 0) break;
      await this.clock.sleep(wait);
    }
    this.requestTimes.push(this.clock.now());
  }

  release(): void {
    for (const p of PRIORITY_ORDER) {
      const queue = this.queues[p];
      if (queue.length > 0) {
        const entry = queue.shift()!;
        entry.resolve();
        return;
      }
    }
    if (this.active > 0) this.active -= 1;
  }

  /**
   * Inspect a fetch Response (or anything header-shaped) and update
   * server-reported limits. Safe to call with missing headers.
   */
  observe(input: { status?: number; headers?: HeaderLike } | undefined): void {
    if (!input) return;
    const now = this.clock.now();
    const headers = input.headers;

    const remaining = parsePositiveInt(headerGet(headers, "x-ratelimit-remaining"));
    if (remaining !== null) this.serverRemaining = remaining;

    const reset = parsePositiveInt(headerGet(headers, "x-ratelimit-reset"));
    if (reset !== null) {
      // Header may be unix seconds or seconds-from-now; treat values < 10y as relative.
      this.serverResetMs = reset < 10 * 365 * 24 * 3600 ? now + reset * 1000 : reset * 1000;
    }

    const retryAfter = parseRetryAfterMs(headerGet(headers, "retry-after"), now);
    if (retryAfter !== null) {
      this.retryAfterUntilMs = now + retryAfter;
    } else if (input.status === 429) {
      // 429 with no Retry-After: back off conservatively (base * 2).
      const fallback = this.config.retry.baseDelayMs * 2;
      this.retryAfterUntilMs = Math.max(this.retryAfterUntilMs ?? 0, now + fallback);
    }
  }

  getMetrics(): RateLimitMetrics {
    this.purgeWindow();
    const queued: Record<ClinicalPriority, number> = {
      stat: this.queues.stat.length,
      urgent: this.queues.urgent.length,
      routine: this.queues.routine.length,
      research: this.queues.research.length,
    };
    return {
      requestsInWindow: this.requestTimes.length,
      usagePercent: (this.requestTimes.length / this.config.maxRequestsPerWindow) * 100,
      headroom: Math.max(0, this.config.maxRequestsPerWindow - this.requestTimes.length),
      active: this.active,
      queued,
      serverRemaining: this.serverRemaining,
      serverResetAt: this.serverResetMs ? new Date(this.serverResetMs).toISOString() : null,
      retryAfterUntil: this.retryAfterUntilMs
        ? new Date(this.retryAfterUntilMs).toISOString()
        : null,
    };
  }

  private tryClaimConcurrency(priority: ClinicalPriority): boolean {
    for (const p of PRIORITY_ORDER) {
      if (p === priority) break;
      if (this.queues[p].length > 0) return false;
    }
    if (this.active >= this.config.maxConcurrent) return false;
    this.active += 1;
    return true;
  }

  private computeWaitMs(): number {
    const now = this.clock.now();
    let wait = 0;

    if (this.retryAfterUntilMs && this.retryAfterUntilMs > now) {
      wait = Math.max(wait, this.retryAfterUntilMs - now);
    }

    // Server says zero remaining? Wait until reset.
    if (this.serverRemaining !== null && this.serverRemaining <= 0 && this.serverResetMs) {
      wait = Math.max(wait, this.serverResetMs - now);
    }

    this.purgeWindow();

    // Hard burst cap (per ~1s slice).
    const burstWindowMs = 1000;
    const burst = this.requestTimes.filter((t) => t > now - burstWindowMs).length;
    if (burst >= this.config.burstCap) {
      const oldest = Math.min(...this.requestTimes.filter((t) => t > now - burstWindowMs));
      wait = Math.max(wait, oldest + burstWindowMs - now);
    }

    // Soft sliding-window cap at target usage.
    const softCap = Math.max(
      1,
      Math.floor((this.config.maxRequestsPerWindow * this.config.targetUsagePercent) / 100),
    );
    if (this.requestTimes.length >= softCap) {
      const oldest = this.requestTimes[0];
      wait = Math.max(wait, oldest + this.config.windowMs - now);
    }

    return Math.max(0, wait);
  }

  private purgeWindow(): void {
    const cutoff = this.clock.now() - this.config.windowMs;
    while (this.requestTimes.length > 0 && this.requestTimes[0] <= cutoff) {
      this.requestTimes.shift();
    }
  }
}

export class HttpError extends Error implements RateLimitError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
    public readonly headers?: HeaderLike,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

export interface BackoffSink {
  /** Called before a retry sleep with diagnostic info. Optional. */
  onRetry?(info: { attempt: number; delayMs: number; status?: number; reason: string }): void;
}

export async function withExponentialBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig = DEFAULT_RATE_LIMIT_CONFIG.retry,
  clock: Clock = SYSTEM_CLOCK,
  sink: BackoffSink = {},
  shouldRetry?: (error: unknown) => boolean,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const status = (error as RateLimitError | undefined)?.status;
      const retryable = shouldRetry
        ? shouldRetry(error)
        : status === undefined || isRetryableStatus(status);
      if (!retryable || attempt === config.maxRetries) {
        throw error;
      }

      const retryAfterMs = (error as RateLimitError | undefined)?.retryAfterMs;
      const delay = computeBackoffDelay(attempt, config, retryAfterMs);
      sink.onRetry?.({
        attempt: attempt + 1,
        delayMs: delay,
        status,
        reason: retryAfterMs !== undefined ? "retry-after" : "exponential",
      });
      await clock.sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("withExponentialBackoff exhausted");
}

export function computeBackoffDelay(
  attempt: number,
  config: RetryConfig,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, config.maxDelayMs);
  }
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = random() * config.jitterMs;
  return Math.min(exponential + jitter, config.maxDelayMs);
}
