#!/usr/bin/env node
/**
 * E-GAOP Load Test — Node.js alternative to k6
 * Run: node tests/load/node-load-test.js
 */

const http = require("http");

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const VUS = parseInt(process.env.VUS || "25", 10);
const DURATION_SEC = parseInt(process.env.DURATION || "300", 10);

let totalRequests = 0;
let totalErrors = 0;
let latencies = [];
let running = true;

function httpRequest(path, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { "Content-Type": "application/json", ...headers },
      timeout: 10000,
    };

    const start = Date.now();
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const latency = Date.now() - start;
        resolve({ status: res.statusCode, latency, body: data });
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function vuWorker(id) {
  let localReqs = 0;
  let localErrors = 0;

  // Authenticate first
  let token = null;
  try {
    const loginRes = await httpRequest("/api/auth/login", "POST", {
      email: "source@egaop.io",
      password: "SourceBuild123!",
    });
    if (loginRes.status === 200) {
      const parsed = JSON.parse(loginRes.body);
      token = parsed.data?.token;
    }
  } catch {}

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  while (running) {
    const endpoints = [
      { path: "/api/auth/login", method: "POST", body: { email: "source@egaop.io", password: "SourceBuild123!" } },
      { path: "/healthz", method: "GET" },
      { path: "/api/agents?namespace=default", method: "GET", headers: authHeaders },
      { path: "/api/audit?namespace=default&limit=10", method: "GET", headers: authHeaders },
    ];

    const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
    try {
      const res = await httpRequest(ep.path, ep.method, ep.body || null, ep.headers || {});
      totalRequests++;
      localReqs++;
      latencies.push(res.latency);
      if (res.status >= 500) { totalErrors++; localErrors++; }
    } catch {
      totalRequests++;
      localReqs++;
      totalErrors++;
      localErrors++;
    }

    // Small random delay (5-50ms)
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 45));
  }

  return { reqs: localReqs, errors: localErrors };
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║        E-GAOP Load Test — Node.js                   ║`);
  console.log(`║  VUs: ${String(VUS).padEnd(3)}  Duration: ${DURATION_SEC}s${" ".repeat(28)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  // Warmup
  console.log("Warming up...");
  for (let i = 0; i < 5; i++) {
    try { await httpRequest("/healthz"); } catch {}
  }
  console.log("Warmup done.\n");

  const startTime = Date.now();

  // Spawn VUs
  const workers = [];
  for (let i = 0; i < VUS; i++) {
    workers.push(vuWorker(i));
  }

  // Progress reporting every 30s
  const progressInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const rps = totalRequests > 0 ? (totalRequests / (elapsed || 1)).toFixed(1) : "0";
    const errRate = totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(2) : "0";
    const recent = latencies.slice(-100);
    const p95 = percentile(recent, 95);
    const p99 = percentile(recent, 99);
    process.stdout.write(
      `\r  [${elapsed}s/${DURATION_SEC}s] Requests: ${totalRequests} | RPS: ${rps} | Errors: ${errRate}% | P95: ${p95}ms | P99: ${p99}ms   `
    );
  }, 5000);

  // Stop after duration
  setTimeout(() => {
    running = false;
    clearInterval(progressInterval);
  }, DURATION_SEC * 1000);

  // Wait for all workers
  const results = await Promise.all(workers);

  const totalTimeSec = (Date.now() - startTime) / 1000;

  // Compute final stats
  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : "N/A";
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const maxLatency = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  const rps = (totalRequests / totalTimeSec).toFixed(1);
  const errorRate = totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(2) : "0";

  console.log(`\n\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║              LOAD TEST RESULTS                      ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Duration:       ${String(totalTimeSec.toFixed(0)).padEnd(5)}s${" ".repeat(33)}║`);
  console.log(`║  Virtual Users:  ${String(VUS).padEnd(5)} ${" ".repeat(33)}║`);
  console.log(`║  Total Requests: ${String(totalRequests).padEnd(5)} ${" ".repeat(33)}║`);
  console.log(`║  RPS:            ${String(rps).padEnd(5)} ${" ".repeat(33)}║`);
  console.log(`║  Error Rate:     ${String(errorRate).padEnd(5)}%${" ".repeat(32)}║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Avg Latency:    ${String(avgLatency).padEnd(5)}ms${" ".repeat(32)}║`);
  console.log(`║  P50 Latency:    ${String(p50).padEnd(5)}ms${" ".repeat(32)}║`);
  console.log(`║  P95 Latency:    ${String(p95).padEnd(5)}ms${" ".repeat(32)}║`);
  console.log(`║  P99 Latency:    ${String(p99).padEnd(5)}ms${" ".repeat(32)}║`);
  console.log(`║  Max Latency:    ${String(maxLatency).padEnd(5)}ms${" ".repeat(32)}║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);

  const p95Pass = p95 < 500;
  const errPass = parseFloat(errorRate) < 1;
  console.log(`║  P95 < 500ms:    ${p95Pass ? "PASS ✓" : "FAIL ✗"}${" ".repeat(34)}║`);
  console.log(`║  Errors < 1%:    ${errPass ? "PASS ✓" : "FAIL ✗"}${" ".repeat(34)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  // Exit with appropriate code
  process.exit(p95Pass && errPass ? 0 : 1);
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * arr.length) - 1;
  return arr[Math.max(0, idx)];
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
