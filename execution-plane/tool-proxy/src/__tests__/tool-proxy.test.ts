import { scanForPII, RateLimiter } from "../index";

describe("Tool Proxy - Rate Limiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter.dispose();
  });

  it("should allow requests under the limit", () => {
    limiter = new RateLimiter(3, 60_000);
    expect(limiter.check("agent-1").allowed).toBe(true);
    expect(limiter.check("agent-1").allowed).toBe(true);
    expect(limiter.check("agent-1").allowed).toBe(true);
  });

  it("should block requests over the limit", () => {
    limiter = new RateLimiter(2, 60_000);
    expect(limiter.check("agent-1").allowed).toBe(true);
    expect(limiter.check("agent-1").allowed).toBe(true);
    const r = limiter.check("agent-1");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("should use independent buckets for different agents", () => {
    limiter = new RateLimiter(1, 60_000);
    expect(limiter.check("agent-a").allowed).toBe(true);
    expect(limiter.check("agent-a").allowed).toBe(false);
    expect(limiter.check("agent-b").allowed).toBe(true);
    expect(limiter.check("agent-b").allowed).toBe(false);
  });

  it("should compute retryAfterMs based on oldest timestamp", () => {
    limiter = new RateLimiter(1, 1000);
    expect(limiter.check("agent-1").allowed).toBe(true);
    const r = limiter.check("agent-1");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("should allow requests after the window expires", async () => {
    limiter = new RateLimiter(1, 50);
    expect(limiter.check("agent-1").allowed).toBe(true);
    expect(limiter.check("agent-1").allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(limiter.check("agent-1").allowed).toBe(true);
  });
});

describe("Tool Proxy - PII Detection", () => {
  describe("scanForPII", () => {
    it("should detect valid SSN format", () => {
      expect(scanForPII({ text: "My SSN is 123-45-6789" })).toBe(true);
    });

    it("should detect SSN without dashes", () => {
      expect(scanForPII({ text: "SSN: 123456789" })).toBe(true);
    });

    it("should detect email addresses", () => {
      expect(scanForPII({ user: "john.doe@example.com" })).toBe(true);
    });

    it("should detect email with subdomain", () => {
      expect(scanForPII({ contact: "user@mail.co.uk" })).toBe(true);
    });

    it("should not flag non-PII text", () => {
      expect(scanForPII({ message: "Hello, how are you?" })).toBe(false);
    });

    it("should not flag numeric IDs that are not SSNs", () => {
      expect(scanForPII({ id: "123" })).toBe(false);
    });

    it("should detect PII in nested objects", () => {
      expect(scanForPII({ user: { email: "test@test.com", name: "John" } })).toBe(true);
    });

    it("should not flag empty data", () => {
      expect(scanForPII({})).toBe(false);
    });

    it("should detect multiple PII types in same payload", () => {
      expect(scanForPII({ ssn: "123-45-6789", email: "a@b.com" })).toBe(true);
    });
  });
});
