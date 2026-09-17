# E-GAOP Monitoring Guide

> How to monitor the platform, what to watch, and when to alert.

## Monitoring Stack

| Component | Port | Purpose |
|-----------|------|---------|
| Prometheus | 9091 | Metrics collection |
| Grafana | 3003 | Dashboards & alerts |
| Tempo | 3200 | Distributed tracing |
| Loki | 3100 | Log aggregation |
| AlertManager | 9093 | Alert routing |

## Key Dashboards

| Dashboard | URL | Purpose |
|-----------|-----|---------|
| Main Overview | http://localhost:3003/d/egaop-main | All services at a glance |
| SLO Burn Rate | http://localhost:3003/d/egaop-slo | SLO compliance |
| Cost Tracking | http://localhost:3003/d/egaop-cost | LLM & infrastructure costs |
| Database | http://localhost:3003/d/egaop-db | PostgreSQL metrics |
| API Performance | http://localhost:3003/d/egaop-api | Request latency & errors |

## Key Metrics to Watch

### Availability
```promql
# Service uptime
up{job="api-server"}

# Error rate
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
```

### Latency
```promql
# P95 latency
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))

# P99 latency
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
```

### Throughput
```promql
# Requests per second
sum(rate(http_requests_total[5m]))

# Successful requests per second
sum(rate(http_requests_total{status=~"2.."}[5m]))
```

### Resources
```promql
# CPU usage
container_cpu_usage_seconds_total{container="api-server"}

# Memory usage
container_memory_usage_bytes{container="api-server"}

# Disk usage
node_filesystem_avail_bytes{mountpoint="/var/lib/postgresql/data"}
```

### Business Metrics
```promql
# Active agents
egaop_agents_total{status="active"}

# Agent executions
sum(rate(egaop_agent_executions_total[5m]))

# LLM cost
sum(rate(egaop_llm_cost_usd_total[5m]))
```

## Alert Rules

### Critical (Page immediately)
| Alert | Condition | Duration |
|-------|-----------|----------|
| ServiceDown | up == 0 | 1m |
| HighErrorRate | error_rate > 5% | 5m |
| DatabaseDown | pg_up == 0 | 1m |
| DiskAlmostFull | disk_free < 10% | 5m |

### Warning (Notify on-call)
| Alert | Condition | Duration |
|-------|-----------|----------|
| HighLatencyP95 | p95 > 500ms | 10m |
| HighMemoryUsage | memory > 80% | 10m |
| HighCPUUsage | cpu > 80% | 10m |
| CertificateExpiring | cert_days < 30 | 1h |

### Info (Daily digest)
| Alert | Condition | Duration |
|-------|-----------|----------|
| LowRequestRate | rps < 1 | 1h |
| HighLLMCost | cost > $100/day | 24h |

## Log Queries (Loki)

```logql
# Error logs
{container="api-server"} |= "error"

# Slow queries
{container="api-server"} |= "slow query"

# Authentication failures
{container="api-server"} |= "auth" |= "failed"

# Recent logs (last 5 min)
{container="api-server"} | json | timestamp > now() - 5m
```

## Tracing (Tempo)

```bash
# Search traces by service
curl http://localhost:3200/api/traces?service=api-server&limit=10

# Search traces by duration
curl http://localhost:3200/api/traces?minDuration=1s&limit=10
```

## Health Checks

```bash
# Quick health check
./scripts/validate-setup.sh

# Full health check
curl http://localhost:15051/healthz | jq .

# Database health
docker exec egaop-postgres pg_isready -U postgres

# Redis health
docker exec egaop-redis redis-cli ping
```

## Dashboard Customization

### Adding a new panel
1. Open Grafana → Dashboard → Edit
2. Add new panel
3. Enter PromQL query
4. Set thresholds (green/yellow/red)
5. Save dashboard

### Creating alert rule
1. Open Grafana → Alerting → New Alert Rule
2. Select metric
3. Set condition (e.g., > 500ms for 10 min)
4. Configure notification channel
5. Save rule
