# The Kubernetes of AI Agents

> **Production-grade orchestration for LLM-powered agents at scale.**

[![CI](https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/actions/workflows/ci.yml/badge.svg)](https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Why Another Agent Framework?

Most agent frameworks stop at "hello world" — a single agent calling a single LLM on your laptop. They don't solve the hard problems that matter in production:

- **Multi-tenancy** — How do 50 teams share one platform without stepping on each other?
- **Security** — How do you prevent one agent from reading another agent's secrets?
- **Cost control** — How do you stop a runaway agent from burning \$1,000 in API credits?
- **Reliability** — What happens when the LLM is down? When Postgres goes away?
- **Observability** — How do you trace a single agent request across 8 microservices?

**The Kubernetes of AI Agents** solves these — the same way Kubernetes solved container orchestration.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CONTROL PLANE                        │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │API Server│  │Secret Store  │  │Workflow Engine   │  │
│  │(Fastify) │  │(gRPC + AES) │  │(Temporal)        │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘  │
│       │               │                    │            │
├───────┼───────────────┼────────────────────┼────────────┤
│       │    EXECUTION PLANE                │            │
│  ┌────┴──────┐  ┌──────────┐  ┌───────────┴────────┐  │
│  │LLM Router │  │Tool Proxy│  │Sandbox Runtime     │  │
│  │(fallback, │  │(PII      │  │(Docker containers) │  │
│  │ circuit   │  │  scan)   │  │                    │  │
│  │ breaker)  │  │          │  │                    │  │
│  └───────────┘  └──────────┘  └────────────────────┘  │
│                        │                              │
├────────────────────────┼──────────────────────────────┤
│           DATA & MEMORY PLANE                         │
│  ┌───────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │Memory     │  │PostgreSQL  │  │Redis            │  │
│  │Plane      │  │(PgBouncer) │  │(Sentinel HA)    │  │
│  └───────────┘  └────────────┘  └─────────────────┘  │
├───────────────────────────────────────────────────────┤
│                  OBSERVABILITY PLANE                   │
│  ┌──────────┐  ┌──────────┐  ┌──────┐  ┌──────────┐ │
│  │Prometheus│  │Tempo     │  │Grafana│  │OTel      │ │
│  │(metrics) │  │(traces)  │  │(dash) │  │Collector │ │
│  └──────────┘  └──────────┘  └──────┘  └──────────┘ │
└───────────────────────────────────────────────────────┘
```

---

## Core Capabilities

### 🔒 Security (Production Defaults)
| Feature | Implementation |
|---------|---------------|
| **mTLS** | All gRPC services authenticate via mutual TLS |
| **Service mesh auth** | Every internal RPC carries a signed `x-service-token` |
| **Secrets at rest** | AES-256-GCM encryption via `EGAOP_MASTER_ENCRYPTION_KEY` |
| **CORS allowlist** | Only configured origins, no wildcards |
| **Rate limiting** | Per-namespace sliding window on API server + LLM router |
| **PII detection** | Regex-based scan on every tool call payload |

### ⚡ Reliability (Self-Healing)
| Feature | Implementation |
|---------|---------------|
| **LLM fallback chain** | `gpt-4o → gpt-4o-mini → gpt-3.5-turbo` with circuit breaker |
| **gRPC retry** | Exponential backoff with jitter (3 retries, 200ms base) |
| **Temporal retry policies** | Per-activity-type retry with non-retryable error classification |
| **Connection pooling** | PgBouncer (transaction mode, 25 conn pool) |
| **Redis HA** | Sentinel-based automatic failover |
| **Health checks** | Every service has liveness + readiness probes |

### 📊 Observability (3 Pillars)
| Pillar | Tool | What you get |
|--------|------|-------------|
| **Metrics** | Prometheus + Grafana | RED metrics per service, P50/P95/P99 latency, error rates |
| **Traces** | Tempo + OTel | Distributed traces across all 8 services with W3C context propagation |
| **Logs** | pino (structured JSON) | Correlatable logs with `traceId`, `namespace`, `service` fields |
| **Alerting** | Prometheus + Slack | 10 alert rules: high error rate, LLM cost budget, circuit breaker open |

### 💰 Cost Control
- Per-namespace daily token budgets (hard stop at `RESOURCE_EXHAUSTED`)
- Per-namespace daily cost budgets (USD cents)
- Per-minute RPM limits
- LLM cost budget alert at \$50/hr
- All tracked and visible in Grafana dashboards

### 🧪 Testing & Quality
- **259+ tests** across 10 workspaces (unit, integration, contract, chaos)
- **CI/CD** with GitHub Actions: audit → lint → typecheck → test → build
- **54 shared package tests** covering errors, namespaces, rate limiting, secrets
- **Eval suite** with golden dataset (89.5% task-success, 1.0 tool-selection accuracy)

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
├── control-plane/          # API Server, Workflow Engine, Secret Store
│   ├── api-server/         # Fastify REST + gRPC, JWT auth, rate limiting
│   ├── workflow-engine/    # Temporal workflows, activity retry policies
│   └── secret-store/       # AES-256-GCM encrypted secrets
├── execution-plane/        # LLM Router, Tool Proxy, Sandbox Runtime
│   ├── llm-router/         # Model fallback, circuit breaker, cost tracking
│   ├── tool-proxy/         # PII scanning, rate limiting per tool
│   └── sandbox-runtime/    # Docker container lifecycle management
├── memory-plane/           # Redis-backed state, monitoring, caching
├── observability-plane/    # Metrics ingestion, archiving, queries
├── policy-plane/           # OPA-based authorization policies
├── packages/shared/        # Shared types, interceptors, utilities
├── infrastructure/         # PgBouncer, Docker configs
├── secrets/                # Secret generation scripts
├── migrations/             # Postgres schema migrations
├── scripts/                # Backup, restore, maintenance
├── tests/                  # Cross-cutting integration tests
├── evals/                  # Golden dataset + eval runner
└── docs/                   # Architecture, benchmarks, runbooks
```

---

## Production Runbook

| Scenario | Action |
|----------|--------|
| **Postgres down** | Check disk space → check WAL archiving → restore from `/backup` |
| **LLM budget exceeded** | Identify namespace in Grafana → suspend namespace → review agent logs |
| **Circuit breaker open** | Check `llm-router` logs → verify OpenAI API key → monitor recovery |
| **Service not healthy** | `docker compose logs <service>` → check OTel traces in Tempo |
| **Restore from backup** | `./scripts/restore.sh /backup/egaop-backup-<date>.tar.gz` |

Backups run automatically every 6 hours via the `backup` Docker service (30-day retention).

---

## Benchmarks

| Metric | Value |
|--------|-------|
| P95 OPA policy evaluation | < 50ms |
| P99 end-to-end health check | < 100ms |
| Max throughput (single node) | 100+ RPM |
| Circuit breaker recovery | 30s (configurable) |

---

## License

MIT

---

Built with ❤️ for production AI.
