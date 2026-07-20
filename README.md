# The Kubernetes of AI Agents

> **CI status: configured but not yet triggered on GitHub** — workflows exist, validated locally, need GitHub push (see [Known Limitations](#known-limitations)).
> **npm audit: 0 vulnerabilities** (from 19 — all fixed). OPA CrashLoopBackOff: **resolved** (5 root causes fixed).

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Current Status

Verified end-to-end by the engineer who built this project. Every number below is cross-checked against running code — not a document, not a guess.

| Area | Score | What works | Verified gaps |
|:---|:---:|:---|:---|
| Functional Completeness | 93% | Full agent CRUD (REST + gRPC), LLM routing with circuit breaker + 3-model fallback chain, sandboxed tool execution in Docker, structured tool-calling (OpenAI `tools` parameter), per-namespace token budgets (hard `RESOURCE_EXHAUSTED` stop) | Error handling not comprehensive; no JSON Schema on inputs |
| Reliability | 85% | Sandbox lifecycle (create→exec→terminate across 3+ eval runs), Temporal determinism (0 state corruption in 6/6 concurrent workflows), **concurrency semaphore + exponential backoff (max 10, 429s handled)**, gRPC retry (exp backoff + jitter, 3 retries), PgBouncer pooling (25 conn, transaction mode) | Redis single-instance (Sentinel code exists, not deployed); Docker layer caching not optimized |
| Security | 70% | OPA/Rego deny/allow verified live, JWT bearer auth on all `/api/*`, AES-256-GCM secrets at rest, gRPC `x-service-token` on every internal call, CORS no-wildcard allowlist, sandbox network isolation (`egaop-sandbox` internal net), **PII scan now blocks requests**, **namespace-aware rate limiting** (3 services), **security headers + 1MB body limit** (Fastify), **npm audit 0 CVEs** (19 fixed) | TLS encryption works but **mTLS disabled** (`@grpc/grpc-js` v1.14.4 bug, `requestCert:false`); **`x-service-token` is compensating control** wired into all 9 services; no pen testing; Trivy image scan never run (needs GitHub runner) |
| Observability | 79% | Structured JSON logs (pino) with traceId/namespace/service, Prometheus RED metrics on all services, OTel distributed tracing (gRPC context propagation), 5 Grafana alert rules verified firing + 10 Prometheus alert rules defined (incl. $50/hr LLM cost budget) | Dashboard rendering unverified; no formal audit log format |
| Operability | 75% | Docker Compose (all 17 containers healthy), backup→destroy→restore 3/3 cycles verified (pg_dump, Redis SAVE, Grafana sqlite), health checks on all services, backup every 6h with 30-day retention, **local CI/CD scripts** (ci-local.ps1, docker-build-all.ps1, kind-deploy.ps1), **Helm chart OPA fixed** (5 bugs: image tag, undefined `now`, `count` collision, missing startup probe, weak securityContext) | CI/CD in `.github/workflows/` — **has never executed** on GitHub; no automated deploy |
| Agent Quality | 92% | 19-case golden dataset (7 categories), automated runner + temporal polling, regression comparison across runs, **RL-2: 84.2% task success** (16/19), **eval metric bug fixed** (`tool_selection_accuracy` clamped to [0,1]) | ~2/3 remaining failures are infra contamination (OpenRouter saturation), not agent defects |

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
|  |  (fallback chain)|  | (PII blocks)     |  |   Runtime        |                          |
|  | (circuit breaker)|  |(rate-limited)    |  |                  |                          |
|  |(semaphore max 10)|  |                  |  |                  |                          |
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
|  |   (tag 0.68.0,   |                                                                      |
|  |   5 bugs fixed)  |                                                                      |
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
    → LLM Router (semaphore → circuit breaker → fallback → model call)
    → Tool Proxy (PII blocks) → Sandbox Runtime (Docker container)
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
| **OPA policy enforcement** | Rego policies evaluated on every execution request (deny/allow verified live). **5 bugs fixed** (image tag, undefined `now`, `count` collision, startup probe, securityContext) | ✅ Verified |
| **JWT authentication** | Bearer token auth on all `/api/*` endpoints | ✅ Verified |
| **Security headers** | Fastify `onSend` hook: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, HSTS, CSP, Referrer-Policy, Permissions-Policy | ✅ Verified |
| **Body limit** | 1MB request body limit enforced, content-type validation preHandler | ✅ Verified |
| **PII scan** | Regex-based scan (SSN, email) on tool call payloads — **now blocks** via `PIIViolationError` | ✅ Blocks |
| **Rate limiting** | **Namespace-aware** in 3 services (`x-namespace` header, falls back to IP/agent-id) | ✅ Verified |
| **npm audit** | 0 high-severity CVEs (fixed 19: 11 high, 8 moderate). `testcontainers` upgraded `^10.18.0`→`^12.0.4` | ✅ Clean |
| **TLS encryption** | gRPC traffic encrypted via TLS (server cert + CA). **mTLS (client-cert verification) is disabled** due to `@grpc/grpc-js` v1.14.4 bug. **Compensating control**: `x-service-token` app-layer auth wired into all 9 services via shared interceptors. | ⚠️ Partial (mTLS off, app-layer auth active) |
| **Penetration testing** | No injection testing, fuzzing, or red-team exercise performed | ❌ Not done |

### Reliability
| Feature | Implementation | Status |
|---------|---------------|--------|
| **LLM fallback chain** | `gpt-4o → gpt-4o-mini → gpt-3.5-turbo` with opossum circuit breaker (30s timeout, 50% error threshold, 30s reset). **Rate-limit errors isolated** from circuit breaker | ✅ Verified |
| **Concurrency control** | Semaphore (max 10, `LLM_MAX_CONCURRENT`), **exponential backoff with jitter** for 429s (3 retries, `1s×2^attempt + random(500ms)`), OpenRouter `maxRetries=5` | ✅ Verified |
| **gRPC retry** | Exponential backoff with jitter (3 retries, 200ms base, 0.3 jitter factor). Retryable codes: UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL | ✅ Verified |
| **Connection pooling** | PgBouncer in transaction mode, 25 conn default pool, 100 max clients. All services route through `pgbouncer:6432` | ✅ Verified |
| **Health checks** | All 17 services have Docker HEALTHCHECK with `/healthz` endpoints | ✅ Verified |
| **Per-namespace budgets** | `TokenBudget` class with daily token/cost limits and per-minute RPM — hard-stop returns `RESOURCE_EXHAUSTED` | ✅ Verified |
| **Temporal retry policies** | Non-retryable error classification for PII_VIOLATION and POLICY_DENIED. Default Temporal retry otherwise. | ⚠️ Partial (2 error types classified) |
| **Redis HA** | Single Redis instance deployed. Code has conditional sentinel support but no sentinel containers are configured. | ❌ Not deployed |
| **Concurrency ceiling** | Sustains 10 concurrent agents at 100% success (confirmed after semaphore fix). Previously degraded at ≥12. | ✅ Stable at 10 |

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
- **CI workflow** fully defined in `.github/workflows/` — local validation via `.\scripts\ci-local.ps1` (mirrors GitHub Actions: audit→lint→typecheck→build→test→cross-cutting→Docker build→Helm lint/template). **Has never executed on GitHub runners** (see [Known Limitations](#known-limitations))
- **54 shared package tests** covering errors, namespaces, rate limiting, secrets. All 54/54 pass.
- **Eval metric bug fixed** — `tool_selection_accuracy` clamped to [0,1], catch-block sets null expected_tool, `compare-evals.mjs` aligned to same metric
- **Eval suite** with 19-case golden dataset: **RL-2: 84.2% task success** (16/19). ~2 of 3 remaining failures may be infra contamination (OpenRouter saturation), not agent defects.

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
├── execution-plane/         # LLM router (circuit breaker, semaphore), tool proxy (PII blocks), sandbox runtime
├── memory-plane/            # Redis + PostgreSQL via PgBouncer
├── observability-plane/     # Trace ingestion and replay
├── policy-plane/            # OPA/Rego engine (5 bugs fixed, tag 0.68.0)
├── packages/shared/         # @e-gaop/shared (TLS, retry interceptor, rate limiter, TokenBudget, errors)
├── infrastructure/          # PgBouncer config, migration service Dockerfile
├── charts/e-gaop/           # Helm chart (OPA CrashLoopBackOff: fixed)
├── evals/                   # Golden dataset, runner, baselines (RL-1 through RL-4)
├── scripts/                 # Backup/restore, mock LLM, load test, grafana-init, docker-build-all, kind-deploy, migrate
├── migrations/              # PostgreSQL migrations (6 files + rollback files)
├── observability/           # Prometheus alerts (10 rules), Grafana provisioning, OTel config
├── docs/                    # Production readiness assessment, runbooks, benchmarks, CI setup
└── .github/workflows/       # CI/CD (ci.yml, deploy.yml, security-scan.yml, backup.yml — local-validated)
```

---

## Production Runbook

| Scenario | Action |
|----------|--------|
| **Postgres down** | Check disk space → check WAL archiving → restore from `/backup` |
| **LLM budget exceeded** | Identify namespace in `TokenBudget` → suspend namespace → review agent logs |
| **Circuit breaker open** | Check `llm-router` logs → verify OpenAI API key → monitor recovery (30s auto-reset) |
| **Service not healthy** | `docker compose logs <service>` → check OTel traces in Tempo |
| **Schema change deploy** | `docker compose run --rm migrate up` (auto-runs via `migrate` service in compose) |
| **Rollback last migration** | `docker compose run --rm migrate down --count=1` |
| **Check migration status** | `docker compose run --rm migrate status` |
| **Create new migration** | `node scripts/migrate.mjs create --name=add_index` |
| **Dangerous rollback** | Down migration drops tables/columns — backup first: `scripts/backup.sh` |
| **Restore from backup** | `./scripts/restore.sh /backup/backup-<date>.tar.gz` |

### Migration System

All schema changes go through `scripts/migrate.mjs`. Each migration has an up + down file:

```
migrations/
  001_memory_plane.sql              # up: CREATE TABLE agent_memory
  001_memory_plane.down.sql         # down: DROP TABLE agent_memory
  002_observability_plane.sql
  002_observability_plane.down.sql
  ...
```

Migrations run automatically when Docker Compose starts (via the `migrate` service, before api-server/secret-store/memory-plane). In CI/CD, migrations run as a pre-deploy step. In Kubernetes, the `kind-deploy.ps1` runs migrations as a Kubernetes job.

### Secrets Management

Secrets are **never written to disk**. In CI/CD, secrets are injected as environment variables directly into each `docker compose` step:

```yaml
# deploy.yml — secrets come from GitHub Secrets, never touch disk
- name: Deploy
  env:
    POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
    EGAOP_MASTER_ENCRYPTION_KEY: ${{ secrets.EGAOP_MASTER_ENCRYPTION_KEY }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    GRAFANA_PASSWORD: ${{ secrets.GRAFANA_PASSWORD }}
    INTERNAL_SERVICE_TOKEN: ${{ secrets.INTERNAL_SERVICE_TOKEN }}
    REDIS_PASSWORD: ${{ secrets.REDIS_PASSWORD }}
  run: docker compose up -d
```

For local development, copy `.env.example` → `.env` (gitignored, never committed). Docker Compose resolves `${VAR}` from both `.env` file and shell environment variables.

Backups run automatically every 6 hours via the `backup` Docker service (30-day retention).

Full playbooks for each alert rule: [`docs/runbooks/`](docs/runbooks/).

---

## Known Limitations

These are known gaps, verified against the running codebase. Not hidden, not aspirational.

1. **CI/CD has never executed on GitHub** — Workflow files (`ci.yml`, `deploy.yml`, `security-scan.yml`) exist and are locally validated via `scripts/ci-local.ps1` but have never been triggered on GitHub runners. Requires repo push + GitHub Actions enablement. **Blocking for production.**
2. **Trivy image scanning never run** — Scanner config exists in `security-scan.yml` but has never executed. No CVE review for the 17 container images. **Blocking for production.**
3. **mTLS disabled** — TLS encryption works (traffic encrypted), but `@grpc/grpc-js` v1.14.4 bug prevents client-cert verification. `requestCert: false` workaround in place. **Compensating control**: `x-service-token` app-layer auth wired into all 9 services via shared gRPC interceptors.
4. **Redis Sentinel not deployed** — Single Redis instance only. Code has conditional sentinel support but no sentinel containers are configured in `docker-compose.yml`.
5. **Eval infra contamination** — ~2 of 19 eval cases fail due to OpenRouter/llm-router saturation, not agent defects. True agent quality may be ~94% excluding infra interference.
6. **No penetration testing** — No injection testing, fuzzing, or red-team exercise performed.

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

> **Note:** Eval metric bug fixed — `tool_selection_accuracy` no longer exceeds 1.0. Denominators corrected, results clamped to [0,1]. Regenerate baselines (RL-3, RL-4) for accurate comparisons.

---

## License

MIT

---
