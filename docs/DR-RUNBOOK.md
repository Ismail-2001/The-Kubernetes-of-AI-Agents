# E-GAOP Disaster Recovery Runbook

## Quick Reference

| Metric | Target |
|--------|--------|
| **RPO** | <1 hour |
| **RTO** | <30 minutes |
| **Failover time** | <5 minutes |
| **Failback time** | <1 hour |

## DR Architecture

- Active-Passive: us-east-1 (primary), us-west-2 (secondary)
- PostgreSQL async streaming replication
- Redis Sentinel cross-region awareness
- Cloudflare DNS failover with health checks

```
                        ┌─────────────────────────────────────────────────────┐
                        │              Cloudflare DNS Failover                │
                        │          (Health checks every 30s)                  │
                        └───────────────┬────────────────────┬────────────────┘
                                        │                    │
                     ┌──────────────────▼──────────────────┐ │
                     │         us-east-1 (Primary)         │ │
                     │  ┌─────────┐  ┌─────────────────┐  │ │
                     │  │  Redis   │  │   PostgreSQL     │  │ │
                     │  │ Sentinel │  │  (Streaming      │  │ │
                     │  │          │  │   Replication)   │  │ │
                     │  └─────────┘  └─────────────────┘  │ │
                     │  ┌────────────────────────────────┐ │ │
                     │  │      Application Services       │ │ │
                     │  │  api-server, workflow-engine,    │ │ │
                     │  │  sandbox-runtime, etc.           │ │ │
                     │  └────────────────────────────────┘ │ │
                     └─────────────────────────────────────┘ │
                                        │                    │
                                        │  Replication       │
                                        ▼                    ▼
                     ┌─────────────────────────────────────┐ │
                     │        us-west-2 (Secondary)        │◄┘
                     │  ┌─────────┐  ┌─────────────────┐  │
                     │  │  Redis   │  │   PostgreSQL     │  │
                     │  │ Sentinel │  │  (Standby)       │  │
                     │  └─────────┘  └─────────────────┘  │
                     │  ┌────────────────────────────────┐ │
                     │  │      Application Services       │ │
                     │  │  (Idle, ready to promote)       │ │
                     │  └────────────────────────────────┘ │
                     └─────────────────────────────────────┘
```

## Failover Procedure (Primary Region Failure)

### Step 1: Detect (Automated)

- Alert fires: `ServiceDown` or `SyntheticProbeDown`
- Verify: Check Grafana dashboard for both regions
- Confirm: Primary region health probes failing for 3+ minutes

### Step 2: Assess (Manual, 2 minutes)

- Is this a transient issue? (network partition, temporary overload)
- Is this a full region outage? (AWS status page, multiple services affected)
- Decision: Wait (transient) OR Failover (confirmed outage)

### Step 3: Execute Failover

```bash
# Option A: Automated
./scripts/dr-failover.sh --region=us-west-2

# Option B: Manual (if scripts unavailable)
# 1. Promote PostgreSQL replica
docker exec postgres-secondary psql -U postgres -c "SELECT pg_promote();"

# 2. Update DNS (Cloudflare dashboard or API)
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/load_balancers/${LB_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"steering_policy":"failover","fallback_origin":"api-secondary.egaop.io"}'

# 3. Restart secondary services
docker compose -f docker-compose.yml -f docker-compose.deploy.yml up -d

# 4. Verify health
curl -f https://api-secondary.egaop.io/healthz
```

### Step 4: Verify (2 minutes)

```bash
./scripts/dr-verify.sh --region=secondary
```

- [ ] PostgreSQL accepting writes
- [ ] All health endpoints responding
- [ ] DNS resolving to secondary
- [ ] TLS certificates valid
- [ ] Users can log in
- [ ] Agents can execute

### Step 5: Communicate

- Update status page: "E-GAOP is operating from secondary region"
- Notify stakeholders via Slack/PagerDuty
- Begin incident timeline documentation

### Step 6: Monitor

- Watch secondary region metrics for 1 hour
- Verify no data loss (check audit log continuity)
- Monitor replication lag if primary recovers

## Failback Procedure (Primary Region Recovered)

### Step 1: Verify Primary Recovery

```bash
./scripts/dr-verify.sh --region=primary
```

### Step 2: Re-establish Replication

```bash
./scripts/dr-failback.sh
```

### Step 3: Switch DNS Back

- Update DNS to point to primary
- Wait for DNS propagation (TTL 60s)

### Step 4: Verify Full Recovery

- Run full test suite against primary
- Monitor for 1 hour before decommissioning secondary

## DR Drill Schedule

| Drill Type | Frequency | Duration | Participants |
|-----------|-----------|----------|-------------|
| Tabletop exercise | Monthly | 30 min | Engineering team |
| Partial failover test | Quarterly | 2 hours | SRE + Engineering |
| Full DR drill | Semi-annually | 4 hours | All teams |
| Backup restore test | Weekly | 30 min | SRE (automated) |

## DR Drill Checklist

### Pre-drill

- [ ] Notify team of planned drill
- [ ] Verify secondary region is healthy
- [ ] Verify backups are current (< 24 hours old)
- [ ] Clear any existing alerts

### During drill

- [ ] Simulate primary region failure (stop services, not destroy)
- [ ] Execute failover procedure
- [ ] Measure actual RTO (time to serve traffic)
- [ ] Verify data consistency
- [ ] Test user-facing functionality

### Post-drill

- [ ] Failback to primary
- [ ] Document actual vs target RPO/RTO
- [ ] Identify gaps and improvements
- [ ] Update runbook with lessons learned
- [ ] Send drill report to stakeholders

## Contact Information

| Role | Name | Contact |
|------|------|---------|
| Incident Commander | [TBD] | [TBD] |
| Primary SRE | [TBD] | [TBD] |
| Database Admin | [TBD] | [TBD] |
| Security Lead | [TBD] | [TBD] |

## Appendix: Key Commands

```bash
# PostgreSQL replication status
docker exec postgres psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# PostgreSQL promote replica
docker exec postgres-secondary psql -U postgres -c "SELECT pg_promote();"

# Redis Sentinel status
docker exec redis-sentinel redis-cli -p 26379 sentinel master mymaster

# Check DNS resolution
dig +short api.egaop.io

# Verify TLS certificate
echo | openssl s_client -connect api.egaop.io:443 2>/dev/null | openssl x509 -noout -dates
```
