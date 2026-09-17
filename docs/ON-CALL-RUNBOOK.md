# E-GAOP On-Call Runbook

> Everything you need to respond to incidents, fast.

## Quick Reference

| Alert | Severity | Response Time | Escalation |
|-------|----------|--------------|------------|
| ServiceDown | P1 | 5 min | Immediate |
| HighErrorRate | P1 | 5 min | Immediate |
| HighLatencyP95 | P2 | 15 min | 30 min |
| DatabaseConnectionPoolExhausted | P1 | 5 min | Immediate |
| MemoryUsageHigh | P3 | 30 min | 2 hours |
| DiskSpaceLow | P2 | 15 min | 1 hour |
| CertificateExpiring | P3 | 1 hour | 24 hours |

## On-Call Rotation

### Schedule
- **Primary**: 1 week rotation, Monday 9am to Monday 9am
- **Secondary**: Same rotation, handles P1 if primary unavailable
- **Escalation**: Engineering Manager → VP Engineering

### Contacts
| Role | Name | Phone | Slack |
|------|------|-------|-------|
| Primary On-Call | [Rotate] | [Phone] | @oncall |
| Secondary On-Call | [Rotate] | [Phone] | @oncall-secondary |
| Engineering Manager | [Name] | [Phone] | @eng-manager |

### Handoff Checklist
- [ ] Review open incidents from previous shift
- [ ] Check deployment status
- [ ] Review SLO burn rate
- [ ] Note any ongoing issues or mitigations
- [ ] Update incident channel with status

## Incident Response

### Step 1: Acknowledge (< 5 min)
```bash
# Check what's alerting
curl http://localhost:9091/api/v1/alerts | jq '.data.alerts[] | {labels: .labels, state: .state}'

# Quick health check
curl http://localhost:15051/healthz | jq .
```

### Step 2: Triage (< 15 min)
1. **Is it user-facing?** Check error rate in Grafana
2. **Is it a single service or systemic?** Check all health endpoints
3. **Is it a deployment?** Check recent deploys
4. **Is it infrastructure?** Check CPU/memory/disk

### Step 3: Mitigate (< 30 min)
See service-specific runbooks below.

### Step 4: Resolve
- Fix the root cause
- Verify fix with health checks
- Update incident status

### Step 5: Postmortem (< 48 hours)
- Fill out postmortem template (docs/POSTMORTEM-TEMPLATE.md)
- Schedule review meeting
- Create action items

## Service-Specific Runbooks

### API Server Down

**Symptoms**: Health endpoint returns 5xx, users can't authenticate

**Diagnosis**:
```bash
# Check container status
docker ps | grep api-server

# Check logs
docker logs egaop-api-server --tail 50

# Check if it's OOM
docker stats egaop-api-server --no-stream
```

**Common causes**:
1. **OOM kill** → Increase memory limit in docker-compose.yml
2. **Database connection refused** → Check postgres container
3. **Redis connection refused** → Check redis container
4. **Port conflict** → Check if another process uses port 3001

**Fix**:
```bash
# Restart the service
docker compose restart api-server

# If OOM, increase memory
# Edit docker-compose.yml → api-server → deploy.resources.limits.memory

# Full restart if needed
docker compose down && docker compose up -d api-server
```

### PostgreSQL Down

**Symptoms**: API returns 500, "connection refused" errors

**Diagnosis**:
```bash
# Check container
docker ps | grep postgres

# Check logs
docker logs egaop-postgres --tail 50

# Check connections
docker exec egaop-postgres psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"

# Check disk space
docker exec egaop-postgres df -h /var/lib/postgresql/data
```

**Common causes**:
1. **Disk full** → Run `scripts/backup.sh` then `VACUUM FULL`
2. **Connection limit reached** → Check pgbouncer config
3. **WAL accumulation** → Check `pg_stat_bgwriter`
4. **OOM kill** → Increase memory limit

**Fix**:
```bash
# Quick fix: restart
docker compose restart postgres

# Disk full: clean WAL
docker exec egaop-postgres psql -U postgres -c "CHECKPOINT;"
docker exec egaop-postgres psql -U postgres -c "VACUUM FULL;"

# Nuclear option: restore from backup
./scripts/restore-db.sh /path/to/backup.sql
```

### Redis Down

**Symptoms**: Sessions lost, rate limiting fails, slow responses

**Diagnosis**:
```bash
# Check container
docker ps | grep redis

# Check logs
docker logs egaop-redis --tail 50

# Check memory
docker exec egaop-redis redis-cli info memory | grep used_memory_human
```

**Fix**:
```bash
# Restart
docker compose restart redis

# Clear if corrupted
docker exec egaop-redis redis-cli FLUSHALL
```

### High Latency

**Symptoms**: P95 > 500ms, users complain about slowness

**Diagnosis**:
```bash
# Check current metrics
curl -s http://localhost:9091/api/v1/query?query=histogram_quantile(0.95,rate(http_request_duration_seconds_bucket[5m])) | jq '.data.result[0].value[1]'

# Check database slow queries
docker exec egaop-postgres psql -U postgres -c "SELECT pid, now() - pg_stat_activity.query_start AS duration, query FROM pg_stat_activity WHERE state = 'active' AND now() - pg_stat_activity.query_start > interval '5 seconds';"
```

**Common causes**:
1. **Slow database queries** → Add indexes, optimize queries
2. **LLM API latency** → Check OpenAI status, increase timeout
3. **Connection pool exhaustion** → Check pgbouncer metrics
4. **CPU saturation** → Scale up or optimize

**Fix**:
```bash
# Kill slow queries
docker exec egaop-postgres psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '30 seconds';"

# Restart if needed
docker compose restart api-server
```

### High Error Rate

**Symptoms**: > 1% of requests returning 5xx

**Diagnosis**:
```bash
# Check error breakdown
curl -s http://localhost:9091/api/v1/query?query=sum(rate(http_requests_total{status=~"5.."}[5m])) by (status) | jq '.data.result'

# Check recent deploys
docker compose logs api-server --since 1h | grep -i error | tail -20
```

**Fix**:
```bash
# If after a deploy: rollback
git revert HEAD
docker compose build api-server
docker compose up -d api-server

# If not deploy-related: restart
docker compose restart api-server
```

## Useful Commands

```bash
# Service status
docker compose ps

# All logs
docker compose logs -f --tail 100

# Specific service logs
docker compose logs -f api-server

# Restart everything
docker compose down && docker compose up -d

# Check resource usage
docker stats --no-stream

# Database shell
docker exec -it egaop-postgres psql -U postgres -d egaop

# Redis shell
docker exec -it egaop-redis redis-cli
```

## SLO Reference

| SLO | Target | Burn Rate Alert |
|-----|--------|----------------|
| Availability | 99.9% | 14.4x (1h) or 6x (6h) |
| Latency P95 | < 200ms | 10x (1h) or 3x (6h) |
| Error Rate | < 0.1% | 14.4x (1h) or 6x (6h) |

## Escalation Path

1. **On-Call Engineer** → Acknowledge, triage, mitigate
2. **Engineering Manager** → If P1 not resolved in 30 min
3. **VP Engineering** → If P1 not resolved in 1 hour
4. **CTO** → If customer data affected or security breach
