import {
  ensureLLMUsageTable,
  dayOfWeekName,
  getExecutionPatterns,
  getModelDistribution,
  getNamespaceActivity,
  getUsageSummary,
  getTopAgents,
  getCostTrend,
  getPeakHours,
} from "../analytics/index.js";
import { getPool } from "../db.js";

jest.mock("../db.js", () => ({
  getPool: jest.fn(),
}));

const mockGetPool = getPool as jest.Mock;

function poolReturning(rows: unknown[][]) {
  let i = 0;
  return {
    query: jest.fn().mockImplementation(() => Promise.resolve({ rows: rows[i++] ?? [] })),
  };
}

beforeEach(() => {
  mockGetPool.mockReset();
});

describe("analytics edge cases", () => {
  it("ensureLLMUsageTable runs the DDL once", async () => {
    const pool = poolReturning([[]]);
    mockGetPool.mockResolvedValue(pool);

    await ensureLLMUsageTable();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(String(pool.query.mock.calls[0][0])).toContain("CREATE TABLE IF NOT EXISTS llm_usage");
  });

  describe("dayOfWeekName", () => {
    it("maps valid weekdays", () => {
      expect(dayOfWeekName(new Date("2026-10-21T12:00:00Z"))).toBe("Wednesday");
    });

    it("falls back to Unknown for out-of-range days", () => {
      const fake = { getDay: () => 99 } as Date;
      expect(dayOfWeekName(fake)).toBe("Unknown");
    });
  });

  it("getExecutionPatterns maps unknown dow and null metrics to defaults", async () => {
    const pool = poolReturning([
      [
        { hour: 3, dow: 99, execution_count: "1", avg_latency_ms: null, error_rate: null },
      ],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getExecutionPatterns();

    expect(result).toEqual([
      { hour: 3, dayOfWeek: "Unknown", executionCount: 1, avgLatencyMs: 0, errorRate: 0 },
    ]);
  });

  it("getModelDistribution defaults null cost to 0", async () => {
    const pool = poolReturning([
      [{ model: "m", request_count: "2", total_tokens: "10", total_cost_usd: null, avg_tokens_per_request: "5" }],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getModelDistribution();

    expect(result[0].totalCostUsd).toBe(0);
  });

  it("getNamespaceActivity returns [] when no agents exist", async () => {
    const pool = poolReturning([[]]);
    mockGetPool.mockResolvedValue(pool);

    const expectResult = await getNamespaceActivity("ghost");
    expect(expectResult).toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("getNamespaceActivity defaults missing counters and costs", async () => {
    const pool = poolReturning([
      [{ namespace: "ns1", cnt: "1" }],
      [],
      [],
      [],
      [],
      [],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getNamespaceActivity();

    expect(result).toEqual([
      {
        namespace: "ns1",
        agentCount: 1,
        executionCount24h: 0,
        executionCount7d: 0,
        totalCostUsd24h: 0,
        totalCostUsd7d: 0,
        activeUsers: 0,
      },
    ]);
  });

  it("getNamespaceActivity defaults agent count when rows lack cnt", async () => {
    const pool = poolReturning([
      [{ namespace: "ns1" }],
      [],
      [],
      [],
      [],
      [],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getNamespaceActivity();

    expect(result[0].agentCount).toBe(0);
  });

  it("getUsageSummary defaults every counter when all queries return empty", async () => {
    const pool = poolReturning([[], [], [], [], [], [], [], [], []]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getUsageSummary();

    expect(result).toEqual({
      totalExecutions24h: 0,
      totalExecutions7d: 0,
      totalCostUsd24h: 0,
      totalCostUsd7d: 0,
      uniqueUsers24h: 0,
      uniqueUsers7d: 0,
      topModels: [],
      peakHour: 0,
      avgExecutionLatencyMs: 0,
    });
  });

  it("getUsageSummary defaults null latency to 0", async () => {
    const pool = poolReturning([
      [{ cnt: "1" }],
      [{ cnt: "2" }],
      [{ total: null }],
      [{ total: null }],
      [{ cnt: null }],
      [{ cnt: null }],
      [],
      [{ hour: 5 }],
      [{ avg_lat: null }],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getUsageSummary();

    expect(result.totalExecutions24h).toBe(1);
    expect(result.totalCostUsd24h).toBe(0);
    expect(result.uniqueUsers24h).toBe(0);
    expect(result.avgExecutionLatencyMs).toBe(0);
    expect(result.peakHour).toBe(5);
  });

  it("getTopAgents falls back for missing agent id and cost", async () => {
    const pool = poolReturning([
      [{ agent_id: null, executions: "4", cost: null }],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getTopAgents();

    expect(result).toEqual([{ agentId: "", executions: 4, cost: 0 }]);
  });

  it("getCostTrend normalizes Date rows and defaults null cost", async () => {
    const pool = poolReturning([
      [
        { date: "2026-10-01", cost: null },
        { date: new Date("2026-10-02T12:00:00Z"), cost: "1.5" },
      ],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getCostTrend();

    expect(result).toEqual([
      { date: "2026-10-01", cost: 0 },
      { date: "2026-10-02", cost: 1.5 },
    ]);
  });

  it("getPeakHours defaults null request averages to 0", async () => {
    const pool = poolReturning([
      [{ hour: 7, avg_requests: null }],
    ]);
    mockGetPool.mockResolvedValue(pool);

    const result = await getPeakHours();

    expect(result).toHaveLength(24);
    expect(result[7]).toEqual({ hour: 7, avgRequests: 0 });
    expect(result[8].avgRequests).toBe(0);
  });
});
