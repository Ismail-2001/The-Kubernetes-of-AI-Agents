# E-GAOP Operational Runbook

## Incident Response Playbook

### Severity Levels

| Level | Description |
|-------|-------------|
| **P0** | Total outage, data loss risk |
| **P1** | Major feature degraded, >10% error rate |
| **P2** | Minor feature degraded, <10% error rate |
| **P3** | Cosmetic, non-urgent |

---

## Common Incidents

### 1. API Server Down (P0)

**Symptoms**
- `healthz` returns 503
- All REST endpoints timeout
- No responses from any API routes

**Diagnosis**
- Check Docker container status: `docker ps -a --filter "name=egaop"`
- Check API logs: `docker logs egaop-api-fixed --tail=200`
- Check for OOM kills: `docker inspect egaop-api-fixed | grep -i oom`
- Check host resource usage: `top`, `free -h`

**Mitigation**
- Restart container: `docker restart egaop-api-fixed`
- If unhealthy, recreate: `docker stop egaop-api-fixed && docker rm egaop-api-fixed` then redeploy
- If multiple replicas, ensure others are serving traffic

**Resolution**
- Identify root cause from logs (OOM, uncaught exception, bad config)
- Fix the underlying issue (code, config, resource limits)
- Redeploy and verify `healthz` returns 200

**Prevention**
- Set memory/CPU limits in docker-compose or Kubernetes
- Implement proper health checks with liveness/readiness probes
- Use Pod Disruption Budgets (PDB) for K8s deployments
- Monitor container restart counts

---

### 2. PostgreSQL Connection Exhausted (P1)

**Symptoms**
- `"sorry, too many clients already"` in logs
- 500 errors on API endpoints
- Slow or unresponsive database queries

**Diagnosis**
- Check active connections: `docker exec -it postgres psql -U postgres -d egaop -c "SELECT count(*) FROM pg_stat_activity;"`
- List connections by state: `docker exec -it postgres psql -U postgres -d egaop -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"`
- Check for idle connections: `docker exec -it postgres psql -U postgres -d egaop -c "SELECT pid, state, query_start FROM pg_stat_activity WHERE state = 'idle' ORDER BY query_start;"`
- Review API connection pool config

**Mitigation**
- Kill long-idle connections: `docker exec -it postgres psql -U postgres -d egaop -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND query_start < now() - interval '10 minutes';"`
- Restart API server to reset pool: `docker restart egaop-api-fixed`

**Resolution**
- Tune pool settings: reduce `DB_POOL_MAX`, add `DB_POOL_TIMEOUT`
- Implement connection pooling with PgBouncer in front of PostgreSQL
- Review code for connection leaks (unclosed connections, missing context managers)

**Prevention**
- Set `DB_POOL_MAX` conservatively (e.g., 5-10 per service instance)
- Configure `DB_POOL_TIMEOUT` and `DB_POOL_RECYCLE`
- Monitor `pg_stat_activity` count with Prometheus/Grafana
- Set PostgreSQL `max_connections` appropriately (default 100)

---

### 3. Redis Down (P1)

**Symptoms**
- Token revocation fails
- Refresh tokens fall back to in-memory store
- Session-related errors in logs

**Diagnosis**
- Check Redis container: `docker ps -a --filter "name=redis"`
- Ping Redis: `docker exec -it redis redis-cli ping`
- Check memory usage: `docker exec -it redis redis-cli info memory`
- Check for persistence errors in Redis logs: `docker logs redis --tail=100`

**Mitigation**
- Restart Redis: `docker restart redis`
- If data loss is acceptable, flush and restart: `docker exec -it redis redis-cli FLUSHALL && docker restart redis`
- Verify API reconnects after Redis is back

**Resolution**
- Review Redis config for persistence (AOF/RDB)
- Check memory limits vs usage
- Ensure Redis has adequate resources

**Prevention**
- Enable AOF persistence: `appendonly yes` in redis.conf
- Set `maxmemory` with appropriate `maxmemory-policy` (e.g., `allkeys-lru`)
- Monitor Redis memory and connection count
- Use Redis Sentinel or Replication for HA in production

---

### 4. Temporal Worker Crash Loop (P1)

**Symptoms**
- Workflows not executing or stuck in pending
- Worker pods restarting repeatedly
- Temporal UI shows no active workers for task queue

**Diagnosis**
- Check worker pod status: `kubectl get pods -l app=egaop-temporal-worker` (K8s) or `docker ps -a --filter "name=temporal"` (Docker)
- Check worker logs: `docker logs egaop-temporal-worker --tail=200`
- Check Temporal namespace: `temporal operator namespace describe egaop`
- Verify Temporal server is reachable

**Mitigation**
- Scale up healthy workers: `kubectl scale deployment egaop-temporal-worker --replicas=3`
- In Docker, restart: `docker restart egaop-temporal-worker`
- If Temporal server is down, restart it first

**Resolution**
- Fix worker code causing the crash (unhandled errors, missing dependencies)
- Check Temporal server health and namespace configuration
- Verify task queue has workers polling

**Prevention**
- Implement worker health checks and readiness probes
- Set resource limits on worker containers
- Use graceful shutdown handlers in worker code
- Monitor workflow task completion latency

---

### 5. High Error Rate Alert (P1)

**Symptoms**
- Prometheus alert firing for elevated 5xx rate
- Grafana dashboard shows >5% error rate
- Users reporting failures on specific features

