# GitHub Actions CI/CD Setup

## Architecture

```
[Push/PR] → CI workflow (audit → lint → typecheck → helm-lint → test → build images)
                                                      ↓ success
                                      Deploy workflow (staging → smoke → production*)
                                                      ↓ failure
                                                   rollback
```

\* Production requires manual approval via GitHub Environments.

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | `push`/`PR` to `main` | Audit, lint, typecheck, Helm lint, unit + cross-cutting tests, Docker image build |
| `deploy.yml` | CI completed on `main` | Deploy to staging, smoke test, manual promote to production |
| `security-scan.yml` | Schedule + `push`/`PR` | Gitleaks (secrets), CodeQL (SAST), Trivy (FS + images) |
| `backup.yml` | Schedule | Backup Postgres + config to GitHub Artifacts |

## Prerequisites

1. Push the repository to GitHub
2. Enable GitHub Actions in repository settings
3. Configure the following secrets and variables:

### Required Secrets

| Secret | Value | Used By |
|--------|-------|---------|
| `OPENAI_API_KEY` | OpenAI or OpenRouter API key | CI tests, eval runner |
| `STAGING_HOST` | SSH hostname for staging server | deploy.yml |
| `STAGING_USER` | SSH user for staging server | deploy.yml |
| `STAGING_SSH_KEY` | Private SSH key for staging access | deploy.yml |
| `SLACK_WEBHOOK` | Slack webhook URL for deploy notifications | deploy.yml, backup.yml |

### Optional Secrets

| Secret | Value | Used By |
|--------|-------|---------|
| `PRODUCTION_HOST` | SSH hostname for production | deploy.yml |
| `PRODUCTION_USER` | SSH user for production | deploy.yml |
| `PRODUCTION_SSH_KEY` | Private SSH key for production | deploy.yml |
| `POSTGRES_PASSWORD` | Production DB password | deploy.yml |
| `JWT_SECRET` | JWT signing secret | deploy.yml |
| `EGAOP_MASTER_ENCRYPTION_KEY` | Encryption key for secret-store | deploy.yml |
| `GRAFANA_PASSWORD` | Grafana admin password | deploy.yml |

### Repository Variables

| Variable | Value | Used By |
|----------|-------|---------|
| `LAST_SUCCESSFUL_DEPLOY_TAG` | Set automatically on successful deploy | deploy.yml (rollback) |

---

## CI Pipeline (`ci.yml`)

Jobs and status checks:

| Job | Blocking | Timeout | Depends On |
|-----|----------|---------|------------|
| `audit` | Yes | 5 min | — |
| `lint` | Yes | 10 min | — |
| `typecheck` | Yes | 10 min | — |
| `helm-lint` | Yes | 10 min | — |
| `docker-compose-validate` | Yes | 5 min | lint, typecheck |
| `test-unit` | Yes | 15 min | lint, typecheck |
| `test-cross-cutting` | Yes | 20 min | lint, typecheck |
| `docker-build` (matrix × 9) | Yes | 20 min | test-unit, test-cross-cutting, helm-lint |

