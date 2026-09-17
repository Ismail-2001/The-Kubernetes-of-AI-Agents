# E-GAOP Capacity Planning

> Current usage, growth projections, and scaling recommendations.

## Current Infrastructure

| Component | Spec | Current Usage | Headroom |
|-----------|------|--------------|----------|
| API Server | 2 CPU / 512MB | 30% CPU / 256MB | 70% / 256MB |
| PostgreSQL | 2 CPU / 2GB | 20% CPU / 1GB | 80% / 1GB |
| Redis | 1 CPU / 256MB | 10% CPU / 64MB | 90% / 192MB |
| Grafana | 1 CPU / 512MB | 15% CPU / 128MB | 85% / 384MB |
| Prometheus | 1 CPU / 1GB | 25% CPU / 512MB | 75% / 512MB |

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
