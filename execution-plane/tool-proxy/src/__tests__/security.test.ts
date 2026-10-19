import {
  isPrivateOrInternalIP,
  isBlockedURL,
  isAllowedWebFetchHost,
  isAllowedSandboxIP,
  validateSandboxArgs,
  detectedPIIPatterns,
  injectCredentials,
  fetchWithRetry,
} from "../index";

describe("Tool Proxy - SSRF Protection", () => {
  describe("isAllowedSandboxIP", () => {
    afterEach(() => {
      delete process.env.SANDBOX_IP_ALLOWLIST_CIDRS;
    });

    it("allows RFC1918 sandbox IPs by default", () => {
      expect(isAllowedSandboxIP("10.0.0.1")).toBe(true);
      expect(isAllowedSandboxIP("172.30.0.5")).toBe(true);
      expect(isAllowedSandboxIP("192.168.1.1")).toBe(true);
    });

    it("always denies loopback, link-local, CGNAT, and reserved ranges", () => {
      expect(isAllowedSandboxIP("127.0.0.1")).toBe(false);
      expect(isAllowedSandboxIP("169.254.169.254")).toBe(false);
      expect(isAllowedSandboxIP("100.64.0.1")).toBe(false);
      expect(isAllowedSandboxIP("0.0.0.0")).toBe(false);
      expect(isAllowedSandboxIP("224.0.0.1")).toBe(false);
    });

    it("denies hostnames and non-IPv4 values", () => {
      expect(isAllowedSandboxIP("evil.example.com")).toBe(false);
      expect(isAllowedSandboxIP("[::1]")).toBe(false);
      expect(isAllowedSandboxIP("::1")).toBe(false);
      expect(isAllowedSandboxIP("")).toBe(false);
      expect(isAllowedSandboxIP("999.1.1.1")).toBe(false);
      expect(isAllowedSandboxIP("010.0.0.1")).toBe(false);
    });

    it("denies public IPs", () => {
      expect(isAllowedSandboxIP("8.8.8.8")).toBe(false);
      expect(isAllowedSandboxIP("1.1.1.1")).toBe(false);
    });

    it("restricts to the configured allowlist CIDRs", () => {
      process.env.SANDBOX_IP_ALLOWLIST_CIDRS = "172.30.0.0/16";
      expect(isAllowedSandboxIP("172.30.0.5")).toBe(true);
      expect(isAllowedSandboxIP("10.0.0.5")).toBe(false);
      expect(isAllowedSandboxIP("192.168.1.5")).toBe(false);
    });

    it("deny-list wins even when allowlist overlaps", () => {
      process.env.SANDBOX_IP_ALLOWLIST_CIDRS = "127.0.0.0/8,169.254.0.0/16";
      expect(isAllowedSandboxIP("127.0.0.1")).toBe(false);
      expect(isAllowedSandboxIP("169.254.169.254")).toBe(false);
    });

    it("empty allowlist string denies everything (fail-closed)", () => {
      process.env.SANDBOX_IP_ALLOWLIST_CIDRS = "  ";
      expect(isAllowedSandboxIP("10.0.0.1")).toBe(false);
    });
  });
  describe("isPrivateOrInternalIP", () => {
    it("detects loopback", () => {
      expect(isPrivateOrInternalIP("127.0.0.1")).toBe(true);
      expect(isPrivateOrInternalIP("localhost")).toBe(true);
    });

    it("detects private ranges", () => {
      expect(isPrivateOrInternalIP("10.0.0.1")).toBe(true);
      expect(isPrivateOrInternalIP("172.16.0.1")).toBe(true);
      expect(isPrivateOrInternalIP("172.31.255.255")).toBe(true);
      expect(isPrivateOrInternalIP("192.168.1.1")).toBe(true);
      expect(isPrivateOrInternalIP("169.254.169.254")).toBe(true);
      expect(isPrivateOrInternalIP("100.64.0.1")).toBe(true);
    });

    it("does not flag public IPs", () => {
      expect(isPrivateOrInternalIP("8.8.8.8")).toBe(false);
      expect(isPrivateOrInternalIP("1.1.1.1")).toBe(false);
    });

    it("flags IPv6 link-local", () => {
      expect(isPrivateOrInternalIP("[::1]")).toBe(true);
    });
  });

  describe("isBlockedURL", () => {
    it("allows https public URLs", () => {
      expect(isBlockedURL("https://example.com")).toBe(false);
      expect(isBlockedURL("https://r.jina.ai/http://public.example.com")).toBe(false);
    });

    it("blocks private IP hosts", () => {
      expect(isBlockedURL("http://10.0.0.1/")).toBe(true);
      expect(isBlockedURL("http://169.254.169.254/latest/meta-data/")).toBe(true);
      expect(isBlockedURL("http://127.0.0.1:8080/")).toBe(true);
    });

    it("blocks non-http protocols", () => {
      expect(isBlockedURL("file:///etc/passwd")).toBe(true);
      expect(isBlockedURL("ftp://example.com")).toBe(true);
      expect(isBlockedURL("gopher://example.com")).toBe(true);
    });

    it("blocks internal hostnames", () => {
      expect(isBlockedURL("http://metadata.google.internal/")).toBe(true);
      expect(isBlockedURL("http://db.internal/")).toBe(true);
      expect(isBlockedURL("http://host.local/")).toBe(true);
    });

    it("blocks malformed URLs", () => {
      expect(isBlockedURL("not a url")).toBe(true);
      expect(isBlockedURL("")).toBe(true);
    });
  });

  describe("isAllowedWebFetchHost", () => {
    it("allows hosts in the allowlist", () => {
      expect(isAllowedWebFetchHost("https://api.openai.com/")).toBe(true);
      expect(isAllowedWebFetchHost("https://en.wikipedia.org/wiki/OpenAI")).toBe(true);
      expect(isAllowedWebFetchHost("https://api.anthropic.com/")).toBe(true);
    });

    it("rejects hosts not in the allowlist", () => {
      expect(isAllowedWebFetchHost("https://evil.example.com/")).toBe(false);
      expect(isAllowedWebFetchHost("https://example.com/")).toBe(false);
    });

    it("rejects malformed URLs", () => {
      expect(isAllowedWebFetchHost("not a url")).toBe(false);
    });
  });
});

