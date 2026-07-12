<p align="center">
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents">
    <img src="https://img.shields.io/badge/E--GAOP-v0.6.0-blue?style=for-the-badge" alt="Version" />
  </a>
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache--2.0-green?style=for-the-badge" alt="License" />
  </a>
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents">
    <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript" alt="TypeScript" />
  </a>
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents">
    <img src="https://img.shields.io/badge/gRPC-1.14-green?style=for-the-badge&logo=grpc" alt="gRPC" />
  </a>
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents">
    <img src="https://img.shields.io/badge/Temporal-1.11-orange?style=for-the-badge" alt="Temporal" />
  </a>
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents">
    <img src="https://img.shields.io/badge/PostgreSQL-15-blue?style=for-the-badge&logo=postgresql" alt="PostgreSQL" />
  </a>
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents">
    <img src="https://img.shields.io/badge/OTel-Collector-black?style=for-the-badge&logo=opentelemetry" alt="OpenTelemetry" />
  </a>
</p>

<h1 align="center">
  <br>
  E-GAOP
  <br>
</h1>

<h3 align="center">The Operating System for Enterprise AI Agents</h3>

<p align="center">
  <em>Production-grade orchestration for autonomous AI agents with kernel-level isolation, durable execution, and real-time governance.</em>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#api-reference">API</a> •
  <a href="#security">Security</a> •
  <a href="#observability">Observability</a> •
  <a href="#deployment">Deployment</a>
</p>

---

## Executive Summary

**E-GAOP** (Enterprise-Grade Agent Orchestration Platform) is the infrastructure layer that transforms fragile AI agent prototypes into resilient, auditable, and scalable enterprise systems.

### The Problem

Enterprise AI teams face a critical gap: **LLM capabilities are advancing faster than the infrastructure to deploy them safely.** Current agent frameworks offer no isolation, no durability, no governance, and no observability — making them unsuitable for production workloads handling sensitive data or mission-critical operations.

### Our Solution

E-GAOP provides the **missing operating system** for AI agents:

| Capability | What E-GAOP Delivers | Business Impact |
|:---|:---|:---|
| **Isolation** | Kernel-level sandboxing per agent on dedicated Docker network | Zero cross-contamination between workloads |
| **Durability** | Temporal-backed execution with replay | Agents survive crashes, restarts, and upgrades |
| **Governance** | OPA/Rego policy engine with real-time enforcement | Compliance with SOC 2, HIPAA, GDPR out-of-the-box |
| **Observability** | Full OpenTelemetry stack with distributed tracing | Debug 10x faster, reduce MTTR by 75% |
| **Multi-tenancy** | Namespace isolation with tier-based quotas | Run agents for multiple teams without conflicts |
| **Security** | Dynamic secrets, mTLS, append-only audit logs | Zero-trust architecture for sensitive workloads |

---

## Architecture

E-GAOP decomposes into **five decoupled planes**, each independently scalable:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CONTROL PLANE                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │   API Server │  │   Workflow   │  │ Secret Store │  │  Namespace │ │
│  │  (REST+gRPC) │  │   Engine     │  │ (AES-256-GCM)│  │  Manager   │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                 │                │         │
├─────────┼─────────────────┼─────────────────┼────────────────┼─────────┤
│                          EXECUTION PLANE                                │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌─────┴────────┐                   │
│  │  LLM Router  │  │  Tool Proxy  │  │   Sandbox    │                   │
│  │  (Fallback)  │  │  (PII Scan)  │  │   Runtime    │                   │
│  └──────┬───────┘  └──────────────┘  └──────────────┘                   │
│         │                                                                │
├─────────┼────────────────────────────────────────────────────────────────┤
│                     egaop-sandbox (internal network)                     │
│         │                                                                │
│  ┌──────┴───────┐                                                        │
│  │   Sandbox    │  ← Agent containers run here (no internet access)     │
│  │  Containers  │  ← Can ONLY reach LLM Router for model inference     │
│  └──────────────┘  ← CANNOT reach postgres, temporal, redis, or OPA    │
├─────────────────────────────────────────────────────────────────────────┤
│                          MEMORY PLANE                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │    Redis     │  │  PostgreSQL  │  │   pgvector   │                   │
│  │  (Working)   │  │  (Entity)    │  │  (Semantic)  │                   │
│  └──────────────┘  └──────────────┘  └──────────────┘                   │
├─────────────────────────────────────────────────────────────────────────┤
│                          POLICY PLANE                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │  OPA / Rego  │  │     PII      │  │   Circuit    │                   │
│  │   Engine     │  │  Detection   │  │   Breaker    │                   │
│  └──────────────┘  └──────────────┘  └──────────────┘                   │
├─────────────────────────────────────────────────────────────────────────┤
│                       OBSERVABILITY PLANE                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │  OTel        │  │  Prometheus  │  │   Grafana    │                   │
│  │  Collector   │  │  Metrics     │  │  Dashboards  │                   │
│  └──────────────┘  └──────────────┘  └──────────────┘                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Request Flow

