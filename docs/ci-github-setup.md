# GitHub Actions CI/CD Setup

## Prerequisites

1. Push the repository to GitHub
2. Configure the following repository secrets:

### Required Secrets

| Secret | Value | Used By |
|--------|-------|---------|
| `OPENAI_API_KEY` | OpenAI or OpenRouter API key | CI tests, eval runner |
| `STAGING_HOST` | SSH hostname for staging server | deploy.yml |
| `STAGING_USER` | SSH user for staging server | deploy.yml |
| `STAGING_SSH_KEY` | Private SSH key for staging access | deploy.yml |
| `SLACK_ALERT_WEBHOOK` | Slack webhook URL for alert notifications | deploy.yml, backup.yml |

### Optional Secrets

| Secret | Value | Used By |
|--------|-------|---------|
| `PRODUCTION_HOST` | SSH hostname for production | deploy.yml |
| `PRODUCTION_USER` | SSH user for production | deploy.yml |
| `PRODUCTION_SSH_KEY` | Private SSH key for production | deploy.yml |
| `ACTIONS_STEP_DEBUG` | `true` to enable debug logging | All workflows |

---

## Verifying CI Works

### Step 1: Push to GitHub
```bash
git push origin main
```

### Step 2: Observe Actions
1. Go to GitHub → Actions tab
2. The `CI` workflow should trigger on `push` to `main`
3. Verify all jobs complete:
   - `audit` — npm audit
   - `lint` — ESLint across workspaces
   - `typecheck` — TypeScript type checking
   - `test-unit` — Unit tests (depends on lint + typecheck)
   - `test-cross-cutting` — Contract, chaos, security tests (requires Postgres + Redis service containers)
   - `build` — Docker Compose build (depends on all tests passing)

### Step 3: Open a PR
1. Create a branch and push
2. Open a PR against `main`
3. Verify CI shows status checks on the PR
4. Verify merge is blocked if checks fail

---

## Deploy Pipeline

The `deploy.yml` workflow triggers on push to `main` after CI completes:

1. **build**: Builds all Docker images, tags with git SHA, pushes to registry
2. **deploy-staging**: SSH into staging host, pulls images, runs Compose, smoke test
3. **rollback**: If smoke test fails, redeploys last successful tag
4. **deploy-production**: Manual approval gate, then deploys to production

### Smoke Test
The deploy runs `scripts/smoke-test.sh` which checks:
- All 17 containers are running and healthy
- API health endpoint returns 200
- LLM router responds to gRPC health check

If any check fails, the pipeline triggers auto-rollback.

---

## Local CI Validation

Before pushing, run the local CI pipeline to catch issues early:

```bash
# Basic CI checks (no Docker, no cross-cutting)
.\scripts\ci-local.ps1

# Full CI (requires Docker + Postgres + Redis)
.\scripts\ci-local.ps1 -SkipDocker -SkipCrossCutting
```

The local pipeline runs all the same checks as GitHub CI:
1. `npm audit` — 0 high-severity vulnerabilities
2. ESLint linting
3. TypeScript type checking
4. Unit tests (54/54 passing)
5. Workspace builds

---

## Monitoring

After setup, monitor:
- **GitHub Actions tab** — workflow run history
- **Slack** — deploy/backup notifications
- **Security tab** — SARIF results from nightly Trivy scans

---

## Known CI Gaps

| Gap | Status | Workaround |
|-----|--------|------------|
| Trivy image scan | Requires GitHub runner | Run `docker scout` or `trivy image` locally |
| Cross-cutting tests | Needs Postgres/Redis services | `.\scripts\ci-local.ps1 -SkipCrossCutting` |
| Deploy to staging | Needs SSH host configured | Manual `docker compose up -d` |
| Deploy to production | Needs production host | Not configured |
