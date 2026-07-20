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
    const shortLimiter = new RateLimiter(2, 200); // 2 per 200ms
    try {
      shortLimiter.check("agent-1"); // t=0
      await new Promise((resolve) => setTimeout(resolve, 50));
      shortLimiter.check("agent-1"); // t=50

      const result = shortLimiter.check("agent-1"); // rejected
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(200);
    } finally {
      shortLimiter.dispose();
    }
  });
});