Key improvements:
- **npm cache** via `actions/setup-node` — shared across jobs
- **npm audit now fails** on high severity (we're at 0 CVEs)
- **Helm chart lint** validates all templates at compile time
- **Docker images build in parallel** via matrix, push to GHCR on `main`
- **GHA cache** for Docker layer caching (`type=gha`) — subsequent builds are ~2× faster
- **Summary step** posts build status to PR + workflow run

### Verifying CI Works

```bash
git push origin main
```

Go to GitHub → Actions. The CI workflow triggers on push to `main`:
1. Audit (must pass — 0 high vulns)
2. Lint + TypeCheck (run in parallel)
3. Helm lint + Docker Compose validate
4. Unit tests + cross-cutting tests (require Postgres + Redis)
5. Docker images built in parallel matrix, pushed to GHCR

Open a PR — all jobs appear as required status checks.

---

## Deploy Pipeline (`deploy.yml`)

Triggered by successful CI completion on `main`:

```
CI success → deploy-staging → smoke test → [approval] → deploy-production
                                ↓ fail
                              auto-rollback
```

### Staging Environment
- Auto-deploys on CI success
- Pulls images from GHCR (built by CI)
- Waits for health endpoints before smoke tests
- **Auto-rollback** if smoke tests fail — redeploys `LAST_SUCCESSFUL_DEPLOY_TAG`

### Production Environment
- **Manual approval gate** via GitHub Environments
- Configure approvers in Settings → Environments → `production`
- Same deploy sequence: pull → up → health check → smoke test
- Slack notification on success

### Setting Up Environments

1. **Staging**: Settings → Environments → `staging` (no protection needed)
2. **Production**: Settings → Environments → `production`
   - Required reviewers: add team members
   - Wait timer: optional (e.g., 5 minutes)
   - Deployment branches: `main` only

---

## Security Scanning

Three layers run on every push/PR:

| Tool | What it catches | Run time |
|------|-----------------|----------|
| **Gitleaks** | Hardcoded secrets, API keys, tokens | ~2 min |
| **CodeQL** | Code vulnerabilities (XSS, injection, etc.) | ~10 min |
| **Trivy (FS)** | Vulnerable npm packages, bad configs | ~5 min |
| **Trivy (Image)** | OS-level CVEs in Docker images | ~15 min × 9 images |

Weekly full scan runs every Monday 06:00 UTC.

---

## Dependabot

`.github/dependabot.yml` configured for:

| Ecosystem | Locations | Update | PRs/Week |
|-----------|-----------|--------|----------|
| `npm` | `/` | Weekly, minor+patch grouped | ≤10 |
| `docker` | 9 Dockerfiles | Weekly | ≤3 each |
| `github-actions` | `/` | Weekly | ≤5 |

All dependabot PRs trigger the CI pipeline automatically.

---

## Local CI Validation

Before pushing, run the local pipeline to catch issues early:

```powershell
# Quick check (no Docker, no cross-cutting tests)
.\scripts\ci-local.ps1

# Full check (requires Docker + Postgres + Redis)
.\scripts\ci-local.ps1 -SkipCrossCutting

# Build all Docker images locally
.\scripts\docker-build-all.ps1

# Full K8s validation
.\scripts\kind-deploy.ps1
```

The local CI runs: audit → lint → typecheck → build (10 workspaces) → test → cross-cutting → Docker compose validate → Docker build → Helm lint/template.

---

## Troubleshooting

### CI fails on `npm audit`
The pipeline now **fails on high-severity vulns**. Run:
```bash
npm audit fix --workspaces
```
If a transitive dependency has no fix, override with `overrides` in `package.json` and document in `SECURITY.md`.

### Docker build fails
Check Dockerfile syntax and build context:
```bash
docker build -f control-plane/api-server/Dockerfile . --no-cache
```
The CI uses `type=gha` cache — if cache is corrupt, clear it from the GitHub Cache UI.

### Deploy hangs on `--wait`
Increase `--wait-timeout` in the workflow or check:
```bash
docker compose ps --all
docker compose logs --tail=50 <service>
```

### Helm template fails
The pipeline runs `helm lint --strict` and `helm template`. Validate locally:
```powershell
helm dependency update charts/e-gaop
helm lint charts/e-gaop --strict
helm template test charts/e-gaop --values charts/e-gaop/values.yaml
```

### Rollback fails
If `LAST_SUCCESSFUL_DEPLOY_TAG` is not set, the rollback step is skipped. Manually deploy a known-good tag:
```bash
export IMAGE_TAG=<known-good-sha>
docker compose up -d
```

---

## Monitoring

After setup, monitor:
- **GitHub Actions** — workflow run history, status badges
- **Security tab** — SARIF results from CodeQL + Trivy + Gitleaks
- **Slack** — deploy notifications and rollback alerts
- **Dependabot** — automatic PRs for dependency updates

### Status Badges

Add to `README.md`:

```markdown
[![CI](https://github.com/${{github.repository}}/actions/workflows/ci.yml/badge.svg)](https://github.com/${{github.repository}}/actions/workflows/ci.yml)
[![Security](https://github.com/${{github.repository}}/actions/workflows/security-scan.yml/badge.svg)](https://github.com/${{github.repository}}/actions/workflows/security-scan.yml)
```
