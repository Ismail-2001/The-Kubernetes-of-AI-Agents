# Runbooks

Playbooks for every alert rule defined in E-GAOP. Each runbook covers:
- **Symptoms** — what you'll see in Grafana, Slack, or logs
- **Severity** — critical vs warning, expected response time
- **Diagnosis steps** — commands and queries to run
- **Remediation** — step-by-step fix
- **Escalation** — who to contact if you can't fix it

For everyday development and debugging, see the [Developer Guide](../developer-guide.md).

## Alert Rules → Runbooks

| Alert | Severity | Response | Runbook |
|-------|----------|----------|---------|
| **ServiceDown** | critical | 5 min | [service-down.md](service-down.md) |
| **HighErrorRate** | critical | 15 min | [high-error-rate.md](high-error-rate.md) |
| **HighGrpcLatency** | warning | 1 hour | [high-latency-p95.md](high-latency-p95.md) |
| **HighGrpcLatencyP99** | critical | 15 min | [high-latency-p99.md](high-latency-p99.md) |
| **AgentExecutionFailureSpike** | critical | 15 min | [agent-execution-failure.md](agent-execution-failure.md) |
| **OpaCircuitBreakerOpen** | critical | 5 min | [opa-circuit-breaker.md](opa-circuit-breaker.md) |
| **ToolExecutionP99High** | warning | 1 hour | [high-latency-p95.md](high-latency-p95.md) |
| **LLMCostBudgetExceeded** | critical | 15 min | [llm-cost-budget.md](llm-cost-budget.md) |
| **LLMTokenRateHigh** | warning | 1 hour | [llm-cost-budget.md](llm-cost-budget.md) |
| **ActiveAgentsHigh** | warning | 1 hour | [scaling.md](scaling.md) |
| **SandboxCreationFailure** | critical | 10 min | [sandbox-creation-failure.md](sandbox-creation-failure.md) |
| **SyntheticProbeDown** | critical | 5 min | [service-down.md](service-down.md) |
| **SyntheticProbeSlow** | warning | 1 hour | [high-latency-p95.md](high-latency-p95.md) |
| **BlackboxProbeDown** | critical | 5 min | [service-down.md](service-down.md) |
| **PodOOMKilled** | critical | 5 min | [scaling.md](scaling.md) |
| **PodCrashLooping** | warning | 15 min | [service-down.md](service-down.md) |
| **PVCNearFull** | warning | 1 hour | [backup-restore.md](backup-restore.md) |
| **HighCPUThrottling** | warning | 1 hour | [scaling.md](scaling.md) |
| **HighMemoryUsage** | warning | 1 hour | [scaling.md](scaling.md) |

## SLO Burn Rate Alerts

| Alert | Severity | Response | Runbook |
|-------|----------|----------|---------|
| **EgaopSLOBurnRateHigh** | critical | 2 min | [service-down.md](service-down.md) |
| **EgaopSLOBurnRateHigh30m** | critical | 5 min | [high-error-rate.md](high-error-rate.md) |
| **EgaopSLOBurnRateWarning** | warning | 15 min | [high-error-rate.md](high-error-rate.md) |
| **EgaopAvailabilityBelowSLO** | critical | 5 min | [service-down.md](service-down.md) |
| **EgaopLatencyP95AboveSLO** | warning | 5 min | [high-latency-p95.md](high-latency-p95.md) |
| **EgaopErrorBudgetExhausted** | warning | 30 min | [high-error-rate.md](high-error-rate.md) |

## Operational Runbooks

| Topic | Runbook |
|-------|---------|
| Scaling procedures | [scaling.md](scaling.md) |
| Incident response | [incident-response.md](incident-response.md) |
| Backup & restore | [backup-restore.md](backup-restore.md) |
| Collector pipeline | [collector-dropping.md](collector-dropping.md) |
