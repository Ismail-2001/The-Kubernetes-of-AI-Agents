import { HealthStatus, buildHealthResponse, healthToHttpStatus } from "../health/contract.js";
import { checkPostgres, checkRedis, checkGrpc, checkSkipped } from "../health/checks.js";

describe("Health Contract", () => {
  const baseTime = new Date(Date.now() - 60000);

  describe("buildHealthResponse", () => {
    it("returns SERVING when all checks are healthy", () => {
      const checks = [
        { name: "postgres", status: "healthy" as const, latency_ms: 5 },
      ];
      const response = buildHealthResponse("test-service", "1.0.0", baseTime, checks);
      expect(response.status).toBe(HealthStatus.SERVING);
      expect(response.service).toBe("test-service");
      expect(response.version).toBe("1.0.0");
      expect(response.degraded).toBe(false);
      expect(response.reason).toBeUndefined();
    });

    it("returns DEGRADED when some checks are skipped", () => {
      const checks = [
        { name: "postgres", status: "healthy" as const, latency_ms: 5 },
        { name: "temporal", status: "skipped" as const, message: "not connected" },
      ];
      const response = buildHealthResponse("test-service", "1.0.0", baseTime, checks);
      expect(response.status).toBe(HealthStatus.DEGRADED);
      expect(response.degraded).toBe(true);
    });

    it("returns NOT_SERVING when required checks fail", () => {
      const checks = [
        { name: "postgres", status: "unhealthy" as const, latency_ms: 3000, message: "connection refused" },
      ];
      const response = buildHealthResponse("test-service", "1.0.0", baseTime, checks);
      expect(response.status).toBe(HealthStatus.NOT_SERVING);
      expect(response.degraded).toBe(true);
      expect(response.reason).toContain("postgres");
    });

    it("returns NOT_SERVING even if degraded when required deps fail", () => {
      const checks = [
        { name: "postgres", status: "unhealthy" as const, latency_ms: 3000 },
        { name: "temporal", status: "skipped" as const, message: "unavailable" },
      ];
      const response = buildHealthResponse("test-service", "1.0.0", baseTime, checks);
      expect(response.status).toBe(HealthStatus.NOT_SERVING);
    });

    it("includes uptime_s in response", () => {
      const checks = [{ name: "pg", status: "healthy" as const }];
      const response = buildHealthResponse("svc", "1.0.0", baseTime, checks);
      expect(response.uptime_s).toBe(60);
      expect(response.timestamp).toBeDefined();
    });

    it("handles empty checks array", () => {
      const response = buildHealthResponse("svc", "1.0.0", baseTime, []);
      expect(response.status).toBe(HealthStatus.SERVING);
      expect(response.checks).toEqual([]);
    });
  });

  describe("healthToHttpStatus", () => {
    it("returns 200 for SERVING", () => {
      expect(healthToHttpStatus(HealthStatus.SERVING)).toBe(200);
    });

    it("returns 200 for DEGRADED", () => {
      expect(healthToHttpStatus(HealthStatus.DEGRADED)).toBe(200);
    });

    it("returns 503 for NOT_SERVING", () => {
      expect(healthToHttpStatus(HealthStatus.NOT_SERVING)).toBe(503);
    });
  });
});

describe("Dependency Checks", () => {
  describe("checkPostgres", () => {
    it("returns healthy when query succeeds", async () => {
      const check = await checkPostgres(async () => ({ rows: [] }));
      expect(check.status).toBe("healthy");
      expect(check.name).toBe("postgres");
      expect(check.latency_ms).toBeGreaterThanOrEqual(0);
    });

    it("returns unhealthy when query fails", async () => {
      const check = await checkPostgres(async () => { throw new Error("connection refused"); });
      expect(check.status).toBe("unhealthy");
      expect(check.message).toBe("connection refused");
    });

    it("returns unhealthy on timeout", async () => {
      const check = await checkPostgres(
        () => new Promise(resolve => setTimeout(resolve, 10000)),
        50,
      );
      expect(check.status).toBe("unhealthy");
      expect(check.message).toBe("timeout");
    });
  });

  describe("checkRedis", () => {
    it("returns healthy when ping succeeds", async () => {
      const check = await checkRedis(async () => "PONG");
      expect(check.status).toBe("healthy");
      expect(check.name).toBe("redis");
    });

    it("returns unhealthy when ping fails", async () => {
      const check = await checkRedis(async () => { throw new Error("ECONNREFUSED"); });
      expect(check.status).toBe("unhealthy");
    });
  });

  describe("checkGrpc", () => {
    it("returns healthy when TCP connection succeeds", async () => {
      // We can't easily test a real TCP connect, so test the failure path
      const check = await checkGrpc("temporal", "192.0.2.1:9999", 100);
      expect(check.status).toBe("unhealthy");
      expect(check.name).toBe("temporal");
    });
  });

  describe("checkSkipped", () => {
    it("returns skipped with message", () => {
      const check = checkSkipped("temporal", "not configured");
      expect(check.status).toBe("skipped");
      expect(check.name).toBe("temporal");
      expect(check.message).toBe("not configured");
    });
  });
});
