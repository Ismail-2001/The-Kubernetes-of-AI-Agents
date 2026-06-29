<h1 align="center">
  <br>
  E-GAOP
  <br>
</h1>

<h4 align="center">Enterprise-Grade Agent Orchestration Platform — The Kubernetes of AI Agents</h4>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#services">Services</a> •
  <a href="#api-reference">API</a> •
  <a href="#deployment">Deployment</a> •
  <a href="#testing">Testing</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/gRPC-1.14-green?style=flat-square&logo=grpc" alt="gRPC" />
  <img src="https://img.shields.io/badge/Temporal-1.11-orange?style=flat-square" alt="Temporal" />
  <img src="https://img.shields.io/badge/PostgreSQL-15-blue?style=flat-square&logo=postgresql" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Redis-7-red?style=flat-square&logo=redis" alt="Redis" />
  <img src="https://img.shields.io/badge/OpenTelemetry-OTel-black?style=flat-square&logo=opentelemetry" alt="OpenTelemetry" />
  <img src="https://img.shields.io/badge/License-Apache--2.0-green?style=flat-square" alt="License" />
</p>

---

E-GAOP is a **production-grade, multi-tenant orchestration platform** for autonomous AI agents. It treats agents as untrusted workloads with kernel-level isolation, OPA-enforced policies, durable execution via Temporal, and deterministic execution replay — the infrastructure layer that turns fragile agent prototypes into resilient enterprise systems.

---

## Table of Contents