```
Client Request
    │
    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  API Server │────▶│  OPA Policy │────▶│  Workflow   │
│  (Auth+JWT) │     │  Engine     │     │  Engine     │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┘
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
┌────────┐    ┌──────────┐    ┌──────────┐
│  LLM   │    │  Tool    │    │  Memory  │
│ Router │    │  Proxy   │    │  Plane   │
└────┬───┘    └──────────┘    └──────────┘
     │
     ▼
┌──────────────┐
│   Sandbox    │  ← Isolated on egaop-sandbox network
│  Container   │  ← Docker namespace isolation (Level 1)
└──────────────┘  ← gVisor available when runsc installed (Level 2)
```

---

## Quick Start

### Prerequisites

- **Node.js** 20+
- **Docker** 24+ with Compose v2
- **Git**

### One-Command Setup

```bash
git clone https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents.git
cd The-Kubernetes-of-AI-Agents

# Generate secrets (or copy .env.example)
openssl rand -hex 32 > .env   # EGAOP_MASTER_ENCRYPTION_KEY
openssl rand -base64 48 >> .env  # JWT_SECRET
openssl rand -hex 16 >> .env  # POSTGRES_PASSWORD

# Start all 17 services
docker compose up -d

# Verify all services are healthy
docker compose ps
```

### Verify Health

```bash
# API Server (REST BFF)
curl http://localhost:3001/health

# Admin Console
open http://localhost:3002

# Grafana Dashboard
open http://localhost:3003/grafana

# Prometheus Metrics
open http://localhost:9091
```

### Run Your First Agent

```bash
# Register a user
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"admin@egaop.io","password":"SecurePass123!"}'

# Login (use the token from response)
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@egaop.io","password":"SecurePass123!"}' | jq -r '.data.token')

# Create an agent
curl -X POST http://localhost:3001/api/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","namespace":"default","spec":{"model":"openai/gpt-4o"}}'

# Run the agent
curl -X POST http://localhost:3001/api/agents/my-agent/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace":"default","callerRole":"namespace_admin"}'

# Check execution status
curl http://localhost:3001/api/executions/agent-exec-<id> \
  -H "Authorization: Bearer $TOKEN"
```

---

## API Reference

### REST API (BFF)

| Method | Endpoint | Description |
|:---|:---|:---|
| `POST` | `/api/auth/register` | Register new user |
| `POST` | `/api/auth/login` | Authenticate user, return JWT |
| `GET` | `/api/auth/me` | Get current user info |
| `GET` | `/api/agents` | List all agents (paginated) |
| `POST` | `/api/agents` | Create new agent |
| `GET` | `/api/agents/:id` | Get agent details |
| `DELETE` | `/api/agents/:id` | Delete agent |
| `POST` | `/api/agents/:id/run` | Trigger agent workflow (starts Temporal execution) |
| `GET` | `/api/namespaces` | List all namespaces |
| `GET` | `/api/traces` | List execution traces (real Temporal data) |
| `GET` | `/api/traces/:traceId` | Get trace details with spans |
| `GET` | `/api/executions/:id` | Get execution status from Temporal |
| `GET` | `/api/executions/:id/history` | Get full Temporal event history |
| `GET` | `/api/metrics` | Get platform metrics (real-time) |
| `GET` | `/api/events` | SSE stream for real-time events |

### gRPC Services

All inter-service communication uses **gRPC with Protocol Buffers**.

