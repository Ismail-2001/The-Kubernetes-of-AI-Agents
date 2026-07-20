#!/usr/bin/env node
/**
 * E-GAOP Real-Concurrency Load Test (Task BK)
 *
 * Fires N concurrent agent executions against the live api-server REST endpoint,
 * polls each Temporal workflow to completion, and reports end-to-end latency
 * percentiles (p50/p95/p99), error rate, and container resource behavior.
 *
 * Prereqs:
 *   - docker-compose stack running with TLS_ENABLED=true
 *   - .env values for auth (register/login endpoints on api-server:3001)
 *
 * Usage:
 *   node scripts/load-test-bk.mjs [concurrency] [runsPerPrompt]
 */

import http from "node:http";
import { spawn } from "node:child_process";

const API = process.env.API_BASE || "http://localhost:3001";
const NS = process.env.TEMPORAL_NS || "egaop";

// Discover the live Temporal container IP (Docker bridge assigns dynamic IPs)
function temporalAddr() {
  return new Promise((resolve) => {
    const cmd = spawn("docker", [
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      "enterprise-grade-agent-orchestration-platform-main-temporal-1",
    ], { windowsHide: true });
    let out = "";
    cmd.stdout.on("data", (c) => (out += c));
    cmd.stderr.on("data", () => {});
    cmd.on("close", () => resolve(`${out.trim()}:7233`));
  });
}
const CONCURRENCY = parseInt(process.argv[2] || "15", 10);
const RUNS_PER_PROMPT = parseInt(process.argv[3] || "1", 10);

// Realistic mix exercising the full stack: LLM-only + code_interpreter (sandbox+tool-proxy)
const PROMPTS = [
  "What is 2+2?",
  "What is the capital of France?",
  "Just say hello.",
  "Calculate 15 * 37 using Python.",
  "Calculate the sum of integers from 1 to 100 using Python.",
  "Write a Python function that returns the first 10 Fibonacci numbers.",
  "Use Python to compute 2 raised to the 20th power.",
];

function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(API + path);
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(headers || {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: d ? safeJson(d) : null })
        );
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function pctl(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[idx];
}

async function auth() {
  const email = `loadtest_${Date.now()}@test.com`;
  const pw = "LoadTestPass123!";
  try {
    const r = await req("POST", "/api/auth/register", null, {
      name: "loadtest",
      email,
      password: pw,
    });
    if (r.status === 200 || r.status === 201) return r.body.data.token;
  } catch {}
  const r = await req("POST", "/api/auth/login", null, { email, password: pw });
  return r.body.data.token;
}

function temporalDescribe(wfId, addr) {
  return new Promise((resolve) => {
    const cmd = spawn(
      "docker",
      [
        "exec",
        "enterprise-grade-agent-orchestration-platform-main-temporal-1",
        "temporal",
        "workflow",
        "describe",
        "--address",
        addr,
        "--namespace",
        NS,
        "-w",
        wfId,
        "-o",
        "json",
      ],
      { windowsHide: true }
    );
    let out = "";
    cmd.stdout.on("data", (c) => (out += c));
    cmd.stderr.on("data", () => {});
    cmd.on("close", () => {
      try {
        resolve(JSON.parse(out).result);
      } catch {
        resolve(null);
      }
    });
  });
}

async function waitComplete(wfId, timeoutMs, addr) {
  const start = Date.now();
  const terminal = ["SUCCEEDED", "FAILED", "TIMEOUT", "CANCELED", "TERMINATED"];
  while (Date.now() - start < timeoutMs) {
    const res = await temporalDescribe(wfId, addr);
    if (res && terminal.includes(res.status)) return res;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "POLL_TIMEOUT" };
}

function dockerStats() {
  return new Promise((resolve) => {
    const cmd = spawn(
      "docker",
      ["stats", "--no-stream", "--format", "{{.Name}},{{.CPUPerc}},{{.MemPerc}}"],
      { windowsHide: true }
    );
    let out = "";
    cmd.stdout.on("data", (c) => (out += c));
    cmd.stderr.on("data", () => {});
    cmd.on("close", () => resolve(out));
  });
}