- [Why E-GAOP](#why-e-gaop)
- [Architecture](#architecture)
- [Services](#services)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Observability](#observability)
- [Testing](#testing)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

---

## Why E-GAOP

| Dimension | Legacy Agent Frameworks | E-GAOP |
|:---|:---|:---|
| **Isolation** | Single process, shared memory | Kernel-level sandboxing (gVisor / Firecracker) |
| **Durability** | Ephemeral, lost on crash | Temporal-backed durable execution with replay |
| **Security** | Shared API keys, no audit | Dynamic secret injection, mTLS, append-only audit log |
| **Governance** | None or hardcoded rules | OPA/Rego runtime policies, per-namespace RBAC |
| **Observability** | `console.log` | OpenTelemetry traces, Prometheus metrics, Grafana dashboards |
| **Multi-tenancy** | None | Namespace isolation with tier-based quotas |
| **Scalability** | Laptop-scale | Kubernetes-native horizontal scaling |

---

## Architecture

E-GAOP decomposes into **five decoupled planes**, each independently scalable:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CONTROL PLANE                                │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ API      │  │ Workflow     │  │ Secret       │  │ Namespace │  │
│  │ Server   │  │ Engine       │  │ Store        │  │ Manager   │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘  │
│       │               │                 │                │         │
├───────┼───────────────┼─────────────────┼────────────────┼─────────┤
│                        EXECUTION PLANE                              │
│  ┌────┴─────┐  ┌──────┴───────┐  ┌─────┴──────┐                   │
│  │ LLM      │  │ Tool         │  │ Sandbox    │                   │
│  │ Router   │  │ Proxy        │  │ Runtime    │                   │
│  └──────────┘  └──────────────┘  └────────────┘                   │
├─────────────────────────────────────────────────────────────────────┤
│                        MEMORY PLANE                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ Redis        │  │ PostgreSQL   │  │ pgvector     │             │
│  │ (Working)    │  │ (Entity)     │  │ (Semantic)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
├─────────────────────────────────────────────────────────────────────┤
│                        POLICY PLANE                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ OPA / Rego   │  │ PII          │  │ Circuit      │             │
│  │ Engine       │  │ Detection    │  │ Breaker      │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
├─────────────────────────────────────────────────────────────────────┤
│                     OBSERVABILITY PLANE                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ OTel         │  │ Prometheus   │  │ Grafana      │             │
│  │ Collector    │  │ Metrics      │  │ Dashboards   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
```

**Request flow:**

```
Client → API Server → OPA Policy Check → Workflow Engine → LLM Router → Tool Proxy → Memory Plane
                    ↕                                    ↕
              Secret Store                         Observability Plane (OTel traces)
```

---

## Services

| Service | Port | Description |
|:---|:---:|:---|
| **api-server** | `50051` | gRPC API for namespace CRUD, agent lifecycle management |
| **workflow-engine** | — | Temporal worker: ReAct loops, HITL approval gates, quota enforcement |
| **llm-router** | `50053` | OpenAI routing with fallback chains, token counting, cost tracking |
| **tool-proxy** | `50052` | Proxied tool execution with PII scanning and rate limiting |
| **sandbox-runtime** | `50054` | Docker container provisioning with gVisor/Firecracker isolation |
| **memory-plane** | `50055` | Redis-backed working memory + PostgreSQL entity storage |
| **observability-plane** | `50056` | Trace ingestion, execution replay bundles |
| **secret-store** | `50057` | AES-256-GCM encrypted secret vault with key rotation |
| **policy-plane** | `50059` | OPA/Rego policy evaluation with circuit breaker and LRU cache |

**Infrastructure:**

| Component | Port | Purpose |
|:---|:---:|:---|
| PostgreSQL | `5432` | Entity memory, namespaces, audit log |
| Redis | `6379` | Working memory, quota counters, session cache |
| Temporal | `7233` | Durable workflow execution |
| OPA | `8181` | Policy-as-code sidecar |
| OTel Collector | `4317` | Trace/metrics collection and export |
| Prometheus | `9090` | Metrics scraping and alerting |
| Grafana | `3000` | Dashboard visualization |

---

## Getting Started

### Prerequisites

- **Node.js** 20+
- **Docker** 24+ with Compose v2
- **Temporal** dev server (or use Docker)

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Ismail-2001/Enterprise-Grade-Agent-Orchestration-Platform.git
cd Enterprise-Grade-Agent-Orchestration-Platform

# 2. Install dependencies (npm workspaces)
npm install

# 3. Copy environment template
cp .env.example .env
# Edit .env with your OPENAI_API_KEY and other secrets

# 4. Start infrastructure
docker compose up -d redis postgres temporal opa

# 5. Build shared package (required by all services)
cd packages/shared && npx tsc && cd ../..

# 6. Start all services
docker compose up -d

# 7. Verify health
curl http://localhost:15051/healthz   # API Server
curl http://localhost:15053/healthz   # LLM Router
curl http://localhost:15055/healthz   # Memory Plane
```

### Development

```bash
# Run a single service in dev mode
cd control-plane/api-server
npm run dev

# Run tests
npm test

# Typecheck all packages
npm run typecheck
```

---

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Required | Default | Description |
|:---|:---:|:---:|:---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for LLM routing |
| `TLS_ENABLED` | No | `true` | Enable mTLS for all gRPC services |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `POSTGRES_HOST` | No | `localhost` | PostgreSQL host |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://localhost:4317` | OTel Collector endpoint |
| `RATE_LIMIT_LLM_RPM` | No | `30` | LLM requests per minute per agent |
| `RATE_LIMIT_TOOL_PROXY_RPM` | No | `60` | Tool calls per minute per agent |
| `EGAOP_MASTER_ENCRYPTION_KEY` | Prod | — | Master key for secret-store encryption |

---

## API Reference

All services communicate via **gRPC** with Protocol Buffers. Proto definitions live in [`api/proto/`](api/proto/).

### Core Services

**NamespaceService** — Multi-tenant namespace management
```protobuf
service NamespaceService {
  rpc CreateNamespace(CreateNamespaceRequest) returns (Namespace);
  rpc GetNamespace(GetNamespaceRequest) returns (Namespace);
  rpc ListNamespaces(ListNamespacesRequest) returns (ListNamespacesResponse);
  rpc UpdateNamespace(UpdateNamespaceRequest) returns (Namespace);
  rpc SuspendNamespace(SuspendNamespaceRequest) returns (Namespace);
  rpc DeleteNamespace(DeleteNamespaceRequest) returns (google.protobuf.Empty);
}
```

**AgentService** — Agent lifecycle management
```protobuf
service AgentService {
  rpc CreateAgent(CreateAgentRequest) returns (Agent);
  rpc GetAgent(GetAgentRequest) returns (Agent);
  rpc ListAgents(ListAgentsRequest) returns (ListAgentsResponse);
  rpc UpdateAgent(UpdateAgentRequest) returns (Agent);
  rpc DeleteAgent(DeleteAgentRequest) returns (google.protobuf.Empty);
}
```

**LLMService** — LLM routing and generation
```protobuf
service LLMService {
  rpc Generate(GenerateRequest) returns (GenerateResponse);
}
```

**ToolService** — Tool execution proxy
```protobuf
service ToolService {
  rpc CallTool(CallToolRequest) returns (CallToolResponse);
}
```

**ObservabilityService** — Trace ingestion and replay
```protobuf
service ObservabilityService {
  rpc ExportTrace(ExportTraceRequest) returns (ExportTraceResponse);
  rpc GetExecutionReplay(GetExecutionReplayRequest) returns (ExecutionReplay);
}
```

---

## Observability

E-GAOP ships with a full observability stack out of the box:

- **Traces**: OpenTelemetry → OTel Collector → Grafana Tempo
- **Metrics**: Prometheus exporter (port `9464`) → Prometheus → Grafana
- **Logs**: Structured JSON via `pino` → stdout → log aggregator
- **Dashboards**: Pre-built Grafana dashboard with namespace-level filtering
- **Alerts**: 5 Prometheus alert rules (error rate, latency, circuit breaker, quota)

```bash
# Access Grafana
open http://localhost:3000   # admin / admin

# Access Prometheus
open http://localhost:9090

# Access OTel zpages (debug traces)
open http://localhost:8888
```

---

## Testing

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

**Test strategy:**
- **Unit tests**: Per-service, mocking external APIs only
- **Integration tests**: Real PostgreSQL + Redis + OPA via testcontainers
- **Contract tests**: Consumer-driven gRPC contract verification
- **Chaos tests**: DB recovery, OPA circuit breaker, LLM retry backoff
- **Security tests**: SQL injection, JWT validation, cross-namespace isolation, mTLS
- **Performance tests**: Insert throughput, query latency, p99 baselines

---

## Deployment

### Docker Compose (Development / Staging)

```bash
docker compose up -d
```

### Kubernetes (Production)

```bash
# Helm chart coming in v1.0.0
# For now, each service has a Dockerfile ready for container orchestration
```

### Service Health Checks

Every service exposes a health endpoint:

```bash
curl http://localhost:<HEALTH_PORT>/healthz
curl http://localhost:<HEALTH_PORT>/readyz
```

| Service | Health Port |
|:---|:---:|
| api-server | `15051` |
| llm-router | `15053` |
| tool-proxy | `15052` |
| sandbox-runtime | `15054` |
| memory-plane | `15055` |
| observability-plane | `15056` |
| secret-store | `15057` |
| workflow-engine | `15058` |
| policy-plane | `15059` |

---

## Project Structure

```
Enterprise-Grade-Agent-Orchestration-Platform/
├── admin-console/              # Next.js 15 admin dashboard
│   └── src/
│       ├── app/                # App router pages (Dashboard, Agents, Observability, Settings)
│       ├── components/         # React components (Providers, ErrorStates)
│       └── lib/                # API client, React Query hooks, SSE client, types
├── api/
│   └── proto/egaop/v1/         # gRPC protobuf definitions (9 services)
├── control-plane/
│   ├── api-server/             # gRPC API server (namespace + agent handlers)
│   ├── secret-store/           # AES-256-GCM encrypted secret vault
│   └── workflow-engine/        # Temporal worker (ReAct, HITL, quota enforcement)
├── execution-plane/
│   ├── llm-router/             # OpenAI routing with fallback chains
│   ├── tool-proxy/             # Proxied tool execution with PII scanning
│   └── sandbox-runtime/        # Docker sandbox with gVisor/Firecracker
├── memory-plane/               # Redis + PostgreSQL memory management
├── observability-plane/        # Trace ingestion and replay bundles
├── policy-plane/               # OPA/Rego policies with circuit breaker
├── packages/
│   └── shared/                 # @e-gaop/shared — shared utilities
│       └── src/
│           ├── crypto/         # AES-256-GCM encrypt/decrypt
│           ├── errors/         # Structured gRPC error types
│           ├── grpc/           # Interceptors, span enrichment, namespace enforcement
│           ├── metrics/        # Prometheus exporter + standard meters
│           ├── namespaces/     # Namespace model, Zod schemas, tier defaults
│           ├── quotas/         # Redis-backed quota enforcer
│           └── telemetry/      # OTel SDK initialization
├── tests/                      # Cross-service test suites
│   ├── integration/            # testcontainers-based integration tests
│   ├── contract/               # Consumer-driven contract tests
│   ├── chaos/                  # Chaos resilience tests
│   ├── security/               # Security test suite
│   └── perf/                   # Performance baseline tests
├── migrations/                 # PostgreSQL migration files
├── observability/              # OTel collector, Prometheus, Grafana configs
├── certs/                      # TLS certificate generation scripts
└── docker-compose.yml          # Full local development environment
```

---

## Engineering Principles

1. **Zero-Trust**: Agents never get direct network access. Every call is proxied, validated, and audited.
2. **Fail-Closed**: OPA unreachable → deny. Circuit open → deny. Never fail-open.
3. **Deterministic Replay**: Every execution produces a trace bundle that can be replayed step-by-step.
4. **Namespace Isolation**: Data, memory, and quotas are strictly partitioned by namespace.
5. **No ORM**: All database access is raw parameterized queries — no query builder abstractions.
6. **No Mocks for Infrastructure**: Integration tests use real PostgreSQL, Redis, and OPA via testcontainers.

---

## Roadmap

- [x] **v0.1.0** — Five-Plane Architecture, gRPC foundation, all 8 services
- [x] **v0.2.0** — OPA policy integration, circuit breaker, namespace enforcement
- [x] **v0.3.0** — Temporal durable execution, ReAct workflows, HITL gates
- [x] **v0.4.0** — OpenTelemetry observability, Prometheus metrics, Grafana dashboards
- [x] **v0.5.0** — Multi-tenancy, namespace CRUD, quota enforcement, admin console
- [ ] **v0.6.0** — Kubernetes Helm charts, horizontal auto-scaling
- [ ] **v0.7.0** — Multi-region memory plane, global entity replication
- [ ] **v1.0.0** — Production stable release

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on code style, commit conventions, and pull request process.

---

## License

Licensed under the [Apache License 2.0](LICENSE).

---

<p align="center">
  Built for the future of <strong>Autonomous Infrastructure</strong>.
</p>
