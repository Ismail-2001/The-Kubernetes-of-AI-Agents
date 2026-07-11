/**
 * E-GAOP Real Execution Path Benchmark
 *
 * Measures infrastructure-owned latency from INSIDE the Docker network:
 *   1. OPA policy evaluation (HTTP POST — real Rego evaluation)
 *   2. Sandbox-runtime health (HTTP probe — confirms connectivity)
 *
 * NOT measured (external):
 *   - LLM call (requires OPENAI_API_KEY)
 *   - Temporal orchestration (requires native bridge)
 *   - Sandbox creation (Docker socket not mounted)
 *
 * DNS names: opa:8181, sandbox-runtime:15054
 * Measured: 2026-07-11, Windows 11, Docker Desktop
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const CONTAINER =
  "enterprise-grade-agent-orchestration-platform-main-api-server-1";
const OPA_HOST = "opa";
const OPA_PORT = 8181;
const SANDBOX_HOST = "sandbox-runtime";
const SANDBOX_PORT = 15054;
const POLICY_PATH = "/v1/data/egaop/agent_execution";
const ITERATIONS = 20;

async function runInContainer(script: string): Promise<string> {
  // Write script to temp file, copy in, execute, remove
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const tmpFile = path.join(os.tmpdir(), `bench-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, script);
  try {
    await execAsync(`docker cp "${tmpFile}" ${CONTAINER}:/tmp/bench.js`);
    const { stdout } = await execAsync(
      `docker exec ${CONTAINER} node /tmp/bench.js`,
      { timeout: 10000 }
    );
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    try { await execAsync(`docker exec ${CONTAINER} rm -f /tmp/bench.js`); } catch { /* ignore */ }
  }
}

// ─── OPA evaluation ─────────────────────────────────────────────────────────

function opaScript(iteration: number): string {
  // Use single quotes inside the script to avoid escaping issues
  return `
const http = require('http');
const body = JSON.stringify({input:{subject:{namespace:'default',clearance:3},action:'execute',resource:{namespace:'default'},namespace:'default',agentId:'bench-${iteration}-' + Date.now(),claims:{}}});
const start = performance.now();
const req = http.request({hostname:'${OPA_HOST}',port:${OPA_PORT},path:'${POLICY_PATH}',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const latencyMs = performance.now() - start;
    try {
      const parsed = JSON.parse(data);
      const result = parsed.result || {};
      console.log(JSON.stringify({s:res.statusCode,l:Math.round(latencyMs*100)/100,a:result.allow===true}));
    } catch(e) {
      console.log(JSON.stringify({s:res.statusCode,l:Math.round(latencyMs*100)/100,a:false,e:'parse'}));
    }
  });
});
req.on('error', e => console.log(JSON.stringify({s:0,l:0,a:false,e:e.message})));
req.write(body);
req.end();
`;
}

// ─── Sandbox health ─────────────────────────────────────────────────────────

function sandboxHealthScript(): string {
  return `
const http = require('http');
const start = performance.now();
const req = http.request({hostname:'${SANDBOX_HOST}',port:${SANDBOX_PORT},path:'/healthz',method:'GET'}, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const latencyMs = performance.now() - start;
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify({s:res.statusCode,l:Math.round(latencyMs*100)/100,v:parsed.status==='SERVING'}));
    } catch(e) {
      console.log(JSON.stringify({s:res.statusCode,l:Math.round(latencyMs*100)/100,v:false}));
    }
  });
});
req.on('error', e => console.log(JSON.stringify({s:0,l:0,v:false,e:e.message})));
req.end();
`;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  step: string;
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  errorCount: number;
}

function computeStats(latencies: number[], errors: number, step: string): BenchmarkResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    step,
    iterations: n,
    avgMs: n > 0 ? sorted.reduce((a, b) => a + b, 0) / n : 0,
    p50Ms: n > 0 ? sorted[Math.floor(n * 0.5)] : 0,
    p95Ms: n > 0 ? sorted[Math.floor(n * 0.95)] : 0,
    p99Ms: n > 0 ? sorted[Math.floor(n * 0.99)] : 0,
    minMs: n > 0 ? sorted[0] : 0,
    maxMs: n > 0 ? sorted[n - 1] : 0,
    errorCount: errors,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