```protobuf
// Agent lifecycle management
service AgentService {
  rpc CreateAgent(CreateAgentRequest) returns (Agent);
  rpc GetAgent(GetAgentRequest) returns (Agent);
  rpc ListAgents(ListAgentsRequest) returns (ListAgentsResponse);
  rpc UpdateAgent(UpdateAgentRequest) returns (Agent);
  rpc DeleteAgent(DeleteAgentRequest) returns (google.protobuf.Empty);
}

// Multi-tenant namespace management
service NamespaceService {
  rpc CreateNamespace(CreateNamespaceRequest) returns (Namespace);
  rpc GetNamespace(GetNamespaceRequest) returns (Namespace);
  rpc ListNamespaces(ListNamespacesRequest) returns (ListNamespacesResponse);
  rpc SuspendNamespace(SuspendNamespaceRequest) returns (Namespace);
  rpc DeleteNamespace(DeleteNamespaceRequest) returns (google.protobuf.Empty);
}

// LLM routing and generation
service LLMService {
  rpc Generate(GenerateRequest) returns (GenerateResponse);
}

// Tool execution proxy
service ToolService {
  rpc CallTool(CallToolRequest) returns (CallToolResponse);
}

// Sandbox lifecycle
service RuntimeService {
  rpc CreateSandbox(CreateSandboxRequest) returns (Sandbox);
  rpc TerminateSandbox(TerminateSandboxRequest) returns (TerminateSandboxResponse);
  rpc GetSandboxStatus(GetSandboxStatusRequest) returns (SandboxStatus);
}

// Trace ingestion and replay
service ObservabilityService {
  rpc ExportTrace(ExportTraceRequest) returns (ExportTraceResponse);
  rpc GetExecutionReplay(GetExecutionReplayRequest) returns (ExecutionReplay);
}
```

---

## Security

### Zero-Trust Architecture

E-GAOP implements defense-in-depth security:

1. **Sandbox Network Isolation** — Agent containers run on `egaop-sandbox` (internal Docker network, no internet). They can ONLY reach the LLM router for model inference. Cannot reach postgres, temporal, redis, OPA, or any control-plane service.

2. **mTLS Everywhere** — All gRPC communication encrypted and authenticated.

3. **Dynamic Secret Injection** — Secrets injected per-execution, never stored in agent memory.

4. **OPA Policy Engine** — Every request evaluated against Rego policies before execution. Supports namespace-based access control with role clearance mapping.

5. **Append-Only Audit Log** — Immutable record of all agent actions for compliance.

6. **Namespace Isolation** — Data, memory, and quotas strictly partitioned by namespace.

7. **PII Detection** — Automatic detection and redaction of sensitive data in tool outputs.

### Sandbox Isolation Levels

| Level | Technology | Requirement | Security Boundary |
|:---|:---|:---|:---|
| **Level 1** (default) | Docker namespaces | Docker | Process isolation, network isolation via `egaop-sandbox` |
| **Level 2** | gVisor (runsc) | `runsc` installed | Kernel-level syscall filtering |
| **Level 3** | Firecracker microVM | Firecracker | Hardware-level isolation |

### Compliance Readiness

| Standard | E-GAOP Coverage |
|:---|:---|
| **SOC 2** | Audit trails, access controls, encryption at rest/transit |
| **HIPAA** | PII detection, namespace isolation, audit logging |
| **GDPR** | Data residency controls, right-to-deletion support |
| **ISO 27001** | Policy enforcement, access monitoring, incident response |

---

## Observability

### Full-Stack Visibility

E-GAOP ships with a production-ready observability stack:

| Layer | Tool | Purpose |
|:---|:---|:---|
| **Traces** | OpenTelemetry → OTel Collector | Distributed tracing across all services |
| **Metrics** | Prometheus | 35+ unique metric names with 10s scrape interval |
| **Dashboards** | Grafana | 20 pre-built panels with namespace filtering |
| **Alerts** | Prometheus AlertManager | 5 alert rules (error rate, latency, circuit breaker) |

### Key Metrics

```
# Request metrics
http_server_duration_seconds     # Request latency by service
http_client_duration_seconds     # Outbound call latency
http_requests_total              # Request count by status

# OTel pipeline
otelcol_received_spans_total     # Spans received by collector
otelcol_exported_spans_total     # Spans exported to backend

# Infrastructure
db_client_connections_active     # Database connection pool
container_cpu_usage_seconds_total  # Container CPU usage
```

### Access Points

| Tool | URL | Credentials |
|:---|:---|:---|
| Grafana | `http://localhost:3003/grafana` | `admin` / `GRAFANA_PASSWORD` from `.env` |
| Prometheus | `http://localhost:9091` | — |
| OTel zpages | `http://localhost:8888` | — |

---

## Services

### Core Services

| Service | Port | Protocol | Health Port | Description |
|:---|:---:|:---:|:---:|:---|
| **api-server** | `50051`/`3001` | gRPC/REST | `15051` | Central API, auth, REST BFF |
| **workflow-engine** | — | Temporal | `15058` | Durable agent execution: ReAct loops, HITL gates |
| **llm-router** | `50053` | gRPC | `15053` | Multi-model routing with OpenRouter/OpenAI fallback |
| **tool-proxy** | `50052` | gRPC | `15052` | Proxied tool execution with PII scanning |
| **sandbox-runtime** | `50054` | gRPC | `15054` | Docker container provisioning on `egaop-sandbox` |
| **memory-plane** | `50055` | gRPC | `15055` | Redis + PostgreSQL + pgvector |
| **observability-plane** | `50056` | gRPC | `15056` | Trace ingestion and replay |
| **secret-store** | `50057` | gRPC | `15057` | AES-256-GCM encrypted secret vault |
| **policy-plane** | `50059` | HTTP | — | OPA/Rego policy evaluation |