describe("Tool Proxy - Sandbox Argument Validation", () => {
  describe("code_interpreter", () => {
    it("accepts valid code", () => {
      expect(validateSandboxArgs("code_interpreter", { code: "print('hi')" })).toBeNull();
      expect(validateSandboxArgs("code_interpreter", { script: "print('hi')" })).toBeNull();
    });

    it("rejects missing code", () => {
      expect(validateSandboxArgs("code_interpreter", {})).toBe("No code provided");
      expect(validateSandboxArgs("code_interpreter", { code: 42 })).toBe("No code provided");
    });

    it("rejects oversized code", () => {
      expect(validateSandboxArgs("code_interpreter", { code: "x".repeat(10001) })).toBe("Code exceeds 10,000 character limit");
    });
  });

  describe("file_read", () => {
    it("accepts safe paths", () => {
      expect(validateSandboxArgs("file_read", { path: "/tmp/readme.txt" })).toBeNull();
    });

    it("rejects missing path", () => {
      expect(validateSandboxArgs("file_read", {})).toBe("No path provided");
    });

    it("rejects traversal", () => {
      expect(validateSandboxArgs("file_read", { path: "/etc/passwd" })).toBeNull();
      expect(validateSandboxArgs("file_read", { path: "../secret" })).toBe("Invalid path");
      expect(validateSandboxArgs("file_read", { path: "a;rm -rf /" })).toBe("Invalid path");
    });
  });

  describe("file_write", () => {
    it("accepts safe writes", () => {
      expect(validateSandboxArgs("file_write", { path: "/tmp/out.txt", content: "hello" })).toBeNull();
    });

    it("rejects traversal", () => {
      expect(validateSandboxArgs("file_write", { path: "..\\evil", content: "x" })).toBe("Invalid path");
    });

    it("rejects oversized content", () => {
      expect(validateSandboxArgs("file_write", { path: "/tmp/out.txt", content: "x".repeat(1000001) })).toBe("Content too large");
    });
  });

  describe("database_query", () => {
    it("accepts safe queries", () => {
      expect(validateSandboxArgs("database_query", { query: "SELECT * FROM users" })).toBeNull();
    });

    it("rejects missing query", () => {
      expect(validateSandboxArgs("database_query", {})).toBe("No query provided");
    });

    it("rejects shell metacharacters", () => {
      expect(validateSandboxArgs("database_query", { query: "SELECT 1; DROP TABLE users;" })).toBe("Query contains blocked characters");
      expect(validateSandboxArgs("database_query", { query: "SELECT * FROM t WHERE x = 1 || 2" })).toBe("Query contains blocked characters");
    });
  });

  describe("unknown tools", () => {
    it("rejects unknown tools", () => {
      expect(validateSandboxArgs("unknown_tool", {})).toBe("Unknown tool: unknown_tool");
    });
  });
});

