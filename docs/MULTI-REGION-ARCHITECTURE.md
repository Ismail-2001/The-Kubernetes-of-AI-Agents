# E-GAOP Multi-Region Architecture

> **Status:** Proposed
> **Author:** Platform Engineering
> **Created:** 2026-09-16
> **Last Updated:** 2026-09-16
> **Supersedes:** Single-region architecture described in `docs/architecture.md`

---

## Executive Summary

This document defines the multi-region disaster recovery (DR) architecture for the Enterprise-Grade Agent Orchestration Platform (E-GAOP). The design follows an **Active-Passive** topology: the primary region (us-east-1) serves all production traffic, while a secondary region (us-west-2) maintains a warm standby for rapid failover.

### Target SLAs

| Metric | Target | Measurement |
|--------|--------|-------------|
| **RPO** (Recovery Point Objective) | < 1 hour | WAL archiving + continuous backup to cross-region S3 |
| **RTO** (Recovery Time Objective) | < 30 minutes | Automated failover scripts + DNS propagation |
| **Availability** | 99.95% annual | Dual-region coverage, single-region active |

### Design Principles

1. **Simplicity over perfection** -- Active-Passive avoids split-brain complexity of Active-Active with PostgreSQL
2. **Data durability first** -- PostgreSQL WAL streaming is the single source of truth for data replication
3. **Stateless services scale horizontally** -- API server, LLM router, tool-proxy can spin up in seconds
4. **Stateful services recover, not replicate** -- Temporal and sandbox-runtime are recreated from durable state on failover
5. **Observability in both regions** -- Both regions export metrics; secondary remote-writes to primary Grafana

---

## Architecture Overview

```
                              ┌─────────────────────────────────────────┐
                              │          Cloudflare DNS + Health Check   │
                              │    (30s interval, 3 failures to fail)   │
                              └──────────┬──────────────┬───────────────┘
                                         │              │
                              ┌──────────▼──────┐  ┌───▼──────────────┐
                              │  us-east-1       │  │  us-west-2        │
                              │  (PRIMARY)       │  │  (SECONDARY)      │
                              │                  │  │                   │
                              │  Full Stack      │  │  Warm Standby     │
                              │  All 10 services │  │  Essential only   │
                              │  2-3 replicas    │  │  1 replica each   │
                              └──────────────────┘  └──────────────────┘
```

---

## Primary Region (us-east-1)

The primary region runs the complete E-GAOP stack at full production capacity.

### Compute

| Service | Replicas | CPU Request | Memory Request | Purpose |
|---------|----------|-------------|----------------|---------|
| api-server | 3 | 200m | 256Mi | REST + gRPC gateway, JWT auth, agent CRUD |
| secret-store | 2 | 200m | 256Mi | AES-256-GCM encrypted secrets |
| workflow-engine | 3 | 250m | 256Mi | Temporal worker, ReAct orchestration |
| llm-router | 2 | 200m | 256Mi | Multi-model routing, fallback chains |
| tool-proxy | 2 | 200m | 256Mi | Tool execution proxy |
| sandbox-runtime | 2 | 500m | 512Mi | Docker container lifecycle |
| memory-plane | 2 | 200m | 256Mi | Redis + PostgreSQL memory layer |
| observability-plane | 2 | 200m | 256Mi | Trace ingestion, execution replay |
| admin-console | 2 | 100m | 128Mi | Next.js admin UI |
| otel-collector | 2 | 100m | 128Mi | OpenTelemetry trace/metric collection |

### Data Tier

| Component | Configuration |
|-----------|---------------|
| PostgreSQL 15 (pgvector) | Primary + 2 read replicas via streaming replication |
| Redis 7 | Primary + 3 Sentinel replicas, quorum=2 |
| Temporal 1.25 | 3-node cluster backed by PostgreSQL |
| PgBouncer | Transaction pooling, max 25 pool / 100 client connections |

### Observability

| Component | Role |
|-----------|------|
| Prometheus | Metrics storage, 10s scrape interval, 15-day retention |
| Grafana | Dashboards, 5 core alert rules, SLO tracking |
| Tempo | Distributed trace storage |
| Loki | Log aggregation |
| Blackbox Exporter | Synthetic HTTP probes on all service health endpoints |

---

## Secondary Region (us-west-2)

