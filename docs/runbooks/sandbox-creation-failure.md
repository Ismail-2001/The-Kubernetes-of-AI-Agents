# Runbook: Sandbox Creation Failure

**Alert:** `SandboxCreationFailure`
**Severity:** Critical
**Response Time:** 10 minutes

## Symptoms
- Sandbox creation failing at >0/second
- Users cannot launch new agent sessions
- Agent execution blocked

## Impact
- New agent sessions cannot be created
- Existing sessions unaffected
- User-facing workflow blocked

## Investigation

### 1. Check sandbox-runtime logs
```bash
kubectl logs -n egaop -l app.kubernetes.io/name=sandbox-runtime --tail=100 | grep -i "error\|fail\|create"
```

### 2. Check Docker daemon (Kind)
```bash
docker exec egaop-control-plane crictl pods | grep sandbox
docker exec egaop-control-plane crictl images | grep egaop
```

### 3. Check resource availability
```bash
kubectl describe nodes | grep -A5 "Allocated resources"
kubectl top pods -n egaop | sort -k4 -r | head -10
```

## Remediation

### Restart sandbox-runtime
```bash
kubectl rollout restart deployment/egaop-sandbox-runtime -n egaop
```

### If Kind Docker is unreachable
```bash
# Kind cluster Docker is expected to be unreachable in dev
# Sandbox creation will return NOT_SERVING — this is by design
# For production with real Docker runtime:
kubectl logs -n egaop -l app.kubernetes.io/name=sandbox-runtime -f
```

### If resource pressure
```bash
# Scale down non-critical services
kubectl scale deployment/egaop-admin-console --replicas=1 -n egaop
kubectl scale deployment/egaop-observability-plane --replicas=1 -n egaop
```

## Prevention
- Monitor sandbox creation success rate
- Set up pre-flight resource checks
- Implement sandbox pooling for faster creation

## Escalation
- If sandbox-runtime keeps failing: Page execution plane team
- If Docker daemon issue: Page infrastructure team
