import test from "node:test";
import assert from "node:assert/strict";

import {
  HttpError,
  RateLimitController,
  computeBackoffDelay,
  parseRetryAfterMs,
  withExponentialBackoff,
  type Clock,
  type RateLimitConfig,
} from "../src/rate-limit.js";

function fakeClock(start = 1_700_000_000_000): Clock & { advance: (ms: number) => void; current: () => number } {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += Math.max(0, ms);
    },
    advance: (ms: number) => {
      now += ms;
    },
    current: () => now,
  };
}

function cfg(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    windowMs: 1000,
    maxRequestsPerWindow: 10,
    burstCap: 3,
    targetUsagePercent: 80,
    maxConcurrent: 2,
    retry: {
      maxRetries: 4,
      baseDelayMs: 10,
      maxDelayMs: 200,
      jitterMs: 0,
    },
    ...overrides,
  };
}

test("computeBackoffDelay: exponential growth with no jitter", () => {
  const config = cfg().retry;
  const deterministicRandom = () => 0;
  assert.equal(computeBackoffDelay(0, config, undefined, deterministicRandom), 10);
  assert.equal(computeBackoffDelay(1, config, undefined, deterministicRandom), 20);
  assert.equal(computeBackoffDelay(2, config, undefined, deterministicRandom), 40);
  assert.equal(computeBackoffDelay(3, config, undefined, deterministicRandom), 80);
  // Clamps to maxDelayMs (200).
  assert.equal(computeBackoffDelay(10, config, undefined, deterministicRandom), 200);
});

test("computeBackoffDelay: jitter stays within [base*2^a, base*2^a+jitter]", () => {
  const config = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10_000, jitterMs: 500 };
  for (let attempt = 0; attempt < 5; attempt++) {
    const low = config.baseDelayMs * Math.pow(2, attempt);
    const high = low + config.jitterMs;
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = computeBackoffDelay(attempt, config, undefined, () => r);
      assert.ok(delay >= low, `attempt=${attempt} r=${r} delay=${delay} < low=${low}`);
      assert.ok(delay <= high, `attempt=${attempt} r=${r} delay=${delay} > high=${high}`);
    }
  }
});

test("computeBackoffDelay: Retry-After overrides exponential", () => {
  const config = cfg().retry;
  assert.equal(computeBackoffDelay(5, config, 50), 50);
  // Retry-After clamps to maxDelayMs.
  assert.equal(computeBackoffDelay(0, config, 999_999), config.maxDelayMs);
});

test("parseRetryAfterMs: seconds form", () => {
  assert.equal(parseRetryAfterMs("30", 1000), 30_000);
  assert.equal(parseRetryAfterMs("0.5", 1000), 500);
});

test("parseRetryAfterMs: HTTP-date form", () => {
  const now = Date.parse("2024-01-01T00:00:00Z");
  const tenSecondsLater = new Date(now + 10_000).toUTCString();
  const result = parseRetryAfterMs(tenSecondsLater, now);
  assert.ok(result !== null && Math.abs(result - 10_000) < 1000);
});

test("parseRetryAfterMs: missing / garbage returns null", () => {
  assert.equal(parseRetryAfterMs(null, 1000), null);
  assert.equal(parseRetryAfterMs("not-a-date", 1000), null);
});

test("withExponentialBackoff: retries on 429 then succeeds", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const result = await withExponentialBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new HttpError("429", 429, 5);
      }
      return "ok";
    },
    cfg().retry,
    clock,
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("withExponentialBackoff: surfaces non-retryable 4xx immediately", async () => {
  const clock = fakeClock();
  let attempts = 0;
  await assert.rejects(
    () =>
      withExponentialBackoff(
        async () => {
          attempts += 1;
          throw new HttpError("403", 403);
        },
        cfg().retry,
        clock,
      ),
    /403/,
  );
  assert.equal(attempts, 1);
});

test("withExponentialBackoff: caller can forbid replay of an ambiguous write", async () => {
  const clock = fakeClock();
  let attempts = 0;
  await assert.rejects(
    () =>
      withExponentialBackoff(
        async () => {
          attempts += 1;
          throw new Error("connection reset after write");
        },
        cfg().retry,
        clock,
        {},
        () => false,
      ),
    /connection reset/,
  );
  assert.equal(attempts, 1);
});

test("withExponentialBackoff: honors Retry-After hint over exponential", async () => {
  const clock = fakeClock();
  const sink = { delays: [] as number[] };
  let attempts = 0;
  await assert.rejects(() =>
    withExponentialBackoff(
      async () => {
        attempts += 1;
        throw new HttpError("429", 429, 75);
      },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 9999, jitterMs: 0 },
      clock,
      { onRetry: (info) => sink.delays.push(info.delayMs) },
    ),
  );
  assert.equal(attempts, 3); // 1 + 2 retries
  assert.deepEqual(sink.delays, [75, 75]);
});

test("withExponentialBackoff: gives up after maxRetries", async () => {
  const clock = fakeClock();
  let attempts = 0;
  await assert.rejects(() =>
    withExponentialBackoff(
      async () => {
        attempts += 1;
        throw new HttpError("503", 503);
      },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterMs: 0 },
      clock,
    ),
  );
  assert.equal(attempts, 3); // 1 initial + 2 retries
});

test("RateLimitController: under burst cap admits immediately", async () => {
  const clock = fakeClock();
  const ctl = new RateLimitController(cfg({ burstCap: 5, maxConcurrent: 5 }), clock);
  const start = clock.current();
  for (let i = 0; i < 3; i++) {
    await ctl.acquire();
    ctl.release();
  }
  assert.equal(clock.current(), start);
});