async function main() {
  console.log(`\n=== E-GAOP Concurrent Load Test (BK) ===`);
  console.log(`Concurrency: ${CONCURRENCY} | Prompts: ${PROMPTS.length} | Runs/prompt: ${RUNS_PER_PROMPT}`);
  const TEMPORAL_ADDR = await temporalAddr();
  console.log(`API: ${API} | Temporal: ${TEMPORAL_ADDR} (${NS})`);

  const token = await auth();
  console.log("Auth OK\n");

  // Build workload: round-robin prompts across N total jobs
  const total = CONCURRENCY * RUNS_PER_PROMPT;
  const jobs = [];
  for (let i = 0; i < total; i++) jobs.push(PROMPTS[i % PROMPTS.length]);

  const results = [];
  const startWall = Date.now();

  // Resource sampling during the run
  const statsSamples = [];
  const sampler = setInterval(async () => {
    statsSamples.push({ t: Date.now() - startWall, raw: await dockerStats() });
  }, 2000);

  // Run with a concurrency cap via a simple pool
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const i = cursor++;
      const prompt = jobs[i];
      const t0 = Date.now();
      try {
        const r = await req(
          "POST",
          "/api/agents/eval-agent/run",
          { Authorization: `Bearer ${token}` },
          { input: { prompt }, namespace: "default" }
        );
        if (r.status !== 200 || !r.body?.data?.workflowId) {
          results.push({ ok: false, sec: (Date.now() - t0) / 1000, err: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,120)}` });
          continue;
        }
        const wfId = r.body.data.workflowId;
        const res = await waitComplete(wfId, 90000, TEMPORAL_ADDR);
        const sec = (Date.now() - t0) / 1000;
        results.push({ ok: res.status === "SUCCEEDED", sec, status: res.status, err: res.error || "" });
      } catch (e) {
        results.push({ ok: false, sec: (Date.now() - t0) / 1000, err: e.message.slice(0, 120) });
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  clearInterval(sampler);

  const wall = (Date.now() - startWall) / 1000;

  // Analyze
  const okSecs = results.filter((r) => r.ok).map((r) => r.sec).sort((a, b) => a - b);
  const allSecs = results.map((r) => r.sec).sort((a, b) => a - b);
  const failed = results.filter((r) => !r.ok);
  const errRate = ((failed.length / results.length) * 100).toFixed(1);

  console.log(`\n=== RESULTS ===`);
  console.log(`Wall time:        ${wall.toFixed(1)}s`);
  console.log(`Total runs:       ${results.length}`);
  console.log(`Succeeded:        ${results.filter((r) => r.ok).length}`);
  console.log(`Failed:           ${failed.length} (${errRate}%)`);
  console.log(`Concurrency:      ${CONCURRENCY}`);
  console.log(`Throughput:       ${(results.length / wall).toFixed(2)} runs/s`);
  console.log(`\n-- End-to-end latency (s) --`);
  console.log(`  All:  min=${allSecs[0]?.toFixed(2)} max=${allSecs[allSecs.length-1]?.toFixed(2)}`);
  console.log(`  p50=${pctl(allSecs,50).toFixed(2)}  p95=${pctl(allSecs,95).toFixed(2)}  p99=${pctl(allSecs,99).toFixed(2)}`);
  if (okSecs.length) {
    console.log(`  (succeeded only) p50=${pctl(okSecs,50).toFixed(2)} p95=${pctl(okSecs,95).toFixed(2)} p99=${pctl(okSecs,99).toFixed(2)}`);
  }

  if (failed.length) {
    console.log(`\n-- FAILURES --`);
    failed.slice(0, 10).forEach((f, i) =>
      console.log(`  #${i + 1}: ${f.err} (${f.sec.toFixed(2)}s)`)
    );
  }

  // Resource behavior summary (peak CPU% per service of interest)
  console.log(`\n-- Peak resource usage during run (sampled) --`);
  const peaks = {};
  for (const s of statsSamples) {
    for (const line of s.raw.split("\n")) {
      if (!line.trim()) continue;
      const [name, cpu, mem] = line.split(",");
      const cpuN = parseFloat(cpu);
      if (!isNaN(cpuN)) peaks[name] = Math.max(peaks[name] || 0, cpuN);
    }
  }
  const interesting = [
    "api-server","workflow-engine","sandbox-runtime","tool-proxy",
    "llm-router","memory-plane","observability-plane","temporal","postgres","redis",
  ];
  for (const k of interesting) {
    const key = Object.keys(peaks).find((n) => n.includes(k));
    if (key) console.log(`  ${k.padEnd(22)} peak CPU ${peaks[key].toFixed(1)}%`);
  }
  console.log(`\nDONE`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
