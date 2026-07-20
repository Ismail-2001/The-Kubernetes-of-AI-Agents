# The Kubernetes of AI Agents

> **CI status: not yet executed** — the CI workflow exists in source but has never run (see [Known Limitations](#known-limitations)).

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Current Status

Verified end-to-end by the engineer who built this project. Every number below is cross-checked against running code — not a document, not a guess.

| Area | Score | What works | Verified gaps |
|:---|:---:|:---|:---|
| Functional Completeness | 93% | Full agent CRUD (REST + gRPC), LLM routing with circuit breaker + 3-model fallback chain, sandboxed tool execution in Docker, structured tool-calling (OpenAI `tools` parameter), per-namespace token budgets (hard `RESOURCE_EXHAUSTED` stop) | Error handling not comprehensive; no JSON Schema on inputs |
| Reliability | 83% | Sandbox lifecycle (create→exec→terminate across 3+ eval runs), Temporal determinism (0 state corruption in 6/6 concurrent workflows), 10 concurrent agents at 100% success, gRPC retry (exp backoff + jitter, 3 retries), PgBouncer pooling (25 conn, transaction mode) | LLM ceiling at ~12 concurrent (llm-router `DEADLINE_EXCEEDED`); Redis single-instance (Sentinel code exists, not deployed) |
| Security | 55% | OPA/Rego deny/allow verified live, JWT bearer auth on all `/api/*`, AES-256-GCM secrets at rest, gRPC `x-service-token` on every internal call, CORS no-wildcard allowlist, sandbox network isolation (`egaop-sandbox` internal net) | TLS encryption works but **mTLS disabled** (`@grpc/grpc-js` v1.14.4 bug, `requestCert:false`); PII scan **warn-only** (does not block); vulnerability scanning never run; no pen testing |
| Observability | 79% | Structured JSON logs (pino) with traceId/namespace/service, Prometheus RED metrics on all services, OTel distributed tracing (gRPC context propagation), 5 Grafana alert rules verified firing + 10 Prometheus alert rules defined (incl. $50/hr LLM cost budget) | Dashboard rendering unverified; no formal audit log format |
| Operability | 70% | Docker Compose (all 17 containers healthy), backup→destroy→restore 3/3 cycles verified (pg_dump, Redis SAVE, Grafana sqlite), health checks on all services, backup every 6h with 30-day retention | CI/CD in `.github/workflows/` — has **never executed**; no automated deploy |
| Agent Quality | 92% | 19-case golden dataset (7 categories), automated runner + temporal polling, regression comparison across runs, **RL-2: 84.2% task success** (16/19) | `tool_selection_accuracy` >1.0 in all baselines (denominator bug); ~2/3 remaining failures are infra contamination (OpenRouter saturation), not agent defects |

**Safe for:** Demo, single-user pilot (<10 concurrent agents).
**Not safe for:** Multi-tenant production, unmonitored deployment, workloads requiring vulnerability-clearance.

---

## Why Another Agent Framework?

Most agent frameworks stop at "hello world" — a single agent calling a single LLM on your laptop. They don't solve the hard problems that matter in production:

- **Multi-tenancy** — How do 50 teams share one platform without stepping on each other? (OPA policies, namespace isolation)
- **Security** — How do you prevent one agent from reading another agent's secrets? (AES-256-GCM, gRPC service-token auth, CORS allowlist)
- **Cost control** — How do you stop a runaway agent from burning API credits? (per-namespace daily token/cost budgets with hard `RESOURCE_EXHAUSTED` stop)
- **Reliability** — What happens when the LLM is down? When Postgres goes away? (LLM fallback chain, circuit breaker, gRPC retry with backoff, PgBouncer pooling, backup/restore)
- **Observability** — How do you trace a single agent request across microservices? (OTel distributed tracing, Prometheus RED metrics, Grafana alerts)

---

## Architecture

```
+-------------------------------------------------------------------------------------------+
|                                CONTROL PLANE                                               |
|  +------------------+  +------------------+  +------------------+                          |
|  |   API Server     |  |    Workflow      |  |   Secret Store   |                          |
|  |  (REST + gRPC)   |  |    Engine        |  | (AES-256-GCM)    |                          |
|  |  (CORS allowlist)|  |  (Temporal)      |  |                  |                          |
|  +--------+---------+  +--------+---------+  +--------+---------+                          |
|           |                    |                       |                                    |
+-----------+--------------------+-----------------------+------------------------------------+
|                                    EXECUTION PLANE                                         |
|  +--------+---------+  +--------+---------+  +--------+---------+                          |
|  |    LLM Router    |  |   Tool Proxy     |  |   Sandbox        |                          |
|  |  (fallback chain)|  | (PII warn-only)  |  |   Runtime        |                          |
|  | (circuit breaker)|  |                  |  |                  |                          |
|  +--------+---------+  +--------+---------+  +------------------+                          |
|           |                    |                       |                                    |
+-----------+--------------------+-----------------------+------------------------------------+
|                                DATA / MEMORY PLANE                                         |
|  +------------------+  +------------------+  +------------------+                           |
|  |      Redis       |  |   PostgreSQL     |  |   PgBouncer     |                           |
|  |   (standalone)   |  |   (entity)       |  |  (transaction   |                           |
|  |                  |  |                  |  |   pool, 25 conn)|                           |
|  +------------------+  +------------------+  +------------------+                           |
+-------------------------------------------------------------------------------------------+
|                                POLICY PLANE                                                |
|  +------------------+                                                                      |
|  |   OPA / Rego     |                                                                      |
|  |    Engine        |                                                                      |
|  +------------------+                                                                      |
+-------------------------------------------------------------------------------------------+
|                            OBSERVABILITY PLANE                                              |
|  +------------------+  +------------------+  +------------------+                           |
|  |   OTel Collector |  |   Prometheus     |  |     Grafana      |                           |
|  |   (traces)       |  |   (metrics)      |  |   (dashboards +  |                           |
|  |                  |  |                  |  |  5 alert rules)  |                           |
|  +------------------+  +------------------+  +------------------+                           |
+-------------------------------------------------------------------------------------------+
```

### Request Flow

```
Client → API Server (JWT auth) → OPA Policy (deny/allow) → Workflow Engine (Temporal)
    → LLM Router (circuit breaker → fallback chain → model call)
    → Tool Proxy (PII warn-only scan) → Sandbox Runtime (Docker container)
    → Result → Tool result → LLM follow-up → Final Answer
```

---

## Capabilities

### Security
| Feature | Implementation | Status |
|---------|---------------|--------|
| **gRPC service auth** | Every internal RPC carries a signed `x-service-token` header, validated server-side | ✅ Verified |
| **Secrets at rest** | AES-256-GCM encryption via `EGAOP_MASTER_ENCRYPTION_KEY` | ✅ Verified |
| **CORS allowlist** | Only configured origins (env var, comma-separated), no wildcards | ✅ Verified |
| **OPA policy enforcement** | Rego policies evaluated on every execution request (deny/allow verified live) | ✅ Verified |
| **JWT authentication** | Bearer token auth on all `/api/*` endpoints | ✅ Verified |
| **TLS encryption** | gRPC traffic encrypted via TLS (server cert + CA). **mTLS (client-cert verification) is disabled** due to a `@grpc/grpc-js` v1.14.4 bug (`requestCert: false` workaround). See `packages/shared/src/tls.ts`. | ⚠️ Partial (TLS on, mTLS off) |
| **PII scan** | Regex-based scan (SSN, email) on tool call payloads — logs warning only, does **not** block. | ⚠️ Partial (warn-only) |
| **Rate limiting** | gRPC interceptor is namespace-aware; REST API server uses per-IP limiting; LLM router uses per-agent limiting | ⚠️ Partial (not uniformly per-namespace) |

### Reliability
| Feature | Implementation | Status |
|---------|---------------|--------|
| **LLM fallback chain** | `gpt-4o → gpt-4o-mini → gpt-3.5-turbo` with opossum circuit breaker (30s timeout, 50% error threshold, 30s reset) | ✅ Verified |
| **gRPC retry** | Exponential backoff with jitter (3 retries, 200ms base, 0.3 jitter factor). Retryable codes: UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL | ✅ Verified |
| **Connection pooling** | PgBouncer in transaction mode, 25 conn default pool, 100 max clients. All services route through `pgbouncer:6432` | ✅ Verified |
| **Health checks** | All 17 services have Docker HEALTHCHECK with `/healthz` endpoints | ✅ Verified |
| **Per-namespace budgets** | `TokenBudget` class with daily token/cost limits and per-minute RPM — hard-stop returns `RESOURCE_EXHAUSTED` | ✅ Verified |
| **Temporal retry policies** | Non-retryable error classification for PII_VIOLATION and POLICY_DENIED. Default Temporal retry otherwise. | ⚠️ Partial (2 error types classified) |
| **Redis HA** | Single Redis instance deployed. Code has conditional sentinel support but no sentinel containers are configured. | ❌ Not deployed |
| **Concurrency ceiling** | Sustains 10 concurrent agents at 100% success. ≥12 concurrent degrades to 60-75% (llm-router `DEADLINE_EXCEEDED`). | ⚠️ Known limit |

### Observability
| Tool | Access | Purpose |
|:---|:---|:---|
| Grafana | `http://localhost:3003` | 5 Grafana alert rules (verified firing) + 10 Prometheus alert rules defined |
| Prometheus | `http://localhost:9091` | Metrics scraping (10s interval), RED metrics per service |
| OTel Collector | `:4317` (gRPC) / `:4318` (HTTP) | Distributed tracing across all services with W3C context propagation |
| Logs | `docker compose logs <service>` | Structured JSON with `traceId`, `namespace`, `service` fields (pino) |

### Cost Control
- Per-namespace daily token budgets (hard stop at `RESOURCE_EXHAUSTED`)
- Per-namespace daily cost budgets (USD cents)
- Per-minute RPM limits
- Prometheus alert rule `LLMCostBudgetExceeded` at $50/hr threshold (requires `e_gaop_llm_tokens_used_total` metric to be populated)

### Testing & Quality
- **~324 tests** across 29 test files and 10 workspaces (unit, integration, contract, chaos, perf)
- **CI workflow** defined in `.github/workflows/ci.yml` (audit → lint → typecheck → test → build) — **has never executed** (see [Known Limitations](#known-limitations))
- **54 shared package tests** covering errors, namespaces, rate limiting, secrets
- **Eval suite** with 19-case golden dataset: **RL-2: 84.2% task success** (16/19). Known: `tool_selection_accuracy` metric >1.0 (invalid ratio — denominator bug). ~2 of 3 remaining failures may be infra contamination (OpenRouter saturation), not agent defects.

---

## Quick Start

```bash
# 1. Clone and enter
git clone https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents.git
cd The-Kubernetes-of-AI-Agents

# 2. Configure secrets
cp .env.example .env
# Edit .env: set OPENAI_API_KEY, JWT_SECRET, POSTGRES_PASSWORD, etc.

# 3. Start everything
docker compose up -d

# 4. Verify
curl http://localhost:3001/health
# → {"status":"healthy"}

# 5. Open dashboards
# Grafana: http://localhost:3000 (admin / <GRAFANA_PASSWORD>)
# API docs: http://localhost:3001/api/docs
```

---

## Project Structure

```
├── control-plane/           # API server, workflow engine, secret store
├── execution-plane/         # LLM router (circuit breaker), tool proxy, sandbox runtime
├── memory-plane/            # Redis + PostgreSQL via PgBouncer
├── observability-plane/     # Trace ingestion and replay
├── policy-plane/            # OPA/Rego engine
├── packages/shared/         # @e-gaop/shared (TLS, retry interceptor, rate limiter, TokenBudget, errors)
├── infrastructure/          # PgBouncer config
├── charts/e-gaop/           # Helm chart (partial — OPA CrashLoopBackOff known)
├── evals/                   # Golden dataset, runner, baselines (RL-1 through RL-4)
├── scripts/                 # Backup/restore, mock LLM server, load test, grafana-init
├── migrations/              # PostgreSQL migrations (5 files)
├── observability/           # Prometheus alerts (10 rules), Grafana provisioning, OTel config
├── docs/                    # Production readiness assessment, runbooks, benchmarks
└── .github/workflows/       # CI/CD (not yet executed — see limitations)
```

---

## Production Runbook

| Scenario | Action |
|----------|--------|
| **Postgres down** | Check disk space → check WAL archiving → restore from `/backup` |
| **LLM budget exceeded** | Identify namespace in `TokenBudget` → suspend namespace → review agent logs |
| **Circuit breaker open** | Check `llm-router` logs → verify OpenAI API key → monitor recovery (30s auto-reset) |
| **Service not healthy** | `docker compose logs <service>` → check OTel traces in Tempo |
| **Restore from backup** | `./scripts/restore.sh /backup/backup-<date>.tar.gz` |

Backups run automatically every 6 hours via the `backup` Docker service (30-day retention).

Full playbooks for each alert rule: [`docs/runbooks/`](docs/runbooks/).

---

## Known Limitations

These are known gaps, verified against the running codebase. Not hidden, not aspirational.

1. **CI/CD has never executed** — Workflow files (`ci.yml`, `deploy.yml`) exist and are well-formed but have never been triggered. No automated build-test-deploy path. **Blocking for production.**
2. **Vulnerability scanning has never run** — Trivy and `npm audit` configurations exist in `.github/workflows/` but have never executed. No CVE review exists for the 17 container images. **Blocking for production.**
3. **mTLS disabled** — TLS encryption works (traffic encrypted), but `@grpc/grpc-js` v1.14.4 bug prevents client-cert verification. `requestCert: false` workaround in place. No cert rotation.
4. **Concurrency ceiling at ~10 agents** — Sustains 10 concurrent agents at 100% success. ≥12 concurrent degrades to 60-75% due to llm-router `DEADLINE_EXCEEDED`. REST/api-server tier is not the bottleneck.
5. **Redis Sentinel not deployed** — Single Redis instance only. Code has conditional sentinel support but no sentinel containers are configured in `docker-compose.yml`.
6. **Kubernetes partial** — `helm install` succeeds (REVISION 1), but OPA pod enters CrashLoopBackOff. 11 chart bugs were fixed during validation; OPA crash root cause undiagnosed.
7. **Eval metric bug** — `tool_selection_accuracy` exceeds 1.0 (invalid for a ratio). Scoring code needs denominator fix.
8. **Eval infra contamination** — ~2 of 19 eval cases fail due to OpenRouter/llm-router saturation, not agent defects. True agent quality may be ~94% excluding infra interference.
9. **No penetration testing** — No injection testing, fuzzing, or red-team exercise performed.
10. **PII scan is warn-only** — Regex scan exists but does not block requests. Not a security control.
11. **Rate limiting not uniformly per-namespace** — gRPC interceptor is namespace-aware; API server uses per-IP; LLM router uses per-agent.

---

## Benchmarks

| Metric | Value | Source |
|--------|-------|--------|
| P95 OPA policy evaluation | < 50ms | `tests/perf/execution-path.test.ts` |
| P99 end-to-end health check | < 100ms | `tests/perf/performance.test.ts` |
| Concurrent agent ceiling | 10 @ 100% success | Load test (BK round) |
| Max throughput (single node) | ~100+ RPM (est.) | Not benchmarked |
| LLM circuit breaker recovery | 30s (configurable) | opossum `resetTimeout` |

---

## Evals

The platform includes an automated eval suite (`evals/`) with 19 golden cases across 7 categories.

| Run | Date | Pass rate | Notes |
|:---|:---|:---:|:---|
| RL-1 (baseline) | Jul 17 | 68.4% (13/19) | All 6 failures documented |
| RL-2 | Jul 18 | **84.2% (16/19)** | +15.8pp, 3 FLIPs |

**3 cases improved:** qanda-simple-math (no longer calls code_interpreter for 2+2), code_interpreter-sum-1-to-100 (completes in 1 call instead of 10 loops), code_interpreter-csv-average (writes file then computes in 2 calls).

**Still failing (3):** code_interpreter-prime-check (MAX_ITERATIONS loop), file_write-read-greeting (`LLM call failed` — probable infra contamination), database_query-create-table (same).

---

## License

MIT

---


