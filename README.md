<p align="center">
  <img src="https://img.shields.io/badge/Status-77.6%25_Readiness-yellow?style=for-the-badge" alt="Readiness" />
  <img src="https://img.shields.io/badge/License-Apache--2.0-green?style=for-the-badge" alt="License" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Temporal-1.11-orange?style=for-the-badge" alt="Temporal" />
</p>

<h1 align="center">E-GAOP</h1>

<h3 align="center">Enterprise-Grade Agent Orchestration Platform</h3>

<p align="center">
  <em>Agent lifecycle management with OPA-governed execution, sandboxed tool runtime, Temporal-backed workflows, and full-stack observability.</em>
</p>

<p align="center">
  <a href="#current-status">Status</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#api-reference">API</a> •
  <a href="#observability">Observability</a> •
  <a href="#known-limitations">Known Limitations</a>
</p>

---

## Current Status

**Readiness score: 77.6%** (weighted, 53 items across 7 categories).
Full assessment: [`docs/production-readiness-final.md`](docs/production-readiness-final.md).

| Area | Score | What works | What's missing |
|:---|:---:|:---|:---|
| Functional Completeness | 93% | Full agent CRUD, LLM routing, sandboxed tool execution, structured tool-calling, natural-language tool triggering | Error handling not comprehensive; no input schema enforcement |
| Reliability | 83% | Sandbox lifecycle, Temporal determinism, concurrent isolation (10 agents at 100%), load-tested timeout handling | No circuit breaker for LLM calls; manual recovery path untested |
| Security | 55% | OPA enforcement, JWT auth, sandbox network isolation, encrypted secrets in Postgres | Vulnerability scanning never run; CI/CD never executed; mTLS disabled; no penetration testing |
| Observability | 79% | JSON logging, Prometheus metrics, OTEL tracing, Grafana alerts (5 rules, verified firing) | Dashboard rendering unverified; no formal audit log format |
| Operability | 70% | Docker Compose deployment, backup/restore (3/3 cycles verified), health checks on all 17 services | CI/CD pipeline exists in source but has never executed |
| Agent Quality (Evals) | 92% | 19-case golden dataset, automated runner, regression comparison, RL-2 at 84.2% task success | Metric bug: `tool_selection_accuracy` >1.0 invalid; ~2 failures contaminated by LLM saturation |

**Safe for:** Demo, single-user pilot (<10 concurrent agents).
**Not safe for:** Multi-tenant production, unmonitored deployment, workloads requiring vulnerability-clearance.

---

## Quick Start

> **Note:** These instructions match the repo's `docker-compose.yml` and API structures but have
> not been re-run end-to-end against the current commit. The Docker daemon was in a wedged state
> at the end of the last validation round. If you encounter issues, please file a bug.

### Prerequisites

- **Node.js** 20+
- **Docker** 24+ with Compose v2
- **Git**

### Setup

```bash
git clone https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents.git
cd The-Kubernetes-of-AI-Agents

# Generate secrets
openssl rand -hex 32 > .env   # EGAOP_MASTER_ENCRYPTION_KEY
openssl rand -base64 48 >> .env  # JWT_SECRET
openssl rand -hex 16 >> .env  # POSTGRES_PASSWORD

# Start all 17 services
docker compose up -d

# Verify all services are healthy
docker compose ps
```

### Run an Agent

```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@egaop.io","password":"..."}' | jq -r '.data.token')

# Create an agent
curl -X POST http://localhost:3001/api/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo-agent","namespace":"default","spec":{"model":"openai/gpt-4o"}}'

# Run it
curl -X POST http://localhost:3001/api/agents/demo-agent/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace":"default"}'
```

---

## Architecture

E-GAOP decomposes into five planes, each independently scalable:

```
+-------------------------------------------------------------------------------------------+
|                                CONTROL PLANE                                               |
|  +------------------+  +------------------+  +------------------+  +------------+          |
|  |   API Server     |  |    Workflow      |  |   Secret Store   |  | Namespace  |          |
|  |  (REST + gRPC)   |  |    Engine        |  | (AES-256-GCM)    |  | Manager    |          |
|  +--------+---------+  +--------+---------+  +--------+---------+  +------------+          |
|           |                    |                       |                                    |
+-----------+--------------------+-----------------------+------------------------------------+
|                                    EXECUTION PLANE                                         |
|  +--------+---------+  +--------+---------+  +--------+---------+                          |
|  |    LLM Router    |  |   Tool Proxy     |  |   Sandbox        |                          |
|  |  (fallback chain)|  |                  |  |   Runtime        |                          |
|  +--------+---------+  +------------------+  +------------------+                          |
|           |                                                                                 |
+-----------+--------------------+-----------------------------------------------------------+
|             egaop-sandbox (internal network, no internet)                                   |
|           |                                                                                 |
|  +--------+---------+  Agent containers: LLM router only. No postgres/temporal/OPA.        |
|  |    Sandbox       |  Docker network isolation (Level 1). gVisor/runsc not installed.     |
|  |    Containers    |                                                                      |
|  +------------------+                                                                      |
+-------------------------------------------------------------------------------------------+
|                                MEMORY PLANE                                                |
|  +------------------+  +------------------+                                                 |
|  |      Redis       |  |   PostgreSQL     |                                                 |
|  |    (working)     |  |   (entity)       |                                                 |
|  +------------------+  +------------------+                                                 |
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
|  |                  |  |                  |  |   5 alert rules)  |                           |
|  +------------------+  +------------------+  +------------------+                           |
+-------------------------------------------------------------------------------------------+
```

