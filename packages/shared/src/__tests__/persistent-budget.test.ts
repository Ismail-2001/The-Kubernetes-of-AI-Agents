const mockQuery = jest.fn();

jest.mock("../db.js", () => ({
  getPool: jest.fn().mockResolvedValue({ query: mockQuery }),
}));

import {
  getBudget,
  setBudget,
  recordUsage,
  getUsage,
  getAllUsage,
  resetUsage,
  getBudgetAlerts,
} from "../budget/persistent-budget.js";

beforeEach(() => {
  mockQuery.mockReset();
});

function makeBudgetRow(overrides: Record<string, unknown> = {}) {
  return {
    namespace: "test-ns",
    daily_cost_limit_usd: 50.0,
    daily_token_limit: 1000000,
    monthly_cost_limit_usd: 1000.0,
    monthly_token_limit: 30000000,
    rpm_limit: 30,
    created_at: new Date("2025-01-01"),
    updated_at: new Date("2025-01-01"),
    ...overrides,
  };
}

function makeUsageRow(overrides: Record<string, unknown> = {}) {
  return {
    tokens_used: 0,
    cost_usd: 0,
    request_count: 0,
    ...overrides,
  };
}

describe("getBudget", () => {
  it("returns defaults for unconfigured namespaces", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const budget = await getBudget("unknown-ns");
    expect(budget.namespace).toBe("unknown-ns");
    expect(budget.dailyCostLimitUsd).toBe(50.0);
    expect(budget.dailyTokenLimit).toBe(1000000);
    expect(budget.monthlyCostLimitUsd).toBe(1000.0);
    expect(budget.monthlyTokenLimit).toBe(30000000);
    expect(budget.rpmLimit).toBe(30);
  });

  it("returns configured budget from database", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeBudgetRow({ daily_cost_limit_usd: 100.0, rpm_limit: 60 })],
    });
    const budget = await getBudget("test-ns");
    expect(budget.dailyCostLimitUsd).toBe(100.0);
    expect(budget.rpmLimit).toBe(60);
  });
});

describe("setBudget", () => {
  it("creates or updates budget config", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // getBudget inside setBudget
      .mockResolvedValueOnce({}); // UPSERT
    await setBudget("new-ns", { dailyCostLimitUsd: 200.0, rpmLimit: 100 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][1]).toContain("new-ns");
    expect(mockQuery.mock.calls[1][1]).toContain(200.0);
  });
});

describe("recordUsage", () => {
  it("increments counters and returns allowed=true within limits", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // getBudget
      .mockResolvedValueOnce({}) // INSERT upsert
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 100, cost_usd: 0.5, request_count: 1 })] })
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 100, cost_usd: 0.5, request_count: 1 })] })
      .mockResolvedValueOnce({ rows: [{ rpm: 5 }] });

    const result = await recordUsage("test-ns", 100, 0.5);
    expect(result.allowed).toBe(true);
    expect(result.current.tokensUsed).toBe(100);
    expect(result.current.costUsd).toBe(0.5);
  });

  it("returns allowed=false when daily cost exceeded", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // getBudget
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 1000, cost_usd: 60.0, request_count: 10 })] })
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 1000, cost_usd: 60.0, request_count: 10 })] })
      .mockResolvedValueOnce({ rows: [{ rpm: 1 }] });

    const result = await recordUsage("test-ns", 100, 0.5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("DAILY_COST_EXCEEDED");
  });

  it("returns allowed=false when daily token limit exceeded", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // getBudget
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 1_000_001, cost_usd: 1.0, request_count: 10 })] })
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 1_000_001, cost_usd: 1.0, request_count: 10 })] })
      .mockResolvedValueOnce({ rows: [{ rpm: 1 }] });

    const result = await recordUsage("test-ns", 100, 0.5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("DAILY_TOKEN_EXCEEDED");
  });

  it("returns allowed=false when monthly cost exceeded", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // getBudget
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 100, cost_usd: 1.0, request_count: 1 })] })
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 100, cost_usd: 1001.0, request_count: 100 })] })
      .mockResolvedValueOnce({ rows: [{ rpm: 1 }] });

    const result = await recordUsage("test-ns", 100, 0.5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("MONTHLY_COST_EXCEEDED");
  });

  it("returns allowed=false when RPM exceeded", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // getBudget
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 100, cost_usd: 1.0, request_count: 1 })] })
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 100, cost_usd: 1.0, request_count: 1 })] })
      .mockResolvedValueOnce({ rows: [{ rpm: 50 }] });

    const result = await recordUsage("test-ns", 100, 0.5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("RPM_EXCEEDED");
  });

  it("returns allowed=false when monthly token limit exceeded", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // getBudget
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 100, cost_usd: 1.0, request_count: 1 })] })
      .mockResolvedValueOnce({ rows: [makeUsageRow({ tokens_used: 30_000_001, cost_usd: 1.0, request_count: 100 })] })
      .mockResolvedValueOnce({ rows: [{ rpm: 1 }] });

    const result = await recordUsage("test-ns", 100, 0.5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("MONTHLY_TOKEN_EXCEEDED");
  });
});

