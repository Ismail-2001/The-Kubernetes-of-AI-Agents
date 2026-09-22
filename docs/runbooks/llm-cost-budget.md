# Runbook: LLM Cost Budget Exceeded

**Alert:** `LLMCostBudgetExceeded`
**Severity:** Critical
**Response Time:** 15 minutes

## Symptoms
- Estimated LLM cost > $50/hour
- Token consumption rate very high
- Users report slow LLM responses

## Impact
- Financial impact: exceeding budget allocation
- LLM provider rate limits may kick in
- Service degradation for all LLM-dependent features

## Investigation

### 1. Check current token rate
```bash
kubectl exec -n monitoring egaop-prometheus-server-xxx -c prometheus-server -- \
  wget -qO- "http://localhost:9090/api/v1/query?query=sum(rate(e_gaop_llm_tokens_used_total[5m]))"
```

### 2. Identify which model/provider is consuming most
```bash
kubectl exec -n monitoring egaop-prometheus-server-xxx -c prometheus-server -- \
  wget -qO- "http://localhost:9090/api/v1/query?query=sum(rate(e_gaop_llm_tokens_used_total[5m]))by(model)"
```

### 3. Check for runaway agents
```bash
kubectl exec -n monitoring egaop-prometheus-server-xxx -c prometheus-server -- \
  wget -qO- "http://localhost:9090/api/v1/query?query=e_gaop_active_agents"
```

## Remediation

### Immediate: Rate limit LLM calls
```bash
# Reduce LLM router RPM limit
kubectl patch configmap egaop-e-gaop-config -n egaop -p '{"data":{"LLM_RATE_LIMIT_RPM":"30"}}'
kubectl rollout restart deployment/egaop-llm-router -n egaop
```

### Identify and stop runaway agents
```bash
# Check active workflows
kubectl exec -n egaop egaop-workflow-engine-xxx -- \
  curl -s http://localhost:15058/readyz | jq '.checks.temporal'
```

### Emergency: Disable non-critical LLM features
```bash
# Disable autonomous agent execution (keep user-initiated only)
kubectl set env deployment/egaop-workflow-engine -n egaop AUTONOMOUS_AGENTS_ENABLED=false
```

## Prevention
- Set up per-namespace cost budgets
- Monitor token consumption trends
- Implement LLM cost alerts at lower thresholds ($20/hr warning)

## Escalation
- If cost > $100/hr: Page engineering lead immediately
- If provider rate limited: Contact LLM provider support
