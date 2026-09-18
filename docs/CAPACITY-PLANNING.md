# E-GAOP Capacity Planning

> Current usage, growth projections, and scaling recommendations.

## Current Infrastructure

### Actual Resource Usage (Measured 2026-09-18)

| Service | CPU % | Memory Used | Memory Limit | Memory % | Status |
|---------|-------|-------------|-------------|----------|--------|
| api-server | 0.02% | 91.86 MiB | 512 MiB | 17.94% | Healthy |
| postgres | 0.65% | 56.36 MiB | 1 GiB | 5.50% | Healthy |
| redis | 1.17% | 14.76 MiB | 512 MiB | 2.88% | Healthy |
| pgbouncer | 0.07% | 9.20 MiB | 256 MiB | 3.59% | Healthy |
| otel-collector | 0.04% | 145.20 MiB | 7.66 GiB | 1.85% | Running |
| prometheus | 1.94% | 91.84 MiB | 7.66 GiB | 1.17% | Running |
| grafana | 0.12% | 155.00 MiB | 7.66 GiB | 1.98% | Running |
| loki | 1.28% | 82.23 MiB | 7.66 GiB | 1.05% | Healthy |
| blackbox-exporter | 0.00% | 26.02 MiB | 128 MiB | 20.32% | Healthy |
| admin-console | 0.02% | 45.52 MiB | 7.66 GiB | 0.58% | Healthy |
| memory-plane | 0.00% | 41.75 MiB | 256 MiB | 16.31% | Healthy |
| sandbox-runtime | 0.52% | 37.80 MiB | 1 GiB | 3.69% | Healthy |
| base-runtime | 0.00% | 23.87 MiB | 7.66 GiB | 0.30% | Healthy |
| docker-socket-proxy | 0.00% | 25.50 MiB | 7.66 GiB | 0.33% | Running |
| secret-store | 0.00% | 0 MiB | — | — | Starting |
| tool-proxy | 0.00% | 0 MiB | — | — | Starting |
| observability-plane | 0.00% | 0 MiB | — | — | Starting |
| llm-router | 0.00% | 0 MiB | — | — | Starting |
| workflow-engine | 47.52% | 21.72 MiB | 512 MiB | 4.24% | Restarting* |
| opa | 0.00% | 0 MiB | — | — | Restarting* |

> *workflow-engine and opa are restarting due to pre-existing dependency issues (missing `@jsonjoy.com/fs-node` and rego parse errors respectively).

### Aggregate Resource Totals

| Metric | Value |
|--------|-------|
| Total services | 20 (18 custom + 2 infra) |
| Healthy services | 14 |
| Total memory used | ~870 MiB |
| Total memory allocated | ~35 GiB |
| Total CPU used | ~3% |
| Total containers | 20 |

### Previous Estimated vs Actual

| Component | Estimated | Actual | Delta |
|-----------|-----------|--------|-------|
| API Server | 30% CPU / 256MB | 0.02% / 92MB | Significantly lower |
| PostgreSQL | 20% CPU / 1GB | 0.65% / 56MB | Significantly lower |
| Redis | 10% CPU / 64MB | 1.17% / 15MB | Significantly lower |
| Grafana | 15% CPU / 128MB | 0.12% / 155MB | Memory slightly higher |
| Prometheus | 25% CPU / 512MB | 1.94% / 92MB | Significantly lower |

> Note: Measured at idle (no active agent traffic). Production load will increase usage significantly.

## Usage Patterns

### Request Volume
| Time Period | Requests/sec | Peak | Average |
|-------------|-------------|------|---------|
| Business hours | 50-100 | 150 | 75 |
| Off-hours | 10-20 | 30 | 15 |
| Weekends | 5-10 | 15 | 8 |

### Agent Executions
| Metric | Current | 3 months | 6 months |
|--------|---------|----------|----------|
| Daily executions | 500 | 1,500 | 5,000 |
| Concurrent agents | 10 | 30 | 100 |
| Avg execution time | 2s | 2s | 2s |

### Storage
| Component | Current | Growth Rate | Full in |
|-----------|---------|------------|---------|
| PostgreSQL | 5GB | 1GB/month | 18 months |
| Logs | 2GB | 500MB/month | 12 months |
| Traces | 1GB | 200MB/month | 18 months |
| Backups | 10GB | 2GB/month | 12 months |

## Scaling Triggers

### Scale Up When:
- CPU > 70% for 10 minutes
- Memory > 80% for 5 minutes
- P95 latency > 500ms for 10 minutes
- Error rate > 1% for 5 minutes
- Disk > 80% usage

### Scale Down When:
- CPU < 30% for 1 hour
- Memory < 50% for 1 hour
- No traffic for 1 hour (dev/staging only)

## Scaling Recommendations

### Immediate (0-3 months)
| Action | Trigger | Cost Impact |
|--------|---------|-------------|
| Increase API server memory to 1GB | Memory > 80% | +$10/month |
| Add PostgreSQL read replica | Read latency > 200ms | +$50/month |
| Enable Redis cluster mode | Memory > 80% | +$20/month |

### Medium-term (3-6 months)
| Action | Trigger | Cost Impact |
|--------|---------|-------------|
| Move to EKS with auto-scaling | Traffic > 200 req/s | +$200/month |
| Add CDN for static assets | Bandwidth > 100GB/month | +$50/month |
| Implement request queuing | Queue depth > 100 | +$30/month |

### Long-term (6-12 months)
| Action | Trigger | Cost Impact |
|--------|---------|-------------|
| Multi-region deployment | Users > 1000 | +$500/month |
| Dedicated LLM endpoints | LLM cost > $5000/month | Variable |
| Data warehouse for analytics | Data > 100GB | +$100/month |

## Cost Projections

| Month | Infrastructure | LLM | Total | Budget |
|-------|---------------|-----|-------|--------|
| Month 1 | $500 | $1,000 | $1,500 | $2,000 |
| Month 2 | $600 | $1,500 | $2,100 | $2,500 |
| Month 3 | $800 | $2,000 | $2,800 | $3,000 |
| Month 6 | $1,200 | $3,000 | $4,200 | $5,000 |
| Month 12 | $2,000 | $5,000 | $7,000 | $8,000 |

## Review Schedule

| Review | Frequency | Participants |
|--------|-----------|-------------|
| Capacity review | Monthly | Platform team |
| Cost review | Monthly | Platform + Finance |
| Scaling test | Quarterly | Platform + SRE |
| DR drill | Quarterly | Full team |
