# E-GAOP Production Secrets Checklist

> **Generated after 84-gap production readiness audit.**
> This document lists every secret that must be generated, rotated, or verified before deploying to production.

---

## CRITICAL: Immediate Rotation Required

These secrets were committed to `.env` and/or are weak. **Rotate before any production deployment.**

| Secret | Min Length | How to Generate | Where to Store | Notes |
|--------|-----------|----------------|---------------|-------|
| `MASTER_KEY` | ≥64 chars | `openssl rand -base64 64` | Vault / K8s Secret | Used for AES-256-GCM encryption |
| `JWT_SECRET` | ≥64 chars | `openssl rand -base64 64` | Vault / K8s Secret | HMAC signing key (entropy ≥4.3) |
| `SERVICE_TOKEN` | ≥48 chars | `openssl rand -hex 48` | Vault / K8s Secret | Internal service-to-service auth |
| `POSTGRES_PASSWORD` | ≥24 chars | `openssl rand -base64 32` | Vault / K8s Secret | DB superuser password |
| `REDIS_PASSWORD` | ≥24 chars | `openssl rand -base64 32` | Vault / K8s Secret | Redis AUTH password |
| `GRAFANA_ADMIN_PASSWORD` | ≥24 chars | `openssl rand -base64 32` | Vault / K8s Secret | Grafana admin UI access |

## API Keys (Rotate in Provider Dashboards)

| Secret | Provider | Where to Rotate | Notes |
|--------|----------|----------------|-------|
| `GROQ_API_KEY` | Groq (groq.com) | Dashboard → API Keys | **Was committed in `.env` — rotate immediately** |
| `OPENAI_API_KEY` | OpenAI (platform.openai.com) | Dashboard → API Keys | If used in production |
| `ANTHROPIC_API_KEY` | Anthropic (console.anthropic.com) | Dashboard → API Keys | If used in production |

## Kubernetes Secrets (Pre-deploy)

Create these secrets in the target namespace before `helm install`:

```bash
# Postgres credentials
kubectl create secret generic egaop-postgres-credentials \
  --from-literal=postgres-password='<GENERATED>' \
  --from-literal=password='<GENERATED>' \
  -n egaop

# Redis credentials
kubectl create secret generic egaop-redis-credentials \
  --from-literal=redis-password='<GENERATED>' \
  -n egaop

# Grafana credentials
kubectl create secret generic egaop-grafana-credentials \
  --from-literal=admin-user='admin' \
  --from-literal=admin-password='<GENERATED>' \
  -n egaop

# Application secrets
kubectl create secret generic egaop-managed-secrets \
  --from-literal=MASTER_KEY='<GENERATED>' \
  --from-literal=JWT_SECRET='<GENERATED>' \
  --from-literal=SERVICE_TOKEN='<GENERATED>' \
  --from-literal=OPENAI_API_KEY='<KEY>' \
  --from-literal=ANTHROPIC_API_KEY='<KEY>' \
  --from-literal=GROQ_API_KEY='<KEY>' \
  -n egaop
```

## Infrastructure Secrets

| Secret | Component | How to Generate | Notes |
|--------|-----------|----------------|-------|
| TLS certificates | cert-manager | Automatic via Let's Encrypt | Requires `cert-manager` CRDs installed |
| Vault root token | HashiCorp Vault | Vault init | If using External Secrets Operator |
| Temporal JWT | Temporal server | `temporal tool mtls new-certificate` | For mTLS between services |

## Pre-Deployment Verification

```bash
# 1. Validate all secrets meet minimum length requirements
npm run build --workspace=packages/shared
node -e "
  const { validateSecrets } = require('./packages/shared/dist/config/validate-secrets');
  const result = validateSecrets();
  console.log(JSON.stringify(result, null, 2));
"

# 2. Verify no secrets in git history
git log --all --oneline | head -20
# Check .env is in .gitignore
git check-ignore .env

# 3. Verify Helm values are valid
helm lint charts/e-gaop --values charts/e-gaop/values.yaml --values charts/e-gaop/values-production.yaml
```

## Post-Deployment Verification

```bash
# 1. Verify all pods are running
kubectl get pods -n egaop

# 2. Verify TLS certificates are issued
kubectl get certificates -n egaop

# 3. Verify secrets are mounted
kubectl exec -n egaop deploy/api-server -- env | grep -E 'MASTER_KEY|JWT_SECRET' | head -5

# 4. Verify health endpoints
kubectl port-forward -n egaop svc/api-server 3001:3001
curl -s http://localhost:3001/healthz
```