The secondary region runs a minimal warm standby footprint. It can absorb production traffic within 30 minutes of a failover trigger.

### Compute

| Service | Replicas | CPU Request | Memory Request | Purpose |
|---------|----------|-------------|----------------|---------|
| api-server | 1 | 200m | 256Mi | Accept traffic on failover |
| llm-router | 1 | 200m | 256Mi | LLM request routing |
| tool-proxy | 1 | 200m | 256Mi | Tool execution proxy |
| memory-plane | 1 | 200m | 256Mi | Connects to primary PG via streaming replica |
| secret-store | 1 | 200m | 256Mi | Reads from local PG replica |
| otel-collector | 1 | 100m | 128Mi | Remote-write to primary Prometheus |
| observability-plane | 1 | 200m | 256Mi | Reduced retention, local traces only |

**Not deployed in secondary (recovered on failover):**
- sandbox-runtime -- recreated on demand; no persistent local state
- workflow-engine -- recovers from PostgreSQL (Temporal state is durable)
- admin-console -- non-critical, can be accessed via primary VPN or restored later

### Data Tier

| Component | Configuration |
|-----------|---------------|
| PostgreSQL 15 | Async streaming replica from us-east-1 primary |
| Redis 7 | Single instance, no Sentinel (replicated from primary on failover) |
| Temporal | Not deployed; auto-setup from PostgreSQL on failover |

### Observability

| Component | Configuration |
|-----------|---------------|
| Prometheus | Lightweight, remote_writes to primary Prometheus (us-east-1) |
| Grafana | Not deployed; use primary Grafana with cross-region access |
| Tempo | Not deployed; traces shipped to primary via OTel remote-write |
| Loki | Not deployed; logs shipped via promtail to primary Loki |

---

## Data Replication Strategy

### PostgreSQL Streaming Replication

The primary database uses **asynchronous streaming replication** to ship WAL segments to the secondary region.

**Primary configuration (us-east-1):**

```ini
wal_level = replica
max_wal_senders = 3
wal_keep_size = 256MB
archive_mode = on
archive_command = 'aws s3 cp %p s3://egaop-wal-archive/us-east-1/%f --region us-east-1'
```

**Secondary replica (us-west-2):**

```ini
primary_conninfo = 'host=<primary-vpc-endpoint> port=5432 user=replicator password=<secret> sslmode=verify-full'
restore_command = 'aws s3 cp s3://egaop-wal-archive/us-east-1/%f /archive/%f --region us-west-2'
recovery_target_timeline = latest
```

**Replication lag monitoring:**

```sql
-- Run on primary every 30 seconds
SELECT
  client_addr,
  state,
  sent_lsn,
  write_lsn,
  replay_lsn,
  replay_lag
FROM pg_stat_replication;
```

**Alert threshold:** Replication lag > 5 minutes triggers PagerDuty warning. Lag > 15 minutes triggers critical alert.

### WAL Archiving to S3

WAL segments are archived to a cross-region S3 bucket for point-in-time recovery (PITR):

| Property | Value |
|----------|-------|
| Primary bucket | `egaop-wal-archive` (us-east-1 region) |
| Replication | Cross-region replication to `egaop-wal-archive-replica` (us-west-2) |
| Retention | 30 days (lifecycle policy) |
| Encryption | AES-256 server-side encryption |
| Backup cadence | Continuous (every WAL segment, ~16MB) |

### Redis Replication

Redis uses Sentinel-based replication with cross-region awareness:

- **Primary region:** Redis primary + 3 Sentinel instances (quorum=2)
- **Secondary region:** 1 Redis replica, configured to replicate from primary via VPC peering
- **Cross-region Sentinel:** Secondary region Sentinel monitors primary region Sentinel for failover coordination
- **Data loss risk:** Redis is used for working memory and quota counters only. Session and entity data live in PostgreSQL. Acceptable data loss on failover: up to 30 seconds of working memory state

### Temporal Workflow State

Temporal does **not** use cross-region replication. Instead:

