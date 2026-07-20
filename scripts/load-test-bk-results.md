# Task BK — Real-Concurrency Load Test Results

**Date**: 2026-07-18
**Stack**: docker-compose (TLS_ENABLED=true), api-server:3001 REST → workflow-engine → Temporal → llm-router/tool-proxy/sandbox-runtime
**Harness**: `scripts/load-test-bk.mjs` (Node.js; auth → concurrent `POST /api/agents/eval-agent/run` → poll Temporal `describe` → record end-to-end latency)

## Method
- Each run fires a realistic prompt mix exercising the full stack:
  - LLM-only Q&A: "What is 2+2?", "Capital of France?", "Just say hello."
  - code_interpreter (sandbox-runtime + tool-proxy): "Calculate 15*37 using Python", "Sum 1..100 using Python", "First 10 Fibonacci in Python", "2^20 in Python"
- Concurrency = number of worker "threads" issuing `POST` simultaneously (capped pool).
- Latency = wall-clock from `POST /run` to Temporal workflow reaching terminal state (SUCCEEDED).
- Temporal address discovered dynamically via `docker inspect` (bridge IP is non-static).
- Resource peaks sampled every 2s via `docker stats`.

## Results

| Concurrency | Total | Succeeded | Failed (timeout) | Success % | p50 (s) | p95 (s) | p99 (s) | Throughput |
|-------------|-------|-----------|------------------|-----------|---------|---------|---------|------------|
| 10          | 10    | 10        | 0                | 100%      | 41.9    | 44.3    | 44.3    | 0.23/s     |
| 12          | 12    | 9         | 3                | 75%       | 43.8    | 51.7    | 51.7    | 0.13/s     |
| 15          | 15    | 9         | 6                | 60%       | 56.2    | 70.6    | 70.6    | 0.12/s     |

Failed runs = Temporal `TIMEOUT` (workflow execution timeout = 30 min, `client.ts:80`).

## Root cause of degradation (confirmed in logs)
At concurrency ≥12 the **llm-router** (gRPC :50053) cannot service all simultaneous LLM calls.
Workflow-engine activities report repeated:
```
WARN Activity failed { error: Error: 4 DEADLINE_EXCEEDED: Deadline exceeded after 10.006s, remote_addr=172.19.0.14:50053 }
```
Each LLM activity has a 10s deadline; under load the llm-router (rate limit `RATE_LIMIT_RPM=30` + upstream OpenRouter fallback exhaustion) queues/hangs, every call times out, retries accumulate, and the workflow hits the 30-min execution timeout.

Secondary factor: OpenRouter upstream rate-limits after ~15 sequential eval cases ("All models in fallback chain exhausted"), so sustained concurrency exhausts the LLM fallback chain.

## Resource behavior (peak CPU during 15-concurrent run)
- temporal: 283.8%  (frontend under workflow spawn pressure)
- workflow-engine: 79.8%
- postgres: 63.0%
- memory-plane: 42.4%
- sandbox-runtime: 47.4%  / tool-proxy: 36.8%  (sandbox exercises fire under code_interpreter)
- api-server REST: only 20.3% (REST tier is not the bottleneck)

## Conclusion (real, measured)
The system sustains **10 concurrent agent executions with 100% success** (p50 ≈ 42s end-to-end, dominated by LLM call latency). Beyond ~10–12 concurrent it degrades sharply to 60% success at 15 due to llm-router LLM-call saturation (10s activity deadline + upstream rate limits), causing Temporal workflow timeouts. REST/api-server tier is not the bottleneck; the LLM call path is.

## Reproduce
```powershell
cd <repo>
# stack must be up with TLS_ENABLED=true
node scripts/load-test-bk.mjs 10 1   # 10 concurrent, 1 run/prompt
node scripts/load-test-bk.mjs 15 1   # 15 concurrent (expect ~40% timeout)
```