test("RateLimitController: burst cap delays the 4th request inside 1s", async () => {
  const clock = fakeClock();
  const ctl = new RateLimitController(
    cfg({ burstCap: 3, maxConcurrent: 5, maxRequestsPerWindow: 100, targetUsagePercent: 100 }),
    clock,
  );
  const start = clock.current();
  for (let i = 0; i < 3; i++) {
    await ctl.acquire();
    ctl.release();
  }
  assert.equal(clock.current(), start);
  await ctl.acquire();
  ctl.release();
  // Must have slept until oldest burst entry exits the 1s window.
  assert.ok(clock.current() >= start + 1000, `expected >= ${start + 1000}, got ${clock.current()}`);
});

test("RateLimitController: sliding window soft cap at target usage", async () => {
  const clock = fakeClock();
  // window=1000ms, max=10, target=50% => soft cap of 5 per second.
  const ctl = new RateLimitController(
    cfg({ burstCap: 100, maxConcurrent: 100, maxRequestsPerWindow: 10, targetUsagePercent: 50 }),
    clock,
  );
  const start = clock.current();
  for (let i = 0; i < 5; i++) {
    await ctl.acquire();
    ctl.release();
  }
  assert.equal(clock.current(), start);
  await ctl.acquire();
  ctl.release();
  // Slept until the oldest of the 5 falls out of the window.
  assert.ok(clock.current() >= start + 1000);
});

test("RateLimitController: maxConcurrent + priority ordering", async () => {
  const clock = fakeClock();
  const ctl = new RateLimitController(
    cfg({ burstCap: 100, maxConcurrent: 1, maxRequestsPerWindow: 100, targetUsagePercent: 100 }),
    clock,
  );
  // First call holds the only slot.
  await ctl.acquire("routine");
  const events: string[] = [];

  const routinePromise = ctl.acquire("routine").then(() => events.push("routine"));
  const statPromise = ctl.acquire("stat").then(() => events.push("stat"));
  const urgentPromise = ctl.acquire("urgent").then(() => events.push("urgent"));

  // Yield so the queued acquires actually enqueue before we release.
  await new Promise((r) => setImmediate(r));

  ctl.release();
  await Promise.resolve();
  ctl.release();
  await Promise.resolve();
  ctl.release();
  await Promise.resolve();

  await Promise.all([routinePromise, statPromise, urgentPromise]);
  ctl.release();

  assert.deepEqual(events, ["stat", "urgent", "routine"]);
});

test("RateLimitController.observe: Retry-After header blocks acquire", async () => {
  const clock = fakeClock();
  const ctl = new RateLimitController(cfg(), clock);
  ctl.observe({
    status: 429,
    headers: new Headers({ "retry-after": "2" }),
  });
  const before = clock.current();
  await ctl.acquire();
  assert.ok(clock.current() >= before + 2000);
  ctl.release();
});

test("RateLimitController.observe: 429 with no Retry-After backs off conservatively", async () => {
  const clock = fakeClock();
  const ctl = new RateLimitController(
    cfg({ retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 1000, jitterMs: 0 } }),
    clock,
  );
  ctl.observe({ status: 429, headers: new Headers() });
  const before = clock.current();
  await ctl.acquire();
  assert.ok(clock.current() >= before + 100); // base * 2
  ctl.release();
});

test("RateLimitController.observe: x-ratelimit-remaining=0 waits for reset", async () => {
  const clock = fakeClock();
  const ctl = new RateLimitController(cfg(), clock);
  ctl.observe({
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3" },
  });
  const before = clock.current();
  await ctl.acquire();
  assert.ok(clock.current() >= before + 3000);
  ctl.release();
});

test("RateLimitController.getMetrics: reports queue + window state", async () => {
  const clock = fakeClock();
  const ctl = new RateLimitController(
    cfg({ burstCap: 100, maxConcurrent: 100, maxRequestsPerWindow: 10, targetUsagePercent: 100 }),
    clock,
  );
  await ctl.acquire();
  await ctl.acquire();
  const m = ctl.getMetrics();
  assert.equal(m.requestsInWindow, 2);
  assert.equal(m.active, 2);
  assert.equal(m.headroom, 8);
  assert.equal(m.queued.stat, 0);
  ctl.release();
  ctl.release();
});

test("integration: self-harness never exceeds RPM under burst", async () => {
  // Hammer the limiter with 50 acquires under a 10 RPM / 1s window cap.
  // After completion, every 1-second window must contain <= 10 requests.
  const clock = fakeClock();
  const ctl = new RateLimitController(
    cfg({
      windowMs: 1000,
      maxRequestsPerWindow: 10,
      targetUsagePercent: 100,
      burstCap: 5,
      maxConcurrent: 4,
    }),
    clock,
  );
  const timestamps: number[] = [];
  await Promise.all(
    Array.from({ length: 50 }, () =>
      (async () => {
        await ctl.acquire();
        timestamps.push(clock.current());
        ctl.release();
      })(),
    ),
  );
  timestamps.sort((a, b) => a - b);
  // Slide a 1s window across the timeline; assert <= 10 in any window.
  for (let i = 0; i < timestamps.length; i++) {
    const windowStart = timestamps[i];
    const windowEnd = windowStart + 1000;
    const count = timestamps.filter((t) => t >= windowStart && t < windowEnd).length;
    assert.ok(
      count <= 10,
      `window [${windowStart}, ${windowEnd}) contains ${count} requests (> 10)`,
    );
  }
});
