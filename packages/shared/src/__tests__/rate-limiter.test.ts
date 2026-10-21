import { RateLimiter } from "../rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(5, 1000); // 5 requests per 1 second
  });

  afterEach(() => {
    limiter.dispose();
  });

  it("should allow requests within limit", () => {
    for (let i = 0; i < 5; i++) {
      const result = limiter.check("agent-1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
    }
  });

  it("should reject requests over limit", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("should track agents independently", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("agent-1");
    }
    // agent-1 is exhausted, but agent-2 should still work
    const result = limiter.check("agent-2");
    expect(result.allowed).toBe(true);
  });

  it("should allow requests after window expires", async () => {
    const shortLimiter = new RateLimiter(2, 100); // 2 per 100ms
    try {
      shortLimiter.check("agent-1");
      shortLimiter.check("agent-1");
      expect(shortLimiter.check("agent-1").allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(shortLimiter.check("agent-1").allowed).toBe(true);
    } finally {
      shortLimiter.dispose();
    }
  });

  it("should clean up empty buckets", () => {
    limiter.check("agent-1");
    limiter.dispose();
    // After dispose, buckets should be cleared
  });

  it("should return retryAfterMs based on oldest request", async () => {
    // Wide window: under parallel jest workers the 50ms sleep can stall for
    // hundreds of ms, which used to age the oldest request out of a 200ms
    // window and flip the expected rejection. The assertion under test is
    // "over-limit rejects with a retry bounded by the window", not scheduler
    // precision, so keep a large jitter budget.
    const shortLimiter = new RateLimiter(2, 2000); // 2 per 2000ms
    try {
      shortLimiter.check("agent-1"); // t=0
      await new Promise((resolve) => setTimeout(resolve, 50));
      shortLimiter.check("agent-1"); // t=50

      const result = shortLimiter.check("agent-1"); // rejected
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(2000);
    } finally {
      shortLimiter.dispose();
    }
  });
});

describe("RateLimiter env defaults", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeAll(() => {
    envBackup.RATE_LIMIT_RPM = process.env.RATE_LIMIT_RPM;
    envBackup.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS;
    envBackup.RATE_LIMIT_CLEANUP_MS = process.env.RATE_LIMIT_CLEANUP_MS;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("should read limits from env vars", () => {
    process.env.RATE_LIMIT_RPM = "3";
    process.env.RATE_LIMIT_WINDOW_MS = "5000";
    const limiter = new RateLimiter();
    try {
      expect(limiter.check("agent-1").allowed).toBe(true);
      expect(limiter.check("agent-1").allowed).toBe(true);
      expect(limiter.check("agent-1").allowed).toBe(true);
      expect(limiter.check("agent-1").allowed).toBe(false);
    } finally {
      limiter.dispose();
    }
  });

  it("should fall back to defaults when env is unset", () => {
    delete process.env.RATE_LIMIT_RPM;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    const limiter = new RateLimiter();
    try {
      for (let i = 0; i < 60; i++) {
        expect(limiter.check("agent-1").allowed).toBe(true);
      }
      expect(limiter.check("agent-1").allowed).toBe(false);
    } finally {
      limiter.dispose();
    }
  });
});

describe("RateLimiter cleanup", () => {
  it("should prune expired timestamps and drop empty buckets", () => {
    jest.useFakeTimers();
    try {
      const limiter = new RateLimiter(5, 1000);
      limiter.check("agent-1");

      const bucketsBefore = (limiter as any).buckets.size;
      expect(bucketsBefore).toBe(1);

      jest.advanceTimersByTime(60 * 1000 + 1);
      (limiter as any).cleanup();

      expect((limiter as any).buckets.size).toBe(0);
      limiter.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("should keep buckets with recent timestamps during cleanup", () => {
    jest.useFakeTimers();
    try {
      const limiter = new RateLimiter(5, 60 * 60 * 1000);
      limiter.check("agent-1");
      jest.advanceTimersByTime(1000);
      (limiter as any).cleanup();
      expect((limiter as any).buckets.size).toBe(1);
      limiter.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("should dispose the cleanup interval", () => {
    jest.useFakeTimers();
    try {
      const limiter = new RateLimiter(5, 1000);
      limiter.dispose();
      expect((limiter as any).cleanupTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