- All workflow state is durably stored in PostgreSQL
- On failover, a new Temporal cluster is bootstrapped from the promoted PostgreSQL primary
- In-flight workflows will be re-executed from their last checkpoint (Temporal's built-in replay mechanism)
- Estimated recovery time: 5-10 minutes for Temporal cluster initialization + workflow replay

---

## Network Architecture

### VPC Topology

```
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│  VPC: us-east-1 (10.0.0.0/16)  │     │  VPC: us-west-2 (10.1.0.0/16)  │
│                                 │     │                                 │
│  ┌─────────────────────────┐   │     │  ┌─────────────────────────┐   │
│  │  Private Subnet (3 AZs) │   │     │  │  Private Subnet (3 AZs) │   │
│  │  - EKS Node Groups      │   │     │  │  - EKS Node Groups      │   │
│  │  - RDS Primary          │◄──┼─────┼──┼─ │  - RDS Read Replica     │   │
│  │  - ElastiCache Primary  │   │ VPC │  │  - ElastiCache Replica   │   │
│  └─────────────────────────┘   │ Peering│  └─────────────────────────┘   │
│                                 │     │                                 │
│  ┌─────────────────────────┐   │     │  ┌─────────────────────────┐   │
│  │  Public Subnet (3 AZs)  │   │     │  │  Public Subnet (3 AZs)  │   │
│  │  - ALB / NLB            │   │     │  │  - ALB / NLB            │   │
│  │  - NAT Gateway          │   │     │  │  - NAT Gateway          │   │
│  └─────────────────────────┘   │     │  └─────────────────────────┘   │
└─────────────────────────────────┘     └─────────────────────────────────┘
```

### DNS Failover

| Component | Configuration |
|-----------|---------------|
| Provider | Cloudflare (or Route53 if AWS-native) |
| Health check | HTTP probe on `api-server:15051/healthz`, 30s interval |
| Failover threshold | 3 consecutive failures (90 seconds) |
| DNS TTL | 60 seconds (low for fast failover) |
| Failover record | `api.egaop.dev` -> us-east-1 (primary), us-west-2 (secondary) |
| Geographic routing | Optional: route us-west users to secondary for lower latency |

### TLS Certificate Management

- cert-manager with Let's Encrypt ClusterIssuer
- Auto-renewal 30 days before expiry
- Both regions share the same certificate via cert-manager (each region has its own issuer)
- Wildcard certificate: `*.egaop.dev`

### Cross-Region Traffic

| Traffic Type | Path | Protocol | Bandwidth |
|-------------|------|----------|-----------|
| PostgreSQL WAL | Primary -> S3 -> Secondary | S3 API (HTTPS) | ~10-50 MB/min |
| Redis replication | Primary -> Secondary | Redis protocol (TLS) | ~5-20 MB/min |
| OTel metrics | Secondary -> Primary | OTLP/gRPC (TLS) | ~1-5 MB/min |
| API failover | DNS -> Secondary | HTTPS (public) | Variable |
| Inter-service gRPC | Within region only | gRPC (mTLS) | N/A |

---

## Failover Process

### Automated Failover (Preferred)

Automated failover is triggered when the primary region becomes unhealthy. The process is orchestrated by Cloudflare health checks + a failover controller.

**Trigger conditions:**
- 3 consecutive health check failures on `api.egaop.dev` (30s interval = 90s detection)
- OR manual trigger via `./scripts/dr-failover.sh --region=us-west-2`

**Automated sequence:**

```
T+0s    Health check failure detected (Cloudflare)
T+90s   3 consecutive failures, failover triggered
T+91s   DNS record updated: api.egaop.dev -> us-west-2 ALB
T+91s   Secondary API servers begin accepting traffic
T+92s   PostgreSQL replica promoted to primary (aws rds promote-db-instance)
T+95s   Redis Sentinel elects new master in us-west-2
T+120s  Sandbox runtime scaled from 0 to 2 replicas
T+150s  Temporal cluster bootstrapped from PostgreSQL
T+180s  Workflow engine scaled from 0 to 3 replicas
T+300s  All services healthy, traffic flowing through secondary
```

**Total estimated time:** ~5 minutes (automated) to ~30 minutes (including Temporal recovery)

### Manual Failover (Fallback)

When automated failover is not possible (e.g., partial degradation), the incident commander can trigger manual failover:

```bash
# 1. Verify primary is unhealthy
./scripts/dr-verify.sh --region=us-east-1 --expect=unhealthy

# 2. Trigger failover
./scripts/dr-failover.sh --region=us-west-2 --manual

# 3. Verify secondary is healthy
./scripts/dr-verify.sh --region=us-west-2 --expect=healthy

# 4. Notify team
./scripts/dr-notify.sh --event=failover --region=us-west-2
```

### Failover Script (`scripts/dr-failover.sh`)

The failover script performs the following steps:

1. **Lock coordination** -- Acquires a distributed lock in DynamoDB/etcd to prevent concurrent failovers
2. **DNS switch** -- Updates Cloudflare DNS record via API to point to secondary region
3. **Database promotion** -- Promotes PostgreSQL read replica to primary in us-west-2
4. **Redis failover** -- Triggers Sentinel master election in secondary region
5. **Service scaling** -- Scales up sandbox-runtime and workflow-engine from 0 to target replicas
6. **Temporal bootstrap** -- Runs `temporal-sql-tool setup` against the new primary PostgreSQL
7. **Health verification** -- Runs synthetic probes against secondary region
8. **Notification** -- Sends PagerDuty/Slack notification with failover status

---

## Failback Process

Failback (returning to us-east-1) is a **manual process** to avoid oscillation.

### Prerequisites
- us-east-1 infrastructure is healthy and verified
- PostgreSQL replication from us-west-2 (new primary) to us-east-1 is established
- Replication lag is < 30 seconds for at least 10 minutes

### Failback Steps

```bash
# 1. Verify primary region is healthy
./scripts/dr-verify.sh --region=us-east-1 --expect=healthy

# 2. Establish reverse replication (us-west-2 primary -> us-east-1 replica)
./scripts/dr-setup-replication.sh --source=us-west-2 --target=us-east-1

# 3. Wait for replication to stabilize
./scripts/dr-check-replication.sh --expect-lag=30s --duration=600s

# 4. Execute failback
./scripts/dr-failback.sh --target=us-east-1

# 5. Verify
./scripts/dr-verify.sh --region=us-east-1 --expect=healthy
./scripts/dr-verify.sh --region=us-west-2 --expect=standby

# 6. Monitor for 1 hour before decommissioning secondary standby
./scripts/dr-monitor.sh --region=us-east-1 --duration=3600s
```

### Failback Duration
- Replication setup: ~10-30 minutes (depends on database size)
- DNS propagation: ~60 seconds
- Service startup: ~5 minutes
- Total: ~20-40 minutes

---

## Monitoring & Alerting

### Region Health Dashboard

A dedicated Grafana dashboard (`Region Health`) displays:

- Region status (healthy/degraded/unhealthy) per service
- Cross-region replication lag (PostgreSQL, Redis)
- DNS failover status and last failover time
- Active connection counts per region
- Error rates per region (comparison view)

### Alert Rules

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| `ReplicationLagWarning` | PG replication lag > 5 min | Warning | PagerDuty warning |
| `ReplicationLagCritical` | PG replication lag > 15 min | Critical | PagerDuty critical |
| `RegionUnhealthy` | >50% service health checks failing | Critical | Page incident commander |
| `FailoverTriggered` | DNS failover event detected | Critical | Page entire on-call |
| `FailbackReady` | Primary region healthy + replication stable | Info | Notify platform team |
| `BackupFailed` | WAL archive upload fails | Warning | PagerDuty warning |
| `RedisReplicationBroken` | Redis replica disconnected > 2 min | Warning | PagerDuty warning |

### Synthetic Monitoring

Both regions run synthetic probes via Blackbox Exporter:

| Probe | Target | Interval | Expected |
|-------|--------|----------|----------|
| HTTP 2xx | `api-server:15051/healthz` | 10s | Status 200 |
| HTTP 2xx | `llm-router:15053/healthz` | 10s | Status 200 |
| HTTP 2xx | `tool-proxy:15052/healthz` | 10s | Status 200 |
| gRPC health | `api-server:50051` | 30s | Serving |
| Cross-region | `us-west-2/api.egaop.dev/healthz` | 60s | Status 200 |

### Prometheus Cross-Region Configuration

**Secondary region Prometheus (us-west-2):**

```yaml
remote_write:
  - url: "http://prometheus.us-east-1.internal:9090/api/v1/write"
    tls_config:
      cert_file: /etc/prometheus/certs/client.crt
      key_file: /etc/prometheus/certs/client.key
    write_relabel_configs:
      - source_labels: [__name__]
        regex: "egaop_.*"
        action: keep
```

---

## Cost Considerations

### Secondary Region Cost Estimate

| Component | Primary (us-east-1) | Secondary (us-west-2) | Notes |
|-----------|---------------------|----------------------|-------|
| EKS Nodes | ~$2,400/mo (6x m5.xlarge) | ~$800/mo (2x m5.large) | 1/3 capacity |
| RDS PostgreSQL | ~$1,200/mo (db.r6g.xlarge) | ~$400/mo (db.r6g.large, replica) | Read replica pricing |
| ElastiCache Redis | ~$600/mo (cache.r6g.large) | ~$200/mo (cache.t4g.medium) | Smaller instance |
| S3 (WAL archive) | ~$50/mo | ~$50/mo (replication) | Cross-region replication |
| Cloudflare | Included | Included | Health checks included in plan |
| OTel / Prometheus | Included | ~$50/mo (remote-write) | Minimal additional cost |
| **Total** | **~$4,250/mo** | **~$1,550/mo** | **~36% of primary** |

### Cost Optimization Strategies

1. **Spot instances** for non-critical secondary services (admin-console, observability-plane)
2. **Scheduled scaling** -- scale down secondary to minimal during off-peak hours (if not needed for DR)
3. **Reserved instances** -- 1-year commitment for secondary RDS and EKS saves ~30%
4. **Right-sizing** -- secondary uses smaller instance types (db.r6g.large vs db.r6g.xlarge)

---

## Testing

### DR Drill Schedule

| Test Type | Frequency | Duration | Scope |
|-----------|-----------|----------|-------|
| Full failover drill | Quarterly | 2-4 hours | Complete failover + failback |
| Partial failover | Monthly | 1-2 hours | Failover database only |
| Backup restoration | Weekly | 1 hour | Restore from WAL archive to new instance |
| Chaos engineering | Monthly | 1 hour | Region failure simulation (using Litmus Chaos) |

### DR Drill Checklist

```bash
# Pre-drill
- [ ] Notify team (Slack #incidents channel)
- [ ] Verify secondary region is healthy
- [ ] Verify replication lag is < 30 seconds
- [ ] Take snapshot of primary database

# During drill
- [ ] Execute failover: ./scripts/dr-failover.sh --region=us-west-2 --drill
- [ ] Verify all services healthy in secondary
- [ ] Run synthetic probes for 15 minutes
- [ ] Verify Temporal workflows resume correctly
- [ ] Verify LLM router connects to providers from secondary

# Post-drill
- [ ] Execute failback: ./scripts/dr-failback.sh --target=us-east-1
- [ ] Verify primary region is healthy
- [ ] Verify replication re-established
- [ ] Document any issues found
- [ ] Update runbook if procedures changed
```

### Chaos Engineering

Monthly chaos tests using Litmus Chaos or Gremlin:

| Experiment | Target | Expected Outcome |
|------------|--------|------------------|
| Region network partition | us-east-1 | Failover to us-west-2 within 5 min |
| PostgreSQL primary crash | us-east-1 | Replica promoted, secondary takes over |
| Redis primary crash | us-east-1 | Sentinel elects new master |
| DNS failure | Cloudflare | Failover still works via Route53 health checks |
| Partial degradation | api-server pods | HPA scales up, no failover needed |

---

## Implementation Roadmap

### Phase 1: Foundation (Weeks 1-4)
- [ ] Set up VPC peering between us-east-1 and us-west-2
- [ ] Configure S3 cross-region WAL archiving
- [ ] Deploy PostgreSQL read replica in us-west-2
- [ ] Set up Cloudflare health checks + DNS failover records
- [ ] Create `scripts/dr-failover.sh` and `scripts/dr-failback.sh`

### Phase 2: Secondary Region (Weeks 5-8)
- [ ] Deploy minimal EKS cluster in us-west-2
- [ ] Deploy essential services (api-server, llm-router, tool-proxy, memory-plane, secret-store)
- [ ] Configure Prometheus remote-write from secondary to primary
- [ ] Set up Redis replication from primary to secondary
- [ ] Deploy Blackbox Exporter for cross-region synthetic probes

### Phase 3: Automation (Weeks 9-12)
- [ ] Implement automated failover controller
- [ ] Create DR drill automation scripts
- [ ] Set up PagerDuty integration for region health alerts
- [ ] Build Region Health Grafana dashboard
- [ ] Run first DR drill

### Phase 4: Hardening (Weeks 13-16)
- [ ] Chaos engineering integration (Litmus/Gremlin)
- [ ] Load testing from secondary region
- [ ] Failback automation and testing
- [ ] Documentation and runbook updates
- [ ] Cost optimization review

---

## Appendix A: Service Distribution Matrix

| Service | Primary (us-east-1) | Secondary (us-west-2) | Failover Behavior | Data Dependency |
|---------|---------------------|----------------------|-------------------|-----------------|
| api-server | 3 replicas | 1 replica | Immediate traffic acceptance | PostgreSQL, Redis |
| llm-router | 2 replicas | 1 replica | Immediate (stateless) | None (connects to LLM providers) |
| tool-proxy | 2 replicas | 1 replica | Immediate (stateless) | None (proxies to sandbox) |
| sandbox-runtime | 2 replicas | 0 | Scale to 2 on failover | Docker socket |
| memory-plane | 2 replicas | 1 replica | Immediate | PostgreSQL, Redis |
| workflow-engine | 3 replicas | 0 | Scale to 3, recover from PG | PostgreSQL (Temporal state) |
| secret-store | 2 replicas | 1 replica | Immediate | PostgreSQL |
| observability-plane | 2 replicas | 1 replica | Immediate (reduced) | PostgreSQL |
| admin-console | 2 replicas | 0 | Scale on demand | PostgreSQL |
| otel-collector | 2 replicas | 1 | Remote-write to primary | S3 (trace export) |

---

## Appendix B: Environment Variables (Secondary Region)

The secondary region uses the same container images but with region-specific environment overrides:

```bash
# Region identifier
EAGAOP_REGION=us-west-2
EAGAOP_IS_PRIMARY=false

# Database (points to local read replica, promoted on failover)
POSTGRES_HOST=egaop-postgres.us-west-2.rds.amazonaws.com
POSTGRES_PORT=5432

# Redis (points to local instance)
REDIS_HOST=egaop-redis.us-west-2.cache.amazonaws.com
REDIS_PORT=6379

# Temporal (not deployed until failover)
TEMPORAL_HOST=temporal.us-west-2.internal
TEMPORAL_PORT=7233

# Observability (remote-write to primary)
PROMETHEUS_REMOTE_WRITE_URL=http://prometheus.us-east-1.internal:9090/api/v1/write
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.us-east-1.internal:4317

# DNS (secondary region health check endpoint)
HEALTH_CHECK_PORT=15051
```

---

## Appendix C: Helm Values Override (Secondary Region)

```yaml
# charts/e-gaop/values-secondary.yaml
global:
  imageRegistry: ghcr.io
  imagePullSecrets: []
  serviceMonitorEnabled: false

# Reduced replica counts
api-server:
  replicas: 1
  hpa:
    enabled: false

llm-router:
  replicas: 1
  hpa:
    enabled: false

tool-proxy:
  replicas: 1
  hpa:
    enabled: false

memory-plane:
  replicas: 1
  hpa:
    enabled: false

secret-store:
  replicas: 1
  hpa:
    enabled: false

observability-plane:
  replicas: 1
  hpa:
    enabled: false

# Services not deployed in secondary
sandbox-runtime:
  enabled: false

workflow-engine:
  enabled: false

admin-console:
  enabled: false

# Infrastructure
temporal:
  enabled: false

redis:
  architecture: standalone
  master:
    persistence:
      size: 2Gi

postgresql:
  enabled: false  # Use external RDS read replica
```

---

## Appendix D: Failback Decision Tree

```
Is primary region healthy?
├── YES: Is replication lag < 30s for > 10 min?
│   ├── YES: Execute failback (scripts/dr-failback.sh)
│   └── NO: Wait for replication to stabilize, re-check in 5 min
└── NO: Continue operating from secondary, investigate primary
```

---

## Appendix E: Related Documents

| Document | Path |
|----------|------|
| Architecture Blueprint | `ARCHITECTURE.md` |
| Five-Plane Architecture | `docs/architecture.md` |
| Production Readiness | `docs/production-readiness-final.md` |
| Operational Runbook | `docs/OPERATIONAL-RUNBOOK.md` |
| Security | `docs/security.md` |
| SLO Baseline | `docs/SLO-BASELINE.md` |
| Troubleshooting | `docs/troubleshooting.md` |