### Infrastructure

| Component | Port | Purpose |
|:---|:---:|:---|
| PostgreSQL 15 | `5432` | Entity memory, namespaces, audit log, pgvector |
| Redis 7 | `6379` | Working memory, quota counters, session cache |
| Temporal | `7233` | Durable workflow execution with PostgreSQL backend |
| OPA | `8181` | Policy-as-code sidecar |
| OTel Collector | `4317`/`4318` | Trace/metrics collection and export |
| Prometheus | `9090` | Metrics scraping and alerting |
| Grafana | `3000` | Dashboard visualization |
| Docker Socket Proxy | `2375` | Sandboxed Docker API access (POST/START/STOP only) |

### Docker Networks

| Network | Driver | Purpose |
|:---|:---|:---|
| `egaop-net` | bridge | Inter-service communication (all services) |
| `egaop-sandbox` | bridge (internal) | Sandbox isolation (LLM router + sandbox containers only) |

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|:---|:---:|:---:|:---|
| `OPENAI_API_KEY` | Yes | — | API key for LLM routing (OpenAI or OpenRouter) |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | LLM API base URL (set to `https://openrouter.ai/api/v1` for OpenRouter) |
| `EGAOP_MASTER_ENCRYPTION_KEY` | Yes | — | Master key for secret-store encryption (64 hex chars) |
| `JWT_SECRET` | Yes | — | JWT signing secret (min 32 chars) |
| `POSTGRES_PASSWORD` | Yes | — | PostgreSQL password |
| `GRAFANA_PASSWORD` | Yes | — | Grafana admin password |
| `TLS_ENABLED` | No | `false` | Enable mTLS for all gRPC services |
| `TEMPORAL_NAMESPACE` | No | `egaop` | Temporal namespace for workflows |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://otel-collector:4318` | OTel Collector endpoint |

### Secret Generation

```bash
# Generate all required secrets
openssl rand -hex 32    # EGAOP_MASTER_ENCRYPTION_KEY
openssl rand -base64 48 # JWT_SECRET
openssl rand -hex 16    # POSTGRES_PASSWORD
openssl rand -hex 16    # GRAFANA_PASSWORD
```

---

## Deployment

### Docker Compose (Development/Staging)

```bash
docker compose up -d
```

### Kubernetes (Production)

```bash
# Helm charts available in charts/e-gaop/
helm dependency update charts/e-gaop
helm install egaop charts/e-gaop -f charts/e-gaop/values-production.yaml
```

### Health Checks

Every service exposes health endpoints:

```bash
curl http://localhost:<HEALTH_PORT>/healthz   # Liveness
curl http://localhost:<HEALTH_PORT>/readyz    # Readiness
```

---

## Project Structure

```
The-Kubernetes-of-AI-Agents/
├── admin-console/                  # Next.js 15 admin dashboard
│   └── src/
│       ├── app/                    # App router (20+ pages)
│       ├── components/             # Reusable UI components
│       └── lib/                    # API client, React Query hooks
│
├── api/
│   └── proto/egaop/v1/             # gRPC protobuf definitions (9 services)
│
├── control-plane/
│   ├── api-server/                 # Central API (REST BFF + gRPC)
│   ├── secret-store/               # AES-256-GCM encrypted secret vault
│   └── workflow-engine/            # Temporal worker (ReAct, HITL, quotas)
│
├── execution-plane/
│   ├── llm-router/                 # Multi-model routing (OpenRouter/OpenAI)
│   ├── tool-proxy/                 # Proxied tool execution with PII scan
│   └── sandbox-runtime/            # Docker sandbox with network isolation
│       └── base-runtime/           # Node.js 22 + Python 3 sandbox image
│
├── memory-plane/                   # Redis + PostgreSQL + pgvector
├── observability-plane/            # Trace ingestion and replay
├── policy-plane/                   # OPA/Rego policies with circuit breaker
│
├── packages/
│   └── shared/                     # @e-gaop/shared — shared utilities
│       └── src/
│           ├── crypto/             # AES-256-GCM + JWT + password hashing
│           ├── errors/             # Structured gRPC error types
│           ├── grpc/               # Interceptors, span enrichment
│           ├── metrics/            # Prometheus exporter
│           ├── namespaces/         # Namespace model, Zod schemas
│           ├── quotas/             # Redis-backed quota enforcer
│           └── telemetry/          # OTel SDK initialization
│
├── tests/                          # Cross-service test suites
│   ├── integration/                # testcontainers-based
│   ├── contract/                   # Consumer-driven contract tests
│   ├── chaos/                      # Chaos resilience tests
│   ├── security/                   # Security test suite
│   └── perf/                       # Performance baseline tests
│
├── charts/e-gaop/                  # Helm charts
├── migrations/                     # PostgreSQL migrations (5 files)
├── observability/                  # OTel collector, Prometheus, Grafana
├── prs/                            # Expert PR descriptions
├── docs/benchmarks/                # Performance benchmark results
├── .github/workflows/ci.yml       # CI pipeline
├── docker-compose.yml              # Full local development environment
└── scripts/
    └── verify-deployed.ps1         # Drift detection script
```

