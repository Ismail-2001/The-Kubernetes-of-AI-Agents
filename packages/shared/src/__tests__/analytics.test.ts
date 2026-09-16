import {
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

function mockQuery(rows: unknown[][]) {
  const calls: unknown[][] = [];
  return {
    query: jest.fn().mockImplementation((_sql: string, params?: unknown[]) => {
      calls.push(params ?? []);
      return Promise.resolve({ rows: rows[calls.length - 1] ?? [] });
    }),
    getCalls: () => calls,
  };
}

beforeEach(() => {
  mockGetPool.mockReset();
});

describe("Analytics Module", () => {
  describe("getExecutionPatterns", () => {
    it("returns hourly breakdown", async () => {
      const mockPool = mockQuery([
        [
          { hour: 9, dow: 3, execution_count: "15", avg_latency_ms: "1200", error_rate: "5.00" },
          { hour: 10, dow: 3, execution_count: "22", avg_latency_ms: "980", error_rate: "2.50" },
        ],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getExecutionPatterns(7);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        hour: 9,
        dayOfWeek: "Wednesday",
        executionCount: 15,
        avgLatencyMs: 1200,
        errorRate: 5.0,
      });
      expect(result[1]).toEqual({
        hour: 10,
        dayOfWeek: "Wednesday",
        executionCount: 22,
        avgLatencyMs: 980,
        errorRate: 2.5,
      });
    });

    it("groups by day of week", async () => {
      const mockPool = mockQuery([
        [
          { hour: 14, dow: 1, execution_count: "8", avg_latency_ms: "500", error_rate: "0" },
          { hour: 14, dow: 5, execution_count: "12", avg_latency_ms: "750", error_rate: "10.00" },
        ],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getExecutionPatterns(7);

      expect(result).toHaveLength(2);
      expect(result[0].dayOfWeek).toBe("Monday");
      expect(result[1].dayOfWeek).toBe("Friday");
    });
  });

  describe("getModelDistribution", () => {
    it("returns model stats", async () => {
      const mockPool = mockQuery([
        [
          { model: "gpt-4", request_count: "150", total_tokens: "450000", total_cost_usd: "9.75", avg_tokens_per_request: "3000" },
          { model: "claude-3", request_count: "80", total_tokens: "160000", total_cost_usd: "2.40", avg_tokens_per_request: "2000" },
        ],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getModelDistribution(7);

      expect(result).toHaveLength(2);
      expect(result[0].model).toBe("gpt-4");
      expect(result[0].requestCount).toBe(150);
      expect(result[0].totalTokens).toBe(450000);
      expect(result[0].totalCostUsd).toBeCloseTo(9.75, 2);
      expect(result[1].model).toBe("claude-3");
    });

    it("calculates avg tokens per request", async () => {
      const mockPool = mockQuery([
        [
          { model: "gpt-4", request_count: "100", total_tokens: "500000", total_cost_usd: "12.50", avg_tokens_per_request: "5000" },
        ],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getModelDistribution(7);

      expect(result[0].avgTokensPerRequest).toBe(5000);
    });
  });

  describe("getNamespaceActivity", () => {
    it("returns all namespaces when no filter", async () => {
      const mockPool = mockQuery([
        [{ namespace: "default", cnt: "3" }, { namespace: "staging", cnt: "5" }],
        [{ cnt: "10" }],
        [{ cnt: "42" }],
        [{ total: "1.25" }],
        [{ total: "4.80" }],
        [{ cnt: "2" }],
        [{ cnt: "8" }],
        [{ cnt: "20" }],
        [{ total: "0.50" }],
        [{ total: "2.10" }],
        [{ cnt: "4" }],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getNamespaceActivity();

      expect(result).toHaveLength(2);
      expect(result[0].namespace).toBe("default");
      expect(result[0].agentCount).toBe(3);
      expect(result[1].namespace).toBe("staging");
      expect(result[1].agentCount).toBe(5);
    });

    it("filters by specific namespace", async () => {
      const mockPool = mockQuery([
        [{ namespace: "staging", cnt: "2" }],
        [{ cnt: "6" }],
        [{ cnt: "12" }],
        [{ total: "0.80" }],
        [{ total: "3.20" }],
        [{ cnt: "3" }],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getNamespaceActivity("staging");

      expect(result).toHaveLength(1);
      expect(result[0].namespace).toBe("staging");
      expect(result[0].agentCount).toBe(2);
    });
  });

  describe("getUsageSummary", () => {
    it("aggregates 24h and 7d metrics", async () => {
      const mockPool = mockQuery([
        [{ cnt: "42" }],
        [{ cnt: "310" }],
        [{ total: "5.25" }],
        [{ total: "38.70" }],
        [{ cnt: "12" }],
        [{ cnt: "28" }],
        [{ model: "gpt-4", request_count: "100", total_tokens: "300000", total_cost_usd: "7.50", avg_tokens_per_request: "3000" }],
        [{ hour: 14 }],
        [{ avg_lat: "1350" }],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getUsageSummary();

      expect(result.totalExecutions24h).toBe(42);
      expect(result.totalExecutions7d).toBe(310);
      expect(result.totalCostUsd24h).toBeCloseTo(5.25, 2);
      expect(result.totalCostUsd7d).toBeCloseTo(38.7, 2);
      expect(result.uniqueUsers24h).toBe(12);
      expect(result.uniqueUsers7d).toBe(28);
      expect(result.topModels).toHaveLength(1);
      expect(result.topModels[0].model).toBe("gpt-4");
    });

    it("identifies peak hour", async () => {
      const mockPool = mockQuery([
        [{ cnt: "10" }],
        [{ cnt: "50" }],
        [{ total: "1" }],
        [{ total: "5" }],
        [{ cnt: "5" }],
        [{ cnt: "10" }],
        [],
        [{ hour: 14 }],
        [{ avg_lat: "800" }],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getUsageSummary();

      expect(result.peakHour).toBe(14);
    });
  });

  describe("getTopAgents", () => {
    it("returns sorted by execution count", async () => {
      const mockPool = mockQuery([
        [
          { agent_id: "agent-a", executions: "45", cost: "3.20" },
          { agent_id: "agent-b", executions: "30", cost: "1.80" },
          { agent_id: "agent-c", executions: "12", cost: "0.60" },
        ],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getTopAgents(10);

      expect(result).toHaveLength(3);
      expect(result[0].agentId).toBe("agent-a");
      expect(result[0].executions).toBe(45);
      expect(result[1].executions).toBeLessThan(result[0].executions);
      expect(result[2].executions).toBeLessThan(result[1].executions);
    });
  });

  describe("getCostTrend", () => {
    it("returns daily cost data", async () => {
      const mockPool = mockQuery([
        [
          { date: "2026-09-10", cost: "2.50" },
          { date: "2026-09-11", cost: "3.75" },
          { date: "2026-09-12", cost: "1.20" },
        ],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getCostTrend(30);

      expect(result).toHaveLength(3);
      expect(result[0].date).toBe("2026-09-10");
      expect(result[0].cost).toBeCloseTo(2.5, 2);
      expect(result[1].date).toBe("2026-09-11");
      expect(result[2].date).toBe("2026-09-12");
    });
  });

  describe("getPeakHours", () => {
    it("returns hourly distribution", async () => {
      const mockPool = mockQuery([
        [
          { hour: 9, avg_requests: "15.5" },
          { hour: 10, avg_requests: "22.3" },
          { hour: 14, avg_requests: "30.0" },
        ],
      ]);
      mockGetPool.mockResolvedValue(mockPool);

      const result = await getPeakHours(7);

      expect(result).toHaveLength(24);
      expect(result[9].avgRequests).toBeCloseTo(15.5, 1);
      expect(result[10].avgRequests).toBeCloseTo(22.3, 1);
      expect(result[14].avgRequests).toBeCloseTo(30.0, 1);
      expect(result[0].avgRequests).toBe(0);
      expect(result[23].avgRequests).toBe(0);
    });
  });

  describe("error handling", () => {
    it("returns empty array on DB failure for getExecutionPatterns", async () => {
      mockGetPool.mockRejectedValue(new Error("db down"));
      const result = await getExecutionPatterns();
      expect(result).toEqual([]);
    });

    it("returns empty array on DB failure for getModelDistribution", async () => {
      mockGetPool.mockRejectedValue(new Error("db down"));
      const result = await getModelDistribution();
      expect(result).toEqual([]);
    });

    it("returns empty array on DB failure for getTopAgents", async () => {
      mockGetPool.mockRejectedValue(new Error("db down"));
      const result = await getTopAgents();
      expect(result).toEqual([]);
    });

    it("returns empty array on DB failure for getCostTrend", async () => {
      mockGetPool.mockRejectedValue(new Error("db down"));
      const result = await getCostTrend();
      expect(result).toEqual([]);
    });

    it("returns zero-filled array on DB failure for getPeakHours", async () => {
      mockGetPool.mockRejectedValue(new Error("db down"));
      const result = await getPeakHours();
      expect(result).toHaveLength(24);
      expect(result[0].avgRequests).toBe(0);
    });

    it("returns default summary on DB failure for getUsageSummary", async () => {
      mockGetPool.mockRejectedValue(new Error("db down"));
      const result = await getUsageSummary();
      expect(result.totalExecutions24h).toBe(0);
      expect(result.totalExecutions7d).toBe(0);
      expect(result.topModels).toEqual([]);
    });

    it("returns empty array on DB failure for getNamespaceActivity", async () => {
      mockGetPool.mockRejectedValue(new Error("db down"));
      const result = await getNamespaceActivity();
      expect(result).toEqual([]);
    });
  });
});