### Request Flow

```
Client → API Server (JWT auth) → OPA Policy (deny/allow) → Workflow Engine (Temporal)
    → LLM Router (model call) → Tool Proxy → Sandbox Runtime (Docker container)
    → Result → Tool result → LLM follow-up → Final Answer
```

---

## API Reference

### REST API (BFF)

| Method | Endpoint | Description |
|:---|:---|:---|
| `POST` | `/api/auth/register` | Register new user |
| `POST` | `/api/auth/login` | Authenticate, return JWT |
| `GET` | `/api/agents` | List agents (paginated) |
| `POST` | `/api/agents` | Create agent |
| `GET` | `/api/agents/:id` | Get agent details |
| `DELETE` | `/api/agents/:id` | Delete agent |
| `POST` | `/api/agents/:id/run` | Trigger Temporal workflow |
| `GET` | `/api/executions/:id` | Execution status from Temporal |
| `GET` | `/api/executions/:id/history` | Full Temporal event history |

### gRPC Services

All inter-service communication uses gRPC with Protocol Buffers (`api/proto/egaop/v1/`).

| Service | Primary RPC | Port |
|:---|:---|:---:|
| `AgentService` | CreateAgent / GetAgent / ListAgents / DeleteAgent | 50051 |
| `LLMService` | Generate (with `tool_calls` support) | 50053 |
| `ToolService` | CallTool | 50052 |
| `RuntimeService` | CreateSandbox / TerminateSandbox / GetSandboxStatus | 50054 |
| `ObservabilityService` | ExportTrace / GetExecutionReplay | 50056 |

---

## Observability

| Tool | Access | Purpose |
|:---|:---|:---|
| Grafana | `http://localhost:3003/grafana` | Dashboards + 5 alert rules (ServiceDown, HighErrorRate, HighLatencyP95, HighLatencyP99, MetricsDropping) |
| Prometheus | `http://localhost:9091` | Metrics scraping (10s interval) |
| OTel Collector | `:4317` (gRPC) / `:4318` (HTTP) | Distributed tracing across all services |

---

## Evals

The platform includes an automated eval suite (`evals/`) with 19 golden cases across 7 categories.

| Run | Date | Pass rate | Notes |
|:---|:---|:---:|:---|
| RL-1 (baseline) | Jul 17 | 68.4% (13/19) | All 6 failures documented |
| RL-2 | Jul 18 | **84.2% (16/19)** | +15.8pp, 3 FLIPs |

**3 cases improved:** qanda-simple-math (no longer calls code_interpreter for 2+2), code_interpreter-sum-1-to-100 (completes in 1 call instead of 10 loops), code_interpreter-csv-average (writes file then computes in 2 calls).

**Still failing (3):** code_interpreter-prime-check (MAX_ITERATIONS loop), file_write-read-greeting (`LLM call failed` — probable infra contamination), database_query-create-table (same).

> **Note:** ~2 of the 3 remaining failures show `LLM call failed: Activity task failed`, which matches OpenRouter rate-limit saturation after ~15 sequential calls. The true agent quality pass rate excluding infra interference may be ~94%. The `tool_selection_accuracy` metric has a known denominator bug (values >1.0).

Full details: [`docs/production-readiness-final.md`](docs/production-readiness-final.md) (Eval regression section).

---

## Known Limitations

