import crypto from "crypto";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  deliverWebhook,
  deliverWithRetry,
  batchDeliver,
  storeDelivery,
  getDeliveryStats,
  getDeadLetters,
  type WebhookPayload,
  type WebhookDelivery,
  type WebhookConfig,
} from "../webhook/index.js";
import { getPool } from "../db.js";

jest.mock("../db.js", () => ({
  getPool: jest.fn(),
}));

const mockGetPool = getPool as jest.Mock;

const mockPayload: WebhookPayload = {
  event: "agent.created",
  timestamp: "2026-09-17T10:00:00.000Z",
  data: { agentId: "agent-1", name: "test-agent" },
  metadata: { namespace: "default" },
};

const secret = "test-webhook-secret-32chars-long!!!!";

function makeMockResponse(status: number, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

afterEach(() => {
  mockGetPool.mockReset();
});

// ─── signWebhookPayload ─────────────────────────────────────────────────────

describe("signWebhookPayload", () => {
  it("should produce a consistent hex signature for the same inputs", () => {
    const body = JSON.stringify(mockPayload);
    const s1 = signWebhookPayload(body, secret);
    const s2 = signWebhookPayload(body, secret);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should produce different signatures for different secrets", () => {
    const body = JSON.stringify(mockPayload);
    const s1 = signWebhookPayload(body, secret);
    const s2 = signWebhookPayload(body, "other-secret");
    expect(s1).not.toBe(s2);
  });

  it("should produce different signatures for different payloads", () => {
    const s1 = signWebhookPayload("payload-a", secret);
    const s2 = signWebhookPayload("payload-b", secret);
    expect(s1).not.toBe(s2);
  });
});

// ─── verifyWebhookSignature ─────────────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify(mockPayload);

  it("should accept a valid signature", () => {
    const sig = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("should reject a tampered payload", () => {
    const sig = signWebhookPayload(body, secret);
    const tampered = JSON.stringify({ ...mockPayload, event: "agent.deleted" });
    expect(verifyWebhookSignature(tampered, sig, secret)).toBe(false);
  });

  it("should reject a wrong secret", () => {
    const sig = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body, sig, "wrong-secret")).toBe(false);
  });

  it("should reject a truncated signature", () => {
    const sig = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body, sig.slice(0, 32), secret)).toBe(false);
  });
});

// ─── deliverWebhook ─────────────────────────────────────────────────────────

describe("deliverWebhook", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should send correct headers on delivery", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return makeMockResponse(200);
    }) as jest.Mock;

    const result = await deliverWebhook("https://example.com/hook", mockPayload, secret);

    expect(capturedUrl).toBe("https://example.com/hook");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Egaop-Signature"]).toBeTruthy();
    expect(headers["X-Egaop-Timestamp"]).toBe(mockPayload.timestamp);
    expect(result.status).toBe("delivered");
    expect(result.responseCode).toBe(200);
  });

  it("should handle a timeout", async () => {
    globalThis.fetch = jest.fn(() => {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("The operation was aborted")), 50);
      });
    }) as jest.Mock;

    const result = await deliverWebhook(
      "https://example.com/hook",
      mockPayload,
      secret,
      { timeoutMs: 10 },
    );

    expect(result.status).toBe("failed");
    expect(result.lastError).toBeTruthy();
  });

  it("should handle non-2xx responses", async () => {
    globalThis.fetch = jest.fn(async () => makeMockResponse(500, "Internal Server Error")) as jest.Mock;

    const result = await deliverWebhook("https://example.com/hook", mockPayload, secret);

    expect(result.status).toBe("failed");
    expect(result.responseCode).toBe(500);
    expect(result.lastError).toContain("500");
  });

  it("should use custom header names from config", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return makeMockResponse(200);
    }) as jest.Mock;

    const customConfig: Partial<WebhookConfig> = {
      signatureHeader: "X-Custom-Sig",
      timestampHeader: "X-Custom-Ts",
    };

    await deliverWebhook("https://example.com/hook", mockPayload, secret, customConfig);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-Custom-Sig"]).toBeTruthy();
    expect(headers["X-Custom-Ts"]).toBe(mockPayload.timestamp);
  });
});

// ─── deliverWithRetry ───────────────────────────────────────────────────────

describe("deliverWithRetry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should retry on 5xx with exponential backoff", async () => {
    let callCount = 0;
    globalThis.fetch = jest.fn(async () => {
      callCount++;
      if (callCount < 3) return makeMockResponse(503, "Service Unavailable");
      return makeMockResponse(200);
    }) as jest.Mock;

    const result = await deliverWithRetry(
      "https://example.com/hook",
      mockPayload,
      secret,
      { retryDelayMs: 1, maxRetries: 5 },
    );

    expect(callCount).toBe(3);
    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(3);
  });

  it("should stop after maxRetries", async () => {
    globalThis.fetch = jest.fn(async () => makeMockResponse(500, "Error")) as jest.Mock;

    const result = await deliverWithRetry(
      "https://example.com/hook",
      mockPayload,
      secret,
      { retryDelayMs: 1, maxRetries: 2 },
    );

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3); // initial + 2 retries
  });

  it("should not retry on 4xx client errors", async () => {
    let callCount = 0;
    globalThis.fetch = jest.fn(async () => {
      callCount++;
      return makeMockResponse(400, "Bad Request");
    }) as jest.Mock;

    const result = await deliverWithRetry(
      "https://example.com/hook",
      mockPayload,
      secret,
      { retryDelayMs: 1, maxRetries: 5 },
    );

    expect(callCount).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.responseCode).toBe(400);
  });

  it("should handle a successful first attempt without retries", async () => {
    let callCount = 0;
    globalThis.fetch = jest.fn(async () => {
      callCount++;
      return makeMockResponse(200);
    }) as jest.Mock;

    const result = await deliverWithRetry(
      "https://example.com/hook",
      mockPayload,
      secret,
      { retryDelayMs: 1, maxRetries: 5 },
    );

    expect(callCount).toBe(1);
    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(1);
    expect(result.deliveredAt).toBeTruthy();
  });
});

