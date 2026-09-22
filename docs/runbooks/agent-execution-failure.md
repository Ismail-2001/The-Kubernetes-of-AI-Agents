# Runbook: Agent Execution Failure Spike

**Alert:** `AgentExecutionFailureSpike`
**Severity:** Critical
**Response Time:** 15 minutes

## Symptoms
- Agent execution failure rate >10% of total spans
- Users report agents failing to complete tasks
- Error logs show repeated execution failures

## Impact
- Agents cannot complete assigned tasks
- User-facing workflows are broken
- Error budget consumption accelerates

## Investigation

### 1. Identify failing service
```bash
# Check which service has the highest failure rate
kubectl logs -n egaop -l app.kubernetes.io/name=workflow-engine --tail=100 | grep -i "error\|fail"

# Check OTel collector metrics
kubectl exec -n monitoring egaop-prometheus-server-xxx -c prometheus-server -- \
  wget -qO- "http://localhost:9090/api/v1/query?query=sum(rate(e_gaop_otelcol_exporter_send_failed_spans[5m]))by(app_kubernetes_io_name)"
```

### 2. Check dependency health
```bash
# Database connectivity
kubectl exec -n egaop egaop-api-server-xxx -- pg_isready -h egaop-postgresql

# Redis connectivity
kubectl exec -n egaop egaop-api-server-xxx -- redis-cli -h egaop-redis-master ping

# Temporal connectivity (if applicable)
kubectl exec -n egaop egaop-workflow-engine-xxx -- curl -s http://temporal:7233
```

### 3. Check for recent changes
```bash
# Recent deployments
kubectl rollout history deployment -n egaop

# Recent config changes
kubectl get configmap -n egaop -o yaml | grep -A5 "last-applied"
```

## Remediation

### Quick fix: Restart affected service
```bash
kubectl rollout restart deployment/<service-name> -n egaop
```

### If dependency is down
```bash
# Restart PostgreSQL
kubectl rollout restart statefulset/egaop-postgresql -n egaop

# Restart Redis
kubectl rollout restart statefulset/egaop-redis-master -n egaop
```

### If OPA circuit breaker is open
```bash
# Check OPA status
kubectl exec -n egaop egaop-opa-xxx -- wget -qO- http://localhost:8181/health

# Reset circuit breaker (restart OPA)
kubectl rollout restart deployment/egaop-opa -n egaop
```

## Prevention
- Monitor error budget consumption
- Set up synthetic monitoring for agent execution paths
- Review agent execution logs weekly for patterns

## Escalation
- If dependency down for >15 min: Page database/infrastructure team
- If error budget exhausted: Escalate to engineering lead
