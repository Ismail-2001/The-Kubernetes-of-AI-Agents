# E-GAOP Architecture

## Five-Plane Design

The platform is organized into five independent planes, each with a single responsibility:

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

## Planes and Services

### Control Plane

| Service | Port(s) | Protocol | Role |
|---------|---------|----------|------|
| **api-server** | 50051 / 3001 | gRPC / REST | Central API gateway, authentication (JWT), agent CRUD, namespace management |
| **workflow-engine** | — | Temporal Worker | ReAct loop orchestration, HITL approval gates, quota enforcement, OPA policy evaluation |
| **secret-store** | 50057 | gRPC | AES-256-GCM encrypted secrets, Postgres-backed (no HashiCorp Vault — see limitations) |

### Execution Plane

| Service | Port(s) | Protocol | Role |
|---------|---------|----------|------|
| **llm-router** | 50053 | gRPC | Multi-model routing with OpenAI/OpenRouter fallback chain. `tool_calls`-aware (native structured calling) |
| **tool-proxy** | 50052 | gRPC | Proxies tool execution requests to sandbox containers. On `egaop-sandbox` network |
| **sandbox-runtime** | 50054 | gRPC | Docker container lifecycle on `egaop-sandbox` network. Creates, executes, and terminates per-agent containers |

### Memory Plane

| Service | Port | Role |
|---------|------|------|
| **memory-plane** | 50055 | Redis (working memory, quota counters, session cache) + PostgreSQL (entity storage, auth, secrets) |

### Policy Plane

| Service | Port | Role |
|---------|------|------|
| **policy-plane** | 50059 / 8181 | OPA/Rego policy evaluation. Decides allow/deny per request based on namespace, clearance, and action |

### Observability Plane

| Service | Port(s) | Role |
|---------|---------|------|
| **observability-plane** | 50056 | Trace ingestion and execution replay |
| **OTel Collector** | 4317 / 4318 | OpenTelemetry trace/metric collection |
| **Prometheus** | 9090 / 9091 | Metrics storage (10s scrape interval, 35+ metric names) |
| **Grafana** | 3000 / 3003 | Dashboards + 5 alert rules (ServiceDown, HighErrorRate, HighLatencyP95, HighLatencyP99, MetricsDropping) |

## Request Flow

```
1. Client → API Server (REST, JWT auth)
2. API Server → OPA Policy Engine (allow/deny decision)
3. API Server → Workflow Engine (starts Temporal workflow)
4. Workflow Engine → LLM Router (generates response, may include tool_calls)
5. Workflow Engine → Tool Proxy → Sandbox Runtime (if tool call needed)
6. Sandbox Runtime → Docker container on egaop-sandbox network
7. Tool result → Workflow Engine → LLM Router (follow-up call)
8. Final answer returned to client
```

## Docker Networks

| Network | Driver | Purpose |
|---------|--------|---------|
| `egaop-net` | bridge | Inter-service communication (all services) |
| `egaop-sandbox` | bridge (internal) | Sandbox isolation: LLM router + sandbox containers only. No internet, no access to postgres/temporal/OPA |

## Infrastructure Dependencies

| Component | Port | Purpose |
|-----------|------|---------|
| PostgreSQL 15 | 5432 | Entity storage, auth, secrets, Temporal backend |
| Redis 7 | 6379 | Quota counters, session cache, working memory |
| Temporal | 7233 | Durable workflow execution engine |
| OPA | 8181 | Policy-as-code sidecar |
| Docker Socket Proxy | 2375 | Scoped Docker API proxy (containers only: POST, START, STOP — no volumes/networks) |

## Known Architecture Gaps

- **gVisor/runsc not installed** — Enhanced kernel-level isolation is not available. Docker namespaces are the only sandbox boundary.
- **pgvector not deployed** — No vector/semantic memory. The memory plane serves Redis + PostgreSQL only.
- **mTLS disabled** — TLS encryption works, but `@grpc/grpc-js` v1.14.4 bug prevents client-cert verification. `requestCert: false` workaround in place.
- **Helm chart partially broken** — OPA pod enters CrashLoopBackOff on install. See `charts/e-gaop/` for details.

> Full readiness assessment: [`production-readiness-final.md`](production-readiness-final.md) (Security and Known Gaps sections).
