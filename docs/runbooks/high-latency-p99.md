# Critical Latency P99 (>10s)

| Field | Value |
|-------|-------|
| **Alert rule** | `k8s_ai_high_latency_p99` |
| **Severity** | `critical` |
| **Condition** | P99 latency > 10000ms over 5 minutes |
| **Response time** | 15 minutes |

## Symptoms

- Slack: "Critical Latency P99 (>10s)"
- Grafana latency panels in the red zone
- Users experiencing request timeouts
- May be correlated with increased error rate
- API gateway (if configured) returning 504 Gateway Timeout

## Automated actions

- Alert fires after **5 minutes** of sustained critical latency
- Circuit breakers may start opening (LLM router, downstream calls)
- No auto-remediation

## Diagnosis

### 1. Identify the slowest service

```bash
# P99 latency per service
curl -s 'http://localhost:9091/api/v1/query?query=histogram_quantile(0.99, sum by (le, net_host_name)(rate(http_server_duration_bucket{job="egaop-services"}[5m])))' | jq '.data.result[] | {service: .metric.net_host_name, p99: .value[1]}'
```

### 2. Check for cascading failures

```bash
# Is high latency causing timeouts in downstream services?
docker compose logs workflow-engine --tail=50 | grep -E "timeout|TIMEOUT|deadline"
```

### 3. Check if Temporal workflows are stuck

```bash
# List workflows (requires tctl)
docker compose exec temporal tctl workflow list --query "WorkflowType='AgentExecutionWorkflow' AND Status=1"

# Describe a stuck workflow
docker compose exec temporal tctl workflow describe --workflow-id <id>
```

### 4. Check for memory leak / GC pressure

```bash
# Node.js heap usage (if exposed)
curl -s http://localhost:3001/-/metrics | grep "nodejs_heap_size"

# Or check container memory
docker stats --no-stream $(docker compose ps -q api-server)
```

### 5. Check sandbox runtime health

```bash
# Container creation latency
docker compose logs sandbox-runtime --tail=50 | grep -E "duration|create|start"
```

## Remediation

### Single service has P99 > 10s

```bash
# 1. Restart the service (quick fix, not a solution)
docker compose restart <service>

# 2. Increase resources
#    Edit docker-compose.yml: double memory and cpu limits
docker compose up -d <service>

# 3. Check for infinite loops or blocking operations
docker compose logs --tail=200 <service> | grep -E "warn|WARN|error|ERROR"
```

### LLM timeout cascade

```bash
# 1. Reduce LLM timeout aggressively
#    LLM_TIMEOUT_MS=10000

# 2. Reduce max retries
#    LLM_MAX_RETRIES=1

# 3. Apply and restart
docker compose up -d llm-router
```

### Temporal stuck workflows

```bash
# 1. Terminate stuck workflows
docker compose exec temporal tctl workflow terminate --workflow-id <id> --reason "Stuck - high latency incident"

# 2. Reset if needed
docker compose exec temporal tctl workflow reset --workflow-id <id> --reset-type LastDecisionCompleted
```

### Docker / system resource exhaustion

```bash
# 1. Prune unused resources
docker system prune -f

# 2. Check disk I/O (may affect Postgres)
iostat -x 1 5   # Linux only

# 3. Consider scaling horizontally (add more service replicas)
#    docker compose up -d --scale api-server=3 api-server
```

## Verification

```bash
# P99 should be below 10000ms
curl -s 'http://localhost:9091/api/v1/query?query=histogram_quantile(0.99, sum(rate(http_server_duration_bucket{job="egaop-services"}[5m])) by (le))' | jq '.data.result[0].value[1]'
# → should be < 10000

# No circuit breakers open
docker compose logs llm-router --tail=20 | grep "circuit" | grep -c "open"
# → should be 0

# Alert auto-resolves after 5 minutes below threshold
```

## Escalation

| Criteria | Contact |
|----------|---------|
| Single service slow | Backend team |
| Multiple services slow | Engineering lead |
| Temporal stuck | Workflow engine team |
| Docker/system | DevOps / infrastructure |
| Data loss risk | Engineering lead + mgr |

## Post-mortem data

```bash
# Capture full latency profile
curl -s 'http://localhost:9091/api/v1/query?query=histogram_quantile(0.99, sum by (le, net_host_name)(rate(http_server_duration_bucket{job="egaop-services"}[5m])))' > /tmp/latency-p99-$(date +%Y%m%d-%H%M%S).json

# Collect logs from affected services
for svc in api-server llm-router workflow-engine; do
  docker compose logs --tail=500 "$svc" > "/tmp/${svc}-logs-$(date +%Y%m%d-%H%M%S).txt"
done
```
