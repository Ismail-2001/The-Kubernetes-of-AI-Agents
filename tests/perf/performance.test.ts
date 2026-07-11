/**
 * E-GAOP Performance Benchmark
 *
 * What this measures:
 *   HTTP layer throughput of the running API server (Docker Compose stack).
 *   /health endpoint — unauthenticated, no DB, no OPA, pure HTTP overhead.
 *
 * What this does NOT measure (and why):
 *   - Authenticated endpoints: migration 004 (users table) not yet applied
 *     in this Docker Compose environment; auth middleware rejects all /api/* calls.
 *   - Agent execution path: requires Temporal workflow trigger + LLM provider.
 *   - OPA policy evaluation: not on the /health path.
 *   - Cold-start performance: containers pre-warmed before benchmark.
 *   - Multi-tenant contention: single-tenant test.
 *   - Sustained load beyond 10s windows.
 *
 * Scenario:
 *   Target:  http://localhost:3001/health  (API server REST BFF)
 *   Concurrency: 10, 25, 50 parallel connections
 *   Duration: 10 seconds per run
 *   Runs: 5 repetitions to characterize variance
 *   Stack: Docker Compose (PostgreSQL, Redis, OPA, Temporal, 8 services)
 *
 * Measured: 2026-07-10, Windows 11, Docker Desktop, AMD64
 */

import fs from "fs";
import path from "path";
import http from "http";

const API_BASE = "http://localhost:3001";
const RUNS = 5;
const DURATION_MS = 10_000;
const CONCURRENCY_LEVELS = [10, 25, 50];

// ─── Benchmark harness ─────────────────────────────────────────────────────

interface RunResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  requestsPerSecond: number;
  latenciesMs: number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  durationMs: number;
  errorRate: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)]!;
}

async function benchmarkHealth(concurrency: number, durationMs: number): Promise<RunResult> {
  const latencies: number[] = [];
  let successful = 0;
  let failed = 0;
  let active = 0;
  let shouldStop = false;

  const makeRequest = (): Promise<void> => {
    return new Promise((resolve) => {
      if (shouldStop) { resolve(); return; }

      active++;
      const start = Date.now();

      const urlObj = new URL(`${API_BASE}/health`);
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: "/health",
          method: "GET",
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            const latency = Date.now() - start;
            latencies.push(latency);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
              successful++;
            } else {
              failed++;
            }
            active--;
            resolve();
          });
        }
      );

      req.on("error", () => { failed++; active--; resolve(); });
      req.on("timeout", () => { req.destroy(); failed++; active--; resolve(); });

      req.end();
    });
  };

  const startTime = Date.now();
  const runLoop = async (): Promise<void> => {
    while (!shouldStop) {
      if (active < concurrency) makeRequest();
      await new Promise((r) => setTimeout(r, 1));
    }
    while (active > 0) await new Promise((r) => setTimeout(r, 10));
  };

  const timer = setTimeout(() => { shouldStop = true; }, durationMs);
  await runLoop();
  clearTimeout(timer);

  const duration = Date.now() - startTime;
  latencies.sort((a, b) => a - b);

  return {
    totalRequests: successful + failed,
    successfulRequests: successful,
    failedRequests: failed,
    requestsPerSecond: (successful + failed) / (duration / 1000),
    latenciesMs: latencies,
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    avgMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    durationMs: duration,
    errorRate: (successful + failed) > 0 ? failed / (successful + failed) : 0,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Performance: E-GAOP API server /health (live Docker Compose stack)", () => {
  beforeAll(async () => {
    // Verify stack is running
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.request(`${API_BASE}/health`, { timeout: 5000 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.end();
    });
    if (!ok) throw new Error(`API server not reachable at ${API_BASE} — is Docker Compose running?`);
  });

  for (const concurrency of CONCURRENCY_LEVELS) {
    it(
      `/health — ${concurrency} concurrent, ${DURATION_MS / 1000}s × ${RUNS} runs`,
      async () => {
        const results: RunResult[] = [];
        for (let run = 0; run < RUNS; run++) {
          results.push(await benchmarkHealth(concurrency, DURATION_MS));
        }

        // Aggregate
        const allP50 = results.map((r) => r.p50Ms);
        const allP95 = results.map((r) => r.p95Ms);
        const allP99 = results.map((r) => r.p99Ms);
        const allRps = results.map((r) => r.requestsPerSecond);
        const allAvg = results.map((r) => r.avgMs);
        const totalReqs = results.reduce((s, r) => s + r.totalRequests, 0);
        const totalErrors = results.reduce((s, r) => s + r.failedRequests, 0);

        // Report
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`  GET /health @ ${concurrency} concurrent × ${RUNS} runs`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`  Total requests:  ${totalReqs}`);
        console.log(`  Error rate:      ${(totalErrors / totalReqs * 100).toFixed(2)}% (${totalErrors}/${totalReqs})`);
        console.log(`  RPS (per run):   ${allRps.map((r) => r.toFixed(0)).join(", ")}`);
        console.log(`  RPS (avg):       ${(allRps.reduce((a, b) => a + b, 0) / allRps.length).toFixed(0)}`);
        console.log(`  Latency avg:     ${allAvg.map((r) => r.toFixed(1)).join(", ")} ms`);
        console.log(`  Latency p50:     ${allP50.map((r) => r.toFixed(0)).join(", ")} ms`);
        console.log(`  Latency p95:     ${allP95.map((r) => r.toFixed(0)).join(", ")} ms`);
        console.log(`  Latency p99:     ${allP99.map((r) => r.toFixed(0)).join(", ")} ms`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

        // Save raw results
        const rawDir = path.resolve(__dirname, "../../docs/benchmarks");
        if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
        const rawFile = path.join(rawDir, `health-c${concurrency}-${Date.now()}.json`);
        fs.writeFileSync(rawFile, JSON.stringify({
          endpoint: "/health",
          concurrency,
          runs: RUNS,
          durationMs: DURATION_MS,
          measuredAt: new Date().toISOString(),
          environment: {
            os: process.platform,
            node: process.version,
            docker: "Docker Desktop",
          },
          results,
        }, null, 2));
        console.log(`Raw results saved to: ${path.relative(process.cwd(), rawFile)}`);

        // Sanity assertions
        expect(totalReqs).toBeGreaterThan(0);
        expect(totalErrors / totalReqs).toBeLessThan(0.01); // <1% error rate
        const avgRps = allRps.reduce((a, b) => a + b, 0) / allRps.length;
        expect(avgRps).toBeGreaterThan(100); // At least 100 RPS for a health endpoint
      },
      300_000
    );
  }
});