---

## Testing

### Running Tests

```bash
# Unit tests (all packages)
npm test

# Integration tests (requires Docker)
cd tests && npx jest --config jest.config.js --selectProjects integration

# Contract tests
cd tests && npx jest --config jest.config.js --selectProjects contract

# Chaos resilience tests
cd tests && npx jest --config jest.config.js --selectProjects chaos

# Security tests
cd tests && npx jest --config jest.config.js --selectProjects security

# Performance baselines
cd tests && npx jest --config jest.config.js --selectProjects perf
```

### Test Coverage

| Category | Tools | Focus |
|:---|:---|:---|
| **Unit** | Jest | Business logic, pure functions |
| **Integration** | testcontainers | Real PostgreSQL, Redis, OPA |
| **Contract** | Jest | gRPC API compatibility |
| **Chaos** | Custom | DB recovery, circuit breaker, LLM retry |
| **Security** | Custom | SQL injection, JWT validation, cross-namespace isolation |
| **Performance** | Custom | Insert throughput, query latency, p99 baselines |

---

## CI/CD Pipeline

### 5-Stage Pipeline

```yaml
Stage 1: Lint & TypeCheck     → ESLint + TypeScript strict mode
Stage 2: Unit Tests           → 10 parallel test suites
Stage 3: Integration Tests    → 4 testcontainers-based suites
Stage 4: Build                → 9 parallel Docker builds
Stage 5: Deploy Staging       → Automated staging deployment
```

### Pipeline Features

- **Parallel execution** — Unit tests run across 10 parallel workers
- **Docker layer caching** — Faster builds via GitHub Actions cache
- **npm caching** — Dependencies cached across runs
- **Automated staging** — Deploys to staging on merge to `main`
- **Health verification** — Post-deploy health checks

---

## Production Readiness

### Verified Metrics

| Metric | Measured | Target | Status |
|:---|:---|:---|:---:|
| Data durability | 100% (PostgreSQL) | 100% | ✅ |
| Workflow success rate | 100% (Temporal) | 99.9% | ✅ |
| HTTP transport baseline (p99) | 12ms | <50ms | ✅ |
| Agent execution — infrastructure (p50) | 1.5s | <2s | ✅ |
| Sandbox network isolation | Verified | Isolated | ✅ |
| OPA policy enforcement | Verified | Enforced | ✅ |
| Real-time traces/metrics | Verified | Live data | ✅ |

### Engineering Principles

1. **Zero-Trust**: Agents never get direct network access. Every call is proxied, validated, and audited.
2. **Fail-Closed**: OPA unreachable → deny. Circuit open → deny. Never fail-open.
3. **Deterministic Replay**: Every execution produces a trace bundle that can be replayed step-by-step.
4. **Namespace Isolation**: Data, memory, and quotas are strictly partitioned by namespace.
5. **No ORM**: All database access is raw parameterized queries — no query builder abstractions.
6. **No Mocks for Infrastructure**: Integration tests use real PostgreSQL, Redis, and OPA via testcontainers.

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on:

- Code style and conventions
- Commit message format
- Pull request process
- Testing requirements

---

## License

Licensed under the [Apache License 2.0](LICENSE).

---

<p align="center">
  <strong>Built for the future of <em>Autonomous Infrastructure</em>.</strong>
</p>

<p align="center">
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents">
    <img src="https://img.shields.io/badge/Star--This--Repo-⭐-yellow?style=for-the-badge" alt="Star this repo" />
  </a>
  <a href="https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/fork">
    <img src="https://img.shields.io/badge/Fork--This--Repo-🍴-orange?style=for-the-badge" alt="Fork this repo" />
  </a>
</p>