describe("Tool Proxy - PII Pattern Detection", () => {
  describe("detectedPIIPatterns", () => {
    it("returns empty for clean data", () => {
      expect(detectedPIIPatterns({ text: "hello world" })).toEqual([]);
    });

    it("identifies SSN", () => {
      expect(detectedPIIPatterns({ text: "SSN 123-45-6789" })).toContain("SSN");
    });

    it("identifies email", () => {
      expect(detectedPIIPatterns({ text: "contact me at a@b.com" })).toContain("email");
    });

    it("identifies multiple types", () => {
      const patterns = detectedPIIPatterns({ ssn: "123-45-6789", email: "a@b.com" });
      expect(patterns).toContain("SSN");
      expect(patterns).toContain("email");
    });

    it("identifies credit cards", () => {
      expect(detectedPIIPatterns({ card: "4111 1111 1111 1111" })).toContain("credit_card");
    });

    it("identifies IP addresses", () => {
      expect(detectedPIIPatterns({ ip: "203.0.113.5" })).toContain("ip_address");
    });
  });
});

describe("Tool Proxy - Credential Injection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TOOL_GOOGLE_SEARCH_API_KEY;
    delete process.env.TOOL_DEFAULT_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns empty when no key configured", () => {
    expect(injectCredentials("google_search")).toEqual({});
  });

  it("uses tool-specific key", () => {
    process.env.TOOL_GOOGLE_SEARCH_API_KEY = "secret-key";
    expect(injectCredentials("google_search")).toEqual({ Authorization: "Bearer secret-key" });
  });

  it("falls back to default key", () => {
    process.env.TOOL_DEFAULT_API_KEY = "default-key";
    expect(injectCredentials("web_fetch")).toEqual({ Authorization: "Bearer default-key" });
  });
});

describe("Tool Proxy - fetchWithRetry", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns response on first success", async () => {
    const res = new Response("ok", { status: 200 });
    fetchSpy.mockResolvedValue(res);
    expect(await fetchWithRetry("https://example.com", {}, 3)).toBe(res);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws on AbortError without retry", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchSpy.mockRejectedValue(abortErr);
    await expect(fetchWithRetry("https://example.com", {}, 3)).rejects.toThrow("aborted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries", async () => {
    const err = new Error("network down");
    fetchSpy.mockRejectedValue(err);
    await expect(fetchWithRetry("https://example.com", {}, 1)).rejects.toThrow("network down");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx then succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const res = await fetchWithRetry("https://example.com", {}, 3);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns the 5xx response once retries are exhausted", async () => {
    fetchSpy.mockResolvedValue(new Response("error", { status: 503 }));
    const res = await fetchWithRetry("https://example.com", {}, 1);
    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