**Diagnosis**
- Check Grafana dashboard for failing endpoint
- Review API logs: `docker logs egaop-api-fixed --tail=500 | grep -i error`
- Identify if errors are correlated with recent deployment
- Check downstream service health (database, Redis, Temporal)

**Mitigation**
- Rollback last deployment: `kubectl rollout undo deployment/egaop-api-server` (K8s) or redeploy previous image tag
- If single endpoint, consider disabling it via feature flag
- Scale up if error rate is due to load

**Resolution**
- Fix the bug or configuration issue
- Re-deploy with fix
- Verify error rate returns to baseline

**Prevention**
- Use canary deployments for risky changes
- Implement feature flags for new functionality
- Maintain comprehensive error tracking (Sentry, etc.)
- Set up SLO-based alerts, not just error rate

---

### 6. Certificate Expiry (P0)

**Symptoms**
- gRPC `"certificate has expired"` or `"certificate has expired or is not yet valid"` errors
- TLS handshake failures
- Clients cannot connect to services

**Diagnosis**
- Check cert expiry: `openssl x509 -in cert.pem -noout -dates`
- Check cert-manager logs (K8s): `kubectl logs -n cert-manager deployment/cert-manager`
- Verify Certificate resources: `kubectl get certificates -A`
- Check for failed CertificateRequest resources

**Mitigation**
- Force cert renewal (cert-manager): `kubectl delete certificate <name> -n <namespace>` (cert-manager will recreate)
- For manual certs: regenerate and reload
- If using Let's Encrypt, check rate limits

**Resolution**
- Ensure cert-manager is running and healthy
- Verify ClusterIssuer/Issuer configuration
- Confirm DNS is resolving correctly for HTTP-01 challenges
- Check for firewall rules blocking ACME traffic

**Prevention**
- Use cert-manager with automatic renewal (default: renews at 30 days before expiry)
- Monitor certificate expiry with Prometheus cert-manager exporter
- Set up alerts for certificates expiring within 14 days
- Test renewal process regularly

---

### 7. Disk Space Exhaustion (P1)

**Symptoms**
- `"No space left on device"` errors
- Containers failing to start
- Database write failures

**Diagnosis**
- Check disk usage: `df -h`
- Check Docker disk usage: `docker system df`
- Identify large files: `du -sh /* | sort -rh | head -10`
- Check log sizes: `du -sh /var/lib/docker/containers/*/logs`

**Mitigation**
- Prune Docker images: `docker system prune -a --volumes`
- Clear old logs: `truncate -s 0 /var/lib/docker/containers/<id>/<id>-json.log`
- Remove old backups if applicable

**Resolution**
- Expand volume/disk if consistently running out
- Implement log rotation in Docker daemon config
- Move large artifacts (backups, builds) to external storage

**Prevention**
- Configure Docker log rotation: `"log-opts": {"max-size": "10m", "max-file": "3"}`
- Set up monitoring for disk usage (alert at 80%)
- Implement automated cleanup cron jobs
- Use separate volumes for data and logs

---

## Scaling Procedures

### Horizontal Scaling

```bash
# Kubernetes
kubectl scale deployment egaop-api-server --replicas=5
kubectl scale deployment egaop-temporal-worker --replicas=3

# Docker Compose
docker-compose up -d --scale egaop-api=3
```

### Vertical Scaling

```bash
# Update resources in values.yaml or docker-compose.yml
# Then apply:
helm upgrade egaop ./charts/egaop -f values.yaml

# Or for Docker Compose:
docker-compose up -d
```

### Database Scaling

- PostgreSQL: Vertical scaling only (more CPU/RAM)
- Add PgBouncer for connection pooling before scaling reads
- Consider read replicas for read-heavy workloads

---

## Backup & Restore

### Backup

```bash
# Run automated backup
./scripts/backup.sh

# Manual PostgreSQL backup
docker exec postgres pg_dump -U postgres egaop > backup_$(date +%Y%m%d).sql
```

### Restore

```bash
# Run restore script
./scripts/restore.sh <backup_file>

# Manual restore
cat backup.sql | docker exec -i postgres psql -U postgres -d egaop
```

### RPO / RTO

| Metric | Target |
|--------|--------|
| **RPO** | 24 hours (daily backups) |
| **RTO** | <30 minutes |

---

## Useful Commands

```bash
# Container status
docker ps -a --filter "name=egaop"

# API logs
docker logs egaop-api-fixed --tail=100 -f

# Database connection count
docker exec -it postgres psql -U postgres -d egaop -c \
  "SELECT count(*) FROM pg_stat_activity;"

# Redis health check
docker exec -it redis redis-cli ping

# Health checks
curl http://localhost:3001/healthz
curl http://localhost:15051/healthz

# Disk usage
df -h
docker system df

# Docker cleanup
docker system prune -a --volumes

# Kubernetes pod status
kubectl get pods -n egaop
kubectl describe pod <pod-name> -n egaop
kubectl logs <pod-name> -n egaop --tail=200
```

---

## Escalation Path

| Level | Role | When to Escalate |
|-------|------|------------------|
| 1 | On-call engineer (you) | First responder, all incidents |
| 2 | Platform team lead | P0/P1 not resolved in 30 min, architectural decisions needed |
| 3 | Infrastructure/DevOps | Infrastructure failures, cloud provider issues |
| 4 | Security team | Auth/data breaches, suspicious activity, certificate compromise |
