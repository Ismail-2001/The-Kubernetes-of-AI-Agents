# Runbooks

Playbooks for every alert rule defined in Grafana. Each runbook covers:
- **Symptoms** — what you'll see in Grafana, Slack, or logs
- **Severity** — critical vs warning, expected response time
- **Automated actions** — what the system does before you're notified
- **Diagnosis steps** — commands and queries to run
- **Remediation** — step-by-step fix
- **Verification** — how to confirm the issue is resolved
- **Escalation** — who to contact if you can't fix it

## Alert rules

| Alert | Severity | Runbook |
|-------|----------|---------|
| K8s AI Agents Service Down | critical | [service-down.md](service-down.md) |
| High Error Rate (>5% 5xx) | critical | [high-error-rate.md](high-error-rate.md) |
| High Latency P95 (>3s) | warning | [high-latency-p95.md](high-latency-p95.md) |
| Critical Latency P99 (>10s) | critical | [high-latency-p99.md](high-latency-p99.md) |
| Metrics Pipeline Dropping | warning | [collector-dropping.md](collector-dropping.md) |
