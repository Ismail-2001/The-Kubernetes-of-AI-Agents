# High Error Rate (>5% 5xx)

| Field | Value |
|-------|-------|
| **Alert rule** | `k8s_ai_high_error_rate` |
| **Severity** | `critical` |
| **Condition** | 5xx rate > 5% over 5 minutes |
| **Response time** | 15 minutes |

## Symptoms

- Slack: "High Error Rate (>5% 5xx)"
- Grafana dashboard Error Rate panel spikes above the red line
- Users report failures in the UI or API calls returning 5xx
- pagerduty triggered

## Automated actions

- Alert fires after **5 minutes** of sustained high error rate
- No auto-remediation (circuit breakers may already be active)

## Diagnosis

### 1. Identify which service is producing errors

```bash
# Query per-service error rates directly from Prometheus
curl -s 'http://localhost:9091/api/v1/query?query=sum by (net_host_name)(rate(http_server_duration_count{status_code=~"5..",job="egaop-services"}[5m]))' | jq .
```

### 2. Check HTTP status code distribution

```bash
# 5xx by status code
curl -s 'http://localhost:9091/api/v1/query?query=sum by (http_status_code)(rate(http_server_duration_count{status_code=~"5..",job="egaop-services"}[5m])))' | jq .
```

### 3. Check service logs for error patterns

```bash
# Replace <service> with the high-error service
docker compose logs --tail=200 <service> | grep -E "(error|Error|500|502|503)"
```

### 4. Check downstream dependencies

```bash
# OpenAI / LLM endpoints may be returning errors
docker compose logs llm-router --tail=50 | grep -E "(ERROR|error|FAIL)"

# Postgres connectivity
docker compose logs api-server --tail=50 | grep -i "postgres\|database"
```

### 5. Check if circuit breakers are open

```bash
# LLM circuit breaker status (logs will show "Circuit Breaker open")
docker compose logs llm-router --tail=100 | grep -i "circuit"
```

## Remediation

### OpenAI API returning errors (502/503 from upstream)

```bash
# 1. Check API key validity
docker compose exec api-server env | grep OPENAI_API_KEY

# 2. Verify rate limits
docker compose logs llm-router --tail=50 | grep -i "429\|rate_limit"

# 3. If rate limited, reduce LLM_RPM or wait for reset
#    Default: RATE_LIMIT_LLM_RPM=30
```

### Internal service failing (e.g., Secret Store, Memory Plane)

```bash
# 1. Check the failing service's health
curl -s http://localhost:15057/healthz   # secret-store
curl -s http://localhost:15055/healthz   # memory-plane

# 2. Restart if unhealthy
docker compose restart <failing-service>
```

### Database connectivity issues

```bash
# 1. Test Postgres connection from the failing service
docker compose exec <service> node -e "
  const { Pool } = require('pg');
  const pool = new Pool({ host: 'pgbouncer', port: 6432, user: 'egaop', password: '...', database: 'egaop' });
  pool.query('SELECT 1').then(() => console.log('OK')).catch(e => console.log('FAIL:', e.message));
"

# 2. Check PgBouncer pool saturation
docker compose logs pgbouncer --tail=20 | grep -i "pool\|wait"
```

### Validation errors (400-class reported as 5xx)

Check if a recent deployment introduced a breaking API change:
```bash
# Look for validation error patterns
docker compose logs api-server --tail=200 | grep -i "validation\|schema\|zod"
```

## Verification

```bash
# Error rate should drop below 5%
curl -s 'http://localhost:9091/api/v1/query?query=(sum(rate(http_server_duration_count{status_code=~"5..",job="egaop-services"}[5m])) or vector(0)) / (sum(rate(http_server_duration_count{job="egaop-services"}[5m])) or vector(1))' | jq '.data.result[0].value[1]'
# → should be < 0.05

# Grafana dashboard Error Rate panel should return to normal
# Alert auto-resolves after 5 minutes below threshold
```

## Escalation

| Criteria | Contact |
|----------|---------|
| OpenAI API outage | Wait for recovery, no escalation |
| Internal service bug | Engineering team (create GH issue) |
| Database corruption | DB admin + engineering lead |
| Deployment rollback needed | DevOps / release engineer |

## Post-mortem data

```bash
docker compose logs --tail=500 <affected-service> > /tmp/error-logs-$(date +%Y%m%d-%H%M%S).txt
```