describe("E-GAOP Real Execution Path Benchmark", () => {
  const results: BenchmarkResult[] = [];

  afterAll(() => {
    console.log("\n" + "=".repeat(95));
    console.log("E-GAOP REAL EXECUTION PATH BENCHMARK RESULTS");
    console.log("=".repeat(95));
    console.log(
      "Step".padEnd(42) +
        "Avg (ms)".padEnd(12) +
        "P50 (ms)".padEnd(12) +
        "P95 (ms)".padEnd(12) +
        "P99 (ms)".padEnd(12) +
        "Min".padEnd(10) +
        "Max".padEnd(10) +
        "Errors"
    );
    console.log("-".repeat(95));
    for (const r of results) {
      console.log(
        r.step.padEnd(42) +
          r.avgMs.toFixed(1).padEnd(12) +
          r.p50Ms.toFixed(1).padEnd(12) +
          r.p95Ms.toFixed(1).padEnd(12) +
          r.p99Ms.toFixed(1).padEnd(12) +
          r.minMs.toFixed(1).padEnd(10) +
          r.maxMs.toFixed(1).padEnd(10) +
          `${r.errorCount}/${r.iterations + r.errorCount}`
      );
    }
    console.log("-".repeat(95));
    console.log("");
    console.log("NOT measured (external dependencies):");
    console.log("  - LLM call latency (requires OPENAI_API_KEY)");
    console.log("  - Temporal workflow orchestration (requires native bridge)");
    console.log("  - Sandbox creation (Docker socket not mounted in container)");
    console.log("");
    console.log("These numbers represent INFRASTRUCTURE-OWNED latency of");
    console.log("deterministic components (OPA policy evaluation, service health).");
    console.log("The LLM round-trip is external and typically dominates total latency.");
    console.log("=".repeat(95) + "\n");
  });

  it("OPA policy evaluation — 20 sequential calls", async () => {
    const latencies: number[] = [];
    let errors = 0;
    let allows = 0;
    let denials = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      try {
        const output = await runInContainer(opaScript(i));
        const result = JSON.parse(output);
        if (result.s >= 200 && result.s < 300 && !result.e) {
          latencies.push(result.l);
          if (result.a) allows++;
          else denials++;
        } else {
          errors++;
          console.log(`  [error] iter ${i}: status=${result.s} allow=${result.a} err=${result.e || "none"}`);
        }
      } catch (err: unknown) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [error] iter ${i}: exec_failed: ${msg.slice(0, 80)}`);
      }
    }

    const stats = computeStats(latencies, errors, "OPA policy evaluation (sequential)");
    results.push(stats);

    console.log(`\nOPA Policy Evaluation (${ITERATIONS} sequential):`);
    console.log(`  Avg: ${stats.avgMs.toFixed(1)}ms  P50: ${stats.p50Ms.toFixed(1)}ms  P95: ${stats.p95Ms.toFixed(1)}ms`);
    console.log(`  Allows: ${allows}  Denials: ${denials}  Errors: ${errors}`);

    // OPA should respond within 500ms for local sidecar
    expect(stats.errorCount).toBe(0);
    expect(stats.avgMs).toBeLessThan(500);
  });

  it("Sandbox-runtime health — 10 sequential probes", async () => {
    const latencies: number[] = [];
    let errors = 0;
    let serving = 0;

    for (let i = 0; i < 10; i++) {
      try {
        const output = await runInContainer(sandboxHealthScript());
        const result = JSON.parse(output);
        if (!result.e) {
          latencies.push(result.l);
          if (result.v) serving++;
        } else {
          errors++;
          console.log(`  [error] iter ${i}: err=${result.e}`);
        }
      } catch (err: unknown) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [error] iter ${i}: exec_failed: ${msg.slice(0, 80)}`);
      }
    }

    const stats = computeStats(latencies, errors, "Sandbox health check (sequential)");
    results.push(stats);

    console.log(`\nSandbox Health Check (10 sequential):`);
    console.log(`  Avg: ${stats.avgMs.toFixed(1)}ms  P50: ${stats.p50Ms.toFixed(1)}ms  P95: ${stats.p95Ms.toFixed(1)}ms`);
    console.log(`  Serving: ${serving}/10  Errors: ${errors}`);

    // Health check should respond quickly even if NOT_SERVING
    expect(stats.errorCount).toBe(0);
    expect(stats.avgMs).toBeLessThan(200);
  });
});
