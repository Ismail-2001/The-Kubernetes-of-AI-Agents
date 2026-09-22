# Runbook: OPA Circuit Breaker Open

**Alert:** `OpaCircuitBreakerOpen`
**Severity:** Critical
**Response Time:** 5 minutes

## Symptoms
- OPA circuit breaker state = 1 (OPEN)
- All authorization checks failing closed
- Users cannot access any agent functionality

## Impact
- Complete authorization outage
- All agent operations blocked
- User-facing errors across the platform

## Investigation

### 1. Check OPA health
```bash
kubectl exec -n egaop egaop-opa-xxx -- wget -qO- http://localhost:8181/health
```

### 2. Check OPA logs for policy evaluation errors
```bash
kubectl logs -n egaop -l app.kubernetes.io/name=opa --tail=100 | grep -i "error\|reject\|deny"
```

### 3. Test policy evaluation
```bash
kubectl exec -n egaop egaop-opa-xxx -- wget -qO- \
  -X POST http://localhost:8181/v1/data/egaop/authz/allow \
  -d '{"input": {"method": "GET", "path": "/api/health", "user": "test"}}'
```

## Remediation

### Restart OPA
```bash
kubectl rollout restart deployment/egaop-opa -n egaop
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=opa -n egaop --timeout=60s
```

### If OPA keeps failing
```bash
# Check if OPA bundle is valid
kubectl exec -n egaop egaop-opa-xxx -- wget -qO- http://localhost:8181/bundles

# Force reload policies
kubectl exec -n egaop egaop-opa-xxx -- wget -qO- http://localhost:8181/v1/policies
```

### Emergency: Disable OPA (if policy is blocking everything)
```bash
# Only if OPA is causing complete outage
kubectl set env deployment/egaop-api-server -n egaop OPA_ENABLED=false
# Remember to re-enable after fixing
```

## Prevention
- Monitor OPA policy evaluation latency
- Test policy changes in staging before production
- Keep OPA bundle size small (<1MB)

## Escalation
- If OPA restart doesn't fix: Page platform security team
- If policy corruption suspected: Page platform lead
