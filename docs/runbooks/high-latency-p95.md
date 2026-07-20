# High Latency P95 (>3s)

| Field | Value |
|-------|-------|
| **Alert rule** | `k8s_ai_high_latency_p95` |
| **Severity** | `warning` |
| **Condition** | P95 latency > 3000ms over 5 minutes |
| **Response time** | 1 hour |

## Symptoms

- Slack: "High Latency P95 (>3s)"
- Grafana latency panels show elevated response times
- Users report slowness but requests still succeed
- No errors yet — this is a leading indicator

## Automated actions

- Alert fires after **5 minutes** of sustained high latency
- No auto-remediation

## Diagnosis

### 1. Identify the slow service

```bash
# P95 latency per service
curl -s 'http://localhost:9091/api/v1/query?query=histogram_quantile(0.95, sum by (le, net_host_name)(rate(http_server_duration_bucket{job="egaop-services"}[5m])))' | jq '.data.result[] | {service: .metric.net_host_name, p95: .value[1]}'
```

### 2. Check if LLM calls are slow

```bash
# LLM router latency (the most common source of high p95)
docker compose logs llm-router --tail=50 | grep -E "duration|latency|slow"
```

### 3. Check database query performance

```bash
# Postgres slow queries (requires pg_stat_statements)
docker compose exec postgres psql -U egaop -c "
  SELECT query, mean_exec_time, calls
  FROM pg_stat_statements
  ORDER BY mean_exec_time DESC
  LIMIT 10;
"
```

### 4. Check for resource contention

```bash
# CPU / memory pressure
docker compose stats --no-stream --no-trunc | head -20
```

### 5. Check if PgBouncer pool is saturated

```bash
docker compose logs pgbouncer --tail=20 | grep -i "pool\|wait\|client"
```

## Remediation

### LLM call latency high

```bash
# 1. Reduce LLM timeout
#    Set LLM_TIMEOUT_MS=15000 (down from 30000)

# 2. Configure faster fallback models
#    LLM_FALLBACK_CHAIN=gpt-4o-mini,gpt-3.5-turbo

# 3. Check OpenAI status (status.openai.com)

# Apply env changes:
docker compose up -d llm-router
```

### Database query slowness

```bash
# 1. Check for missing indexes
docker compose exec postgres psql -U egaop -c "
  SELECT schemaname, tablename, indexname, idx_scan
  FROM pg_stat_user_indexes
  ORDER BY idx_scan ASC;
"

# 2. Analyze and vacuum
docker compose exec postgres psql -U egaop -c "ANALYZE VERBOSE;"

# 3. Increase work_mem if sorting/joining large datasets
#    Command: add -c "work_mem=16MB" to postgres command
```

### Resource exhaustion

```bash
# Increase CPU/memory limits for the slow service in docker-compose.yml
# Then recreate:
docker compose up -d <service>

# Example: api-server memory 512M → 1G
```

## Verification

```bash
# P95 should be below 3000ms
curl -s 'http://localhost:9091/api/v1/query?query=histogram_quantile(0.95, sum(rate(http_server_duration_bucket{job="egaop-services"}[5m])) by (le))' | jq '.data.result[0].value[1]'
# → should be < 3000

# Check response time in Grafana dashboard
# Alert auto-resolves after 5 minutes below threshold
```

## Escalation

| Criteria | Contact |
|----------|---------|
| LLM provider latency | No escalation, monitor |
| DB query performance | Backend team |
| Resource limits hit | DevOps / platform team |
| Architectural bottleneck | Engineering lead |

## Post-mortem data

```bash
curl -s 'http://localhost:9091/api/v1/query?query=histogram_quantile(0.95, sum by (le, net_host_name)(rate(http_server_duration_bucket{job="egaop-services"}[5m])))' > /tmp/latency-p95-$(date +%Y%m%d-%H%M%S).json
```