// ─── batchDeliver ───────────────────────────────────────────────────────────

describe("batchDeliver", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should deliver to all channels concurrently", async () => {
    const urls: string[] = [];
    globalThis.fetch = jest.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return makeMockResponse(200);
    }) as jest.Mock;

    const channels = [
      { url: "https://a.example.com/hook", secret: "secret-a" },
      { url: "https://b.example.com/hook", secret: "secret-b" },
      { url: "https://c.example.com/hook", secret: "secret-c" },
    ];

    const results = await batchDeliver(mockPayload, channels, { retryDelayMs: 1 });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "delivered")).toBe(true);
    expect(urls.sort()).toEqual(["https://a.example.com/hook", "https://b.example.com/hook", "https://c.example.com/hook"]);
  });

  it("should handle partial failures", async () => {
    let callCount = 0;
    globalThis.fetch = jest.fn(async () => {
      callCount++;
      if (callCount === 2) return makeMockResponse(500, "Error");
      return makeMockResponse(200);
    }) as jest.Mock;

    const channels = [
      { url: "https://a.example.com/hook", secret: "secret-a" },
      { url: "https://b.example.com/hook", secret: "secret-b" },
    ];

    const results = await batchDeliver(mockPayload, channels, { retryDelayMs: 1, maxRetries: 0 });

    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("delivered");
    expect(results[1]?.status).toBe("failed");
  });
});

// ─── storeDelivery ──────────────────────────────────────────────────────────

describe("storeDelivery", () => {
  it("should persist a delivery record to the database", async () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockGetPool.mockResolvedValue({ query: mockQuery });

    const delivery: WebhookDelivery = {
      id: "whd_test123",
      channelId: "ch-1",
      url: "https://example.com/hook",
      payload: mockPayload,
      status: "delivered",
      attempts: 1,
      maxAttempts: 5,
      nextRetryAt: null,
      lastError: null,
      responseCode: 200,
      responseTimeMs: 150,
      createdAt: "2026-09-17T10:00:00.000Z",
      deliveredAt: "2026-09-17T10:00:00.150Z",
    };

    await storeDelivery(delivery);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO webhook_deliveries");
    expect(params).toContain("whd_test123");
    expect(params).toContain("ch-1");
    expect(params).toContain("delivered");
  });
});

// ─── getDeliveryStats ───────────────────────────────────────────────────────

describe("getDeliveryStats", () => {
  it("should return correct counts per status", async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [{ delivered: "10", failed: "3", pending: "2" }],
    });
    mockGetPool.mockResolvedValue({ query: mockQuery });

    const stats = await getDeliveryStats("ch-1");

    expect(stats).toEqual({ delivered: 10, failed: 3, pending: 2 });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("channel_id = $1"),
      ["ch-1"],
    );
  });

  it("should return zeros when no records exist", async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [{ delivered: "0", failed: "0", pending: "0" }],
    });
    mockGetPool.mockResolvedValue({ query: mockQuery });

    const stats = await getDeliveryStats("ch-empty");

    expect(stats).toEqual({ delivered: 0, failed: 0, pending: 0 });
  });
});

// ─── getDeadLetters ─────────────────────────────────────────────────────────

describe("getDeadLetters", () => {
  it("should return failed deliveries for a channel", async () => {
    const mockRow = {
      id: "whd_dl1",
      channel_id: "ch-1",
      url: "https://example.com/hook",
      payload: JSON.stringify(mockPayload),
      status: "failed",
      attempts: 6,
      max_attempts: 5,
      next_retry_at: null,
      last_error: "HTTP 500: Internal Server Error",
      response_code: 500,
      response_time_ms: 200,
      created_at: "2026-09-17T10:00:00.000Z",
      delivered_at: null,
    };
    const mockQuery = jest.fn().mockResolvedValue({ rows: [mockRow] });
    mockGetPool.mockResolvedValue({ query: mockQuery });

    const letters = await getDeadLetters("ch-1");

    expect(letters).toHaveLength(1);
    expect(letters[0]?.id).toBe("whd_dl1");
    expect(letters[0]?.status).toBe("failed");
    expect(letters[0]?.lastError).toContain("500");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      ["ch-1", 50],
    );
  });

  it("should respect custom limit", async () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockGetPool.mockResolvedValue({ query: mockQuery });

    await getDeadLetters("ch-1", 10);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      ["ch-1", 10],
    );
  });
});
