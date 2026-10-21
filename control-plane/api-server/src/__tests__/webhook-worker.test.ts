// Must be set before webhook-worker is imported: it reads env at module load.
process.env.WEBHOOK_TIMEOUT_MS = "10";
process.env.LOG_LEVEL = "silent";

const mockQuery = jest.fn();
const mockPool = { query: mockQuery };

jest.mock("@e-gaop/shared", () => {
  const actual = jest.requireActual("@e-gaop/shared");
  return {
    ...actual,
    getPool: jest.fn(),
    signWebhookPayload: jest.fn(() => "test-signature"),
  };
});

import { getPool, signWebhookPayload } from "@e-gaop/shared";
import { startWebhookWorker, stopWebhookWorker } from "../webhook-worker";

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn();

function deliveryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "d-1",
    channel_id: "ch-1",
    url: "http://localhost:9999/hook",
    payload: JSON.stringify({ event: "agent.done", timestamp: "1712345678" }),
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    next_retry_at: null,
    last_error: null,
    response_code: null,
    response_time_ms: null,
    created_at: "2026-10-21T00:00:00Z",
    delivered_at: null,
    ...overrides,
  };
}

function okResponse() {
  return Promise.resolve({ ok: true, status: 200, statusText: "OK" });
}

function failResponse(status: number, statusText: string) {
  return Promise.resolve({ ok: false, status, statusText });
}

function setupQuery(webhookRows: unknown[], channelRows: unknown[] = [{ config: { secret: "s3cret" } }]) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes("FROM webhook_deliveries")) return Promise.resolve({ rows: webhookRows });
    if (sql.includes("FROM notification_channels")) return Promise.resolve({ rows: channelRows });
    return Promise.resolve({ rows: [] });
  });
}

async function waitFor(assertion: () => void, attempts = 150): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  throw lastErr;
}

function findCall(fragment: string): unknown[][] | undefined {
  const call = mockQuery.mock.calls.find((c: unknown[]) => String(c[0]).includes(fragment));
  return call as unknown[][] | undefined;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  (getPool as jest.Mock).mockReset();
  (getPool as jest.Mock).mockResolvedValue(mockPool);
  (signWebhookPayload as jest.Mock).mockReset();
  (signWebhookPayload as jest.Mock).mockReturnValue("test-signature");
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  stopWebhookWorker();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("webhook worker", () => {
  it("delivers on 2xx and marks the delivery delivered", async () => {
    setupQuery([deliveryRow()]);
    fetchMock.mockImplementation(() => okResponse());

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'delivered'")).toBeDefined());

    const update = findCall("SET status = 'delivered'")!;
    expect(update[1]).toEqual(["d-1", 200, expect.any(Number)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signWebhookPayload).toHaveBeenCalledWith(
      JSON.stringify({ event: "agent.done", timestamp: "1712345678" }),
      "s3cret",
    );
  });

  it("schedules a retry on non-2xx response", async () => {
    setupQuery([deliveryRow()]);
    fetchMock.mockImplementation(() => failResponse(500, "Server Error"));

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'retrying'")).toBeDefined());

    const params = findCall("SET status = 'retrying'")![1] as unknown[];
    expect(params[0]).toBe("d-1");
    expect(params[1]).toBe(1);
    expect(params[2]).toBe("HTTP 500: Server Error");
    expect(params[3]).toBeDefined();
  });

  it("dead-letters the delivery when max attempts is reached", async () => {
    setupQuery([deliveryRow({ attempts: 4, max_attempts: 5 })]);
    fetchMock.mockImplementation(() => failResponse(503, "Service Unavailable"));

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'failed'")).toBeDefined());

    const update = findCall("SET status = 'failed'")!;
    expect(update[1]).toEqual(["d-1", 5, "HTTP 503: Service Unavailable"]);
    expect(findCall("SET status = 'retrying'")).toBeUndefined();
  });

  it("clamps exponential backoff at 5 minutes for high attempt counts", async () => {
    setupQuery([deliveryRow({ attempts: 40, max_attempts: 50 })]);
    fetchMock.mockImplementation(() => failResponse(500, "Server Error"));

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'retrying'")).toBeDefined());

    const params = findCall("SET status = 'retrying'")![1] as unknown[];
    const nextRetryAt = new Date(params[3] as string).getTime();
    const skew = Math.abs(nextRetryAt - (Date.now() + 300000));
    expect(skew).toBeLessThan(5000);
  });

  it("records the error message when fetch rejects with an Error", async () => {
    setupQuery([deliveryRow()]);
    fetchMock.mockImplementation(() => Promise.reject(new Error("net down")));

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'retrying'")).toBeDefined());

    const params = findCall("SET status = 'retrying'")![1] as unknown[];
    expect(params[2]).toBe("net down");
  });

  it("stringifies non-Error rejections", async () => {
    setupQuery([deliveryRow()]);
    fetchMock.mockImplementation(() => Promise.reject("raw failure"));

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'retrying'")).toBeDefined());

    const params = findCall("SET status = 'retrying'")![1] as unknown[];
    expect(params[2]).toBe("raw failure");
  });

  it("signs with an empty secret when the channel has no config", async () => {
    setupQuery(
      [deliveryRow({ payload: { event: "x", timestamp: "9" } })],
      [],
    );
    fetchMock.mockImplementation(() => okResponse());

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'delivered'")).toBeDefined());

    expect(signWebhookPayload).toHaveBeenCalledWith(
      JSON.stringify({ event: "x", timestamp: "9" }),
      "",
    );
  });

  it("does nothing when there are no pending deliveries", async () => {
    setupQuery([]);

    startWebhookWorker();
    await waitFor(() => expect(mockQuery).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(findCall("SET status")).toBeUndefined();
  });

  it("logs and reschedules when the poll cycle itself errors", async () => {
    (getPool as jest.Mock).mockRejectedValue(new Error("db down"));

    startWebhookWorker();
    await waitFor(() => expect(getPool).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a second start while already running", async () => {
    setupQuery([]);
    startWebhookWorker();
    await waitFor(() => expect(mockQuery).toHaveBeenCalled());

    startWebhookWorker();
    await new Promise((r) => setTimeout(r, 30));

    expect(getPool).toHaveBeenCalledTimes(1);
  });

  it("stop without start is safe", () => {
    expect(() => stopWebhookWorker()).not.toThrow();
  });

  it("stops mid-batch and skips remaining deliveries", async () => {
    setupQuery([deliveryRow({ id: "d-1" }), deliveryRow({ id: "d-2" }), deliveryRow({ id: "d-3" })]);
    let fetchCalls = 0;
    fetchMock.mockImplementation(() => {
      fetchCalls += 1;
      if (fetchCalls === 2) stopWebhookWorker();
      return okResponse();
    });

    startWebhookWorker();
    await waitFor(() => expect(fetchCalls).toBe(2));
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(findCall("'d-3'")).toBeUndefined();
  });

  it("aborts deliveries that outlive the request timeout", async () => {
    setupQuery([deliveryRow()]);
    fetchMock.mockImplementation(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    startWebhookWorker();
    await waitFor(() => expect(findCall("SET status = 'retrying'")).toBeDefined());

    const params = findCall("SET status = 'retrying'")![1] as unknown[];
    expect(params[2]).toBe("aborted");
  });
});
