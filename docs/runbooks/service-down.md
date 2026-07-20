# Service Down

| Field | Value |
|-------|-------|
| **Alert rule** | `k8s_ai_service_down` |
| **Severity** | `critical` |
| **Condition** | `min(up{job="egaop-services"}) == 0` for 30s |
| **Response time** | 5 minutes |

## Symptoms

- Slack notification: "K8s AI Agents Service Down"
- Grafana dashboard shows one or more services as RED (down) in the Service Health panel
- `docker compose ps` shows a container in `unhealthy` or `exited` state
- API returns `502 Bad Gateway` for all requests
- PagerDuty/OpsGenie alert fires (if configured)

## Automated actions

- Alert fires after **30 seconds** of confirmed downtime (fast detection)
- Grafana repeats notification every 5 minutes while condition persists
- No automatic recovery — human intervention required

## Diagnosis

### 1. Identify which service is down

```bash
# Quick overview
docker compose ps

# Health status of every service
docker compose ps --all | grep -E "(unhealthy|exited|starting)"

# Prometheus query (replicates the alert expression)
curl -s 'http://localhost:9091/api/v1/query?query=up{job="egaop-services"}' | jq .
```

### 2. Check service logs

```bash
# Replace <service> with the failing service name
docker compose logs --tail=100 <service>

# Common services: api-server, llm-router, workflow-engine,
#                  secret-store, memory-plane, sandbox-runtime,
#                  tool-proxy, observability-plane
```

### 3. Check infrastructure dependencies

```bash
# Postgres
docker compose exec postgres psql -U egaop -c "SELECT 1"

# Redis
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping

# Temporal
docker compose exec temporal tctl cluster health
```

### 4. Check resource pressure

```bash
# Memory usage per service
docker compose stats --no-stream

# Disk space
df -h

# Docker system
docker system df
```

## Remediation

### Service exited

```bash
# Restart the failed service
docker compose up -d <service>

# If it fails again, check for OOM kills
docker inspect <container-id> | jq '.[].State.OOMKilled'
```

### Service unhealthy (health check failing)

```bash
# Check the health endpoint directly
docker compose exec <service> wget -qO- http://127.0.0.1:<health-port>/healthz

# Common health-port mapping:
#   api-server:         15051
#   secret-store:       15057
#   llm-router:         15053
#   tool-proxy:         15052
#   sandbox-runtime:    15054
#   memory-plane:       15055
#   observability-plane: 15056
#   workflow-engine:    15058
```

### Dependency unavailable (Postgres / Redis down)

If Postgres is down:
```bash
# Check postgres logs
docker compose logs postgres --tail=50

# Restart if needed
docker compose up -d postgres

# Wait for healthy, then restart dependent services
docker compose up -d api-server secret-store memory-plane
```

If Redis is down:
```bash
# Check redis logs
docker compose logs redis --tail=50

# Restart
docker compose up -d redis
```

### Docker daemon issue

```bash
# Restart Docker (will briefly interrupt all services)
sudo systemctl restart docker

# Or on Windows: restart Docker Desktop
```

## Verification

```bash
# All services healthy
docker compose ps | grep -c "unhealthy"
# → should return 0

# Health endpoint responds
curl -s http://localhost:3001/health | jq .
# → {"status":"healthy","services":[...]}

# Prometheus sees all targets as UP
curl -s 'http://localhost:9091/api/v1/query?query=up{job="egaop-services"}' | jq '.data.result[].value[1]'
# → all should be "1"

# Grafana alert resolves automatically after condition clears for 30s
```

## Escalation

| Criteria | Contact |
|----------|---------|
| Single service down, restarted successfully | No escalation needed |
| Multiple services down simultaneously | Infrastructure team |
| Docker daemon failure | Platform / DevOps team |
| Data loss suspected | Engineering lead + DB admin |

## Post-mortem data

After resolution, collect:
```bash
docker compose logs --tail=500 <service> > /tmp/service-logs-$(date +%Y%m%d-%H%M%S).txt
```
Attach to the incident post-mortem.
