# E-GAOP Deployment Runbook

## Prerequisites

- [ ] Docker Desktop / Colima running
- [ ] `kubectl` configured to target cluster
- [ ] `helm` v3.12+ installed
- [ ] `jq` installed (for scripting)
- [ ] External Secrets Operator installed in cluster
- [ ] cert-manager installed in cluster
- [ ] Vault unsealed and accessible

## Pre-Flight Checklist

```bash
# 1. Verify cluster access
kubectl cluster-info

# 2. Verify namespace
kubectl get ns egaop || kubectl create ns egaop

# 3. Verify cert-manager
kubectl get pods -n cert-manager

# 4. Verify External Secrets Operator
kubectl get pods -n external-secrets

# 5. Update chart dependencies
cd charts/e-gaop
helm dependency update

# 6. Lint the chart
helm lint . -f values-staging.yaml
```

## Deploy — Staging

```bash
# First install
helm install egaop ./charts/e-gaop \
  -f ./charts/e-gaop/values-staging.yaml \
  -n egaop \
  --set global.imagePullPolicy=IfNotPresent

# Upgrade (subsequent)
helm upgrade egaop ./charts/e-gaop \
  -f ./charts/e-gaop/values-staging.yaml \
  -n egaop \
  --reuse-values

# Check status
helm status egaop -n egaop
kubectl get pods -n egaop -w
```

## Deploy — Production

```bash
# First install
helm install egaop ./charts/e-gaop \
  -f ./charts/e-gaop/values-production.yaml \
  -n egaop

# Upgrade
helm upgrade egaop ./charts/e-gaop \
  -f ./charts/e-gaop/values-production.yaml \
  -n egaop \
  --reuse-values

# Verify rollout
kubectl rollout status deployment/api-server -n egaop
kubectl rollout status deployment/workflow-engine -n egaop
```

## Rollback

```bash
# Check history
helm history egaop -n egaop

# Rollback to specific revision
helm rollback egaop <REVISION> -n egaop

# Rollback to last successful
helm rollback egaop -n egaop

# Verify rollback
kubectl get pods -n egaop
helm history egaop -n egaop | tail -5
```

## Rollout Status Check

```bash
# Check all deployments
kubectl get deployments -n egaop

# Check rollout status per service
for deploy in api-server secret-store workflow-engine llm-router tool-proxy \
  sandbox-runtime memory-plane observability-plane admin-console; do
  echo "--- $deploy ---"
  kubectl rollout status deployment/$deploy -n egaop --timeout=60s
done

# Check HPA status
kubectl get hpa -n egaop

# Check PDB status
kubectl get pdb -n egaop
```

## Troubleshooting

### Pods in CrashLoopBackOff

```bash
# Check logs
kubectl logs -n egaop deployment/api-server --tail=50

# Check events
kubectl get events -n egaop --sort-by=.lastTimestamp | tail -20

# Check secrets
kubectl get secrets -n egaop
kubectl get externalsecrets -n egaop
```

### Postgres Connection Issues

```bash
# Check postgres pod
kubectl get pods -n egaop -l app.kubernetes.io/name=postgresql

# Port forward and test
kubectl port-forward -n egaop svc/postgresql-postgresql 5432:5432 &
psql -h localhost -U postgres -d egaop
```

### Redis Connection Issues

```bash
kubectl get pods -n egaop -l app.kubernetes.io/name=redis
kubectl port-forward -n egaop svc/redis-master 6379:6379 &
redis-cli -h localhost ping
```

### Vault Secrets Not Syncing

```bash
kubectl get externalsecrets -n egaop
kubectl describe externalsecret egaop-secrets -n egaop
kubectl logs -n external-secrets deployment/external-secrets-operator
```

## Health Check Commands

```bash
# API Server
kubectl exec -n egaop deployment/api-server -- curl -s localhost:15051/healthz

# All services
for port in 15051 15057 15058 15053 15052 15054 15055 15056; do
  echo "Port $port: $(kubectl exec -n egaop deployment/api-server -- curl -s -o /dev/null -w '%{http_code}' localhost:$port/healthz 2>/dev/null || echo 'FAIL')"
done
```

## Monitoring

```bash
# Grafana port-forward
kubectl port-forward -n egaop svc/egaop-grafana 3000:3000 &

# Prometheus port-forward
kubectl port-forward -n egaop svc/egaop-prometheus 9090:9090 &

# Check OTel traces
kubectl port-forward -n egaop svc/egaop-temporal-frontend 7233:7233 &
```
