# E-GAOP Service Level Objectives (SLOs)

## SLI Definitions (What We Measure)

### Availability
- **SLI**: Percentage of successful HTTP requests (non-5xx) over a rolling window
- **Measurement**: `sum(rate(http_requests_total{code!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`
- **Target**: 99.9% (8.76 hours downtime/year)

### Latency
- **SLI**: P95 and P99 of HTTP request duration
- **Measurement**: `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))`
- **Targets**:
  - REST API: P95 < 200ms, P99 < 500ms
  - gRPC: P95 < 100ms, P99 < 300ms
  - Health endpoint: P95 < 10ms

### Error Budget
- **SLI**: Total 5xx errors as percentage of total requests
- **Formula**: `1 - (successful_requests / total_requests)`
- **Budget**: 0.1% of total requests over 30-day window
- **Exhaustion rate**: Monitored via Grafana SLO dashboard

## Error Budget Policy

| Budget Remaining | Action |
|-----------------|--------|
| >50% | Normal development velocity |
| 25-50% | Code freeze on non-critical changes |
| 10-25% | Engineering review required for all deploys |
| <10% | Incident response mode, no deploys except security |
| 0% | Full freeze, all-hands-on-deck |

## SLO by Service

| Service | Availability | Latency P95 | Latency P99 |
|---------|-------------|-------------|-------------|
| API Server (REST) | 99.9% | <200ms | <500ms |
| API Server (gRPC) | 99.9% | <100ms | <300ms |
| LLM Router | 99.5% | <2s | <5s |
| Tool Proxy | 99.5% | <500ms | <1s |
| Sandbox Runtime | 99.0% | <5s | <10s |
| Memory Plane | 99.9% | <50ms | <100ms |
| Observability Plane | 99.5% | <100ms | <300ms |
| Secret Store | 99.99% | <50ms | <100ms |
| Workflow Engine | 99.5% | <500ms | <1s |

## Baseline Measurements (Post-Phase 7)

| Metric | Value | Notes |
|--------|-------|-------|
| API Server throughput | ~500 req/s | Sustained, measured under normal load |
| gRPC throughput | ~1000 calls/s | Sustained, bidirectional streams |
| PostgreSQL query latency | P95 < 10ms | Indexed queries, connection pool active |
| Redis operation latency | P95 < 5ms | In-memory, local network |
| LLM inference latency | P95 < 2s | Network dependent, provider variable |
| Memory usage per service | 128–256MB | Steady-state after warmup |
| Container startup time | <10s | Cold start, image cached |

## Burn Rate Thresholds

| Window | Critical Threshold | Warning Threshold |
|--------|-------------------|-------------------|
| 1 hour | >14.4x | >6x |
| 6 hours | >6x | >3x |
| 1 day | >3x | >1x |
| 3 days | >1x | >0.5x |

## Monitoring Stack

- **Prometheus**: Metrics collection (15s scrape interval)
- **Grafana**: Dashboards + alerting visualization
- **Grafana SLO Dashboard**: `observability/grafana/slo-dashboard.json`
- **Alert Rules**: `observability/alerts.yaml` (9 rules)
- **Tempo**: Distributed tracing
- **Loki**: Log aggregation

## Incident Response

Reference: `docs/OPERATIONAL-RUNBOOK.md`