describe("getUsage", () => {
  it("returns correct daily totals", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeUsageRow({ tokens_used: 5000, cost_usd: 2.5, request_count: 50 })],
    });
    const usage = await getUsage("test-ns", "daily");
    expect(usage.tokensUsed).toBe(5000);
    expect(usage.costUsd).toBe(2.5);
    expect(usage.requestCount).toBe(50);
  });

  it("returns correct monthly totals", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeUsageRow({ tokens_used: 150000, cost_usd: 75.0, request_count: 1500 })],
    });
    const usage = await getUsage("test-ns", "monthly");
    expect(usage.tokensUsed).toBe(150000);
    expect(usage.costUsd).toBe(75.0);
    expect(usage.requestCount).toBe(1500);
  });

  it("returns zeros for no usage", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const usage = await getUsage("test-ns", "daily");
    expect(usage.tokensUsed).toBe(0);
    expect(usage.costUsd).toBe(0);
    expect(usage.requestCount).toBe(0);
  });
});

describe("getAllUsage", () => {
  it("returns all namespaces with usage summaries", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeBudgetRow({ namespace: "ns-a" }), makeBudgetRow({ namespace: "ns-b" })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { namespace: "ns-a", tokens_used: 100, cost_usd: 0.5, request_count: 10 },
          { namespace: "ns-b", tokens_used: 200, cost_usd: 1.0, request_count: 20 },
        ],
      });

    const summaries = await getAllUsage();
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.namespace).sort()).toEqual(["ns-a", "ns-b"]);
  });
});

describe("resetUsage", () => {
  it("clears daily counters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resetUsage("test-ns", "daily");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM namespace_usage"),
      expect.arrayContaining(["test-ns"]),
    );
  });

  it("clears monthly counters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resetUsage("test-ns", "monthly");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM namespace_usage"),
      expect.arrayContaining(["test-ns"]),
    );
  });
});

describe("getBudgetAlerts", () => {
  it("returns namespaces with daily usage >80%", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeBudgetRow({ namespace: "alert-ns" })] })
      .mockResolvedValueOnce({
        rows: [makeUsageRow({ tokens_used: 850000, cost_usd: 42.5, request_count: 500 })],
      })
      .mockResolvedValueOnce({
        rows: [makeUsageRow({ tokens_used: 850000, cost_usd: 42.5, request_count: 500 })],
      });

    const alerts = await getBudgetAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].namespace).toBe("alert-ns");
    expect(alerts[0].currentPercent).toBeGreaterThan(80);
  });

  it("returns empty when all within limits", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeBudgetRow({ namespace: "safe-ns" })] })
      .mockResolvedValueOnce({
        rows: [makeUsageRow({ tokens_used: 100, cost_usd: 0.5, request_count: 10 })],
      })
      .mockResolvedValueOnce({
        rows: [makeUsageRow({ tokens_used: 100, cost_usd: 0.5, request_count: 10 })],
      });

    const alerts = await getBudgetAlerts();
    expect(alerts).toHaveLength(0);
  });
});