These are documented gaps, not hidden ones. Full list in the [readiness assessment](docs/production-readiness-final.md#known-gaps-final).

1. **Vulnerability scanning has never run** — Trivy and `npm audit` configurations exist in `.github/workflows/` but have never executed. No CVE review exists for the 17 container images. **Blocking for production.**
2. **CI/CD has never executed** — Workflow files (`ci.yml`, `deploy.yml`) exist and are well-formed but have never been triggered. No automated build-test-deploy path. **Blocking for production.**
3. **Concurrency ceiling at ~10 agents** — Sustains 10 concurrent agents at 100% success. ≥12 concurrent degrades to 60-75% due to llm-router `DEADLINE_EXCEEDED`. REST/api-server tier is not the bottleneck.
4. **Kubernetes partial** — `helm install` succeeds (REVISION 1), but OPA pod enters CrashLoopBackOff. 11 chart bugs were fixed during validation; OPA crash root cause undiagnosed.
5. **mTLS disabled** — TLS encryption works (traffic encrypted), but `@grpc/grpc-js` v1.14.4 bug prevents client-cert verification. `requestCert: false` workaround in place. No cert rotation.
6. **Eval metric bug** — `tool_selection_accuracy` exceeds 1.0 (invalid for a ratio). Scoring code needs denominator fix.
7. **No penetration testing** — No injection testing, fuzzing, or red-team exercise performed.

---

## Services

### Core (9 services)

| Service | Port(s) | Protocol | Description |
|:---|:---:|:---:|:---|
| **api-server** | 50051 / 3001 | gRPC / REST | Central API, auth, agent CRUD |
| **workflow-engine** | — | Temporal Worker | ReAct loop, HITL gates, quota enforcement |
| **llm-router** | 50053 | gRPC | Multi-model routing (OpenAI / OpenRouter fallback) |
| **tool-proxy** | 50052 | gRPC | Proxied tool execution |
| **sandbox-runtime** | 50054 | gRPC | Docker container lifecycle on `egaop-sandbox` |
| **memory-plane** | 50055 | gRPC | Redis + PostgreSQL |
| **observability-plane** | 50056 | gRPC | Trace ingestion and replay |
| **secret-store** | 50057 | gRPC | AES-256-GCM encrypted secrets (Postgres-backed) |
| **policy-plane** | 50059 | HTTP | OPA/Rego policy evaluation |

### Infrastructure

| Component | Port | Purpose |
|:---|:---:|:---|
| PostgreSQL 15 | 5432 | Entity storage, auth, secrets |
| Redis 7 | 6379 | Quota counters, session cache |
| Temporal | 7233 | Durable workflow execution |
| OPA | 8181 | Policy-as-code sidecar |
| OTel Collector | 4317 / 4318 | Trace/metric collection |
| Prometheus | 9090 | Metrics storage |
| Grafana | 3000 | Dashboards + alerting |
| Docker Socket Proxy | 2375 | Scoped Docker API (containers only, no volumes/networks) |

### Docker Networks

| Network | Purpose |
|:---|:---|
| `egaop-net` | Inter-service communication (all services) |
| `egaop-sandbox` | Sandbox isolation (LLM router + sandbox containers only, no internet) |

---

## Configuration

| Variable | Required | Default | Description |
|:---|:---:|:---:|:---|
| `OPENAI_API_KEY` | Yes | — | LLM API key (OpenAI or OpenRouter) |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | LLM base URL |
| `EGAOP_MASTER_ENCRYPTION_KEY` | Yes | — | Secret-store master key (64 hex chars) |
| `JWT_SECRET` | Yes | — | JWT signing secret (min 32 chars) |
| `POSTGRES_PASSWORD` | Yes | — | PostgreSQL password |
| `GRAFANA_PASSWORD` | Yes | — | Grafana admin password |
| `TLS_ENABLED` | No | `false` | Enable TLS for gRPC |

---

## Project Structure

```
├── control-plane/           # API server, workflow engine, secret store
├── execution-plane/         # LLM router, tool proxy, sandbox runtime
├── memory-plane/            # Redis + PostgreSQL
├── observability-plane/     # Trace ingestion
├── policy-plane/            # OPA/Rego engine
├── packages/shared/         # @e-gaop/shared (TLS, quotas, telemetry)
├── charts/e-gaop/           # Helm chart (partial — OPA CrashLoopBackOff known)
├── evals/                   # Golden dataset, runner, baselines
├── scripts/                 # Backup/restore, load test, drift detection, grafana-init
├── prs/                     # PR descriptions documenting all changes
├── migrations/              # PostgreSQL migrations (5 files)
├── observability/           # Prometheus, Grafana, OTel config
├── docs/                    # Production readiness assessment, architecture notes
└── .github/workflows/       # CI/CD (not yet executed — see limitations)
```

---

## Roadmap

Next steps identified from the readiness assessment, not aspirational features:

1. **Execute CI pipeline** — Trigger a real run of `ci.yml` to verify lint, typecheck, tests, and Docker builds pass.
2. **Vulnerability scanning** — Run Trivy against all 17 container images, review findings, establish CVE triage process.
3. **llm-router scaling** — Add retry/backoff for LLM calls to raise ceiling past 10 concurrent agents.
4. **Fix K8s OPA crash** — Diagnose OPA CrashLoopBackOff and produce a working `helm install` with running pods.
5. **Fix eval metric** — Correct `tool_selection_accuracy` denominator to produce valid ratio.

---

## License

[Apache License 2.0](LICENSE)

---

<p align="center">
  <em>Readiness assessment: <a href="docs/production-readiness-final.md">docs/production-readiness-final.md</a></em>
</p>
