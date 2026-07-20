# PR 7 — Production hardening: alerting, backup/DR, load testing, Helm/K8s validation, and independent verification

**Title:** `feat(ops): Grafana alerting, backup/DR, load test, Helm chart, and senior-engineer verification pass`

### What was broken

The platform had no alerting (outages would go undetected), no backup/restore capability (all state in Postgres/Redis/Grafana with no export mechanism), no load testing (unknown concurrency ceiling), no Kubernetes deployment path (Docker-only), and no independent verification that the "done" claims in the readiness score were actually true.

### What changed

**Grafana alerting:**
- `scripts/grafana-init.mjs` — Creates 5 alert rules via Grafana provisioning API: ServiceDown, HighErrorRate, HighLatencyP95, HighLatencyP99, MetricsDropping.
- Slack contact point via `SLACK_ALERT_WEBHOOK` env var.
- Notification policy routes all E-GAOP alerts to contact point.
- Verified: stopping `secret-store` service triggered `E-GAOP Service Down [active]` in `/api/alertmanager/grafana/api/v2/alerts`.

**Backup / disaster recovery:**
- `scripts/backup.sh` — Full backup: Postgres (`pg_dump -F c`), Grafana sqlite (tar), Redis RDB (`SAVE` + tar), `.env` — pipes stdout over `docker exec`. Single timestamped `.tar.gz`.
- `scripts/restore.sh` — Full restore: Postgres drop/recreate + `pg_restore`, Grafana/Redis/Prometheus via `docker run -i --volumes-from` tar pipe. Non-destructive confirmation prompt.
- `scripts/full-backup-test.sh` — Content-verification test: records specific before/after data, destroys, restores, compares. 3/3 independent cycles passed.
- `.github/workflows/backup.yml` — Scheduled daily (02:00 UTC) + `workflow_dispatch` with `--full` flag. SCP from remote host, GHA artifact upload, 30-day retention.

**Load testing:**
- `scripts/load-test-bk.mjs` — Realistic concurrency test: auth → concurrent `POST /api/agents/eval-agent/run` (LLM-only + code_interpreter prompts) → poll Temporal `describe` → record end-to-end latency.
- Results: 10 concurrent = 100% pass (p50=41.9s, p95=44.3s). 12 concurrent = 75% (3 Temporal TIMEOUTs). 15 concurrent = 60% (6 TIMEOUTs).
- Root cause identified: llm-router gRPC `DEADLINE_EXCEEDED` at 10s deadline under load (confirmed in workflow-engine logs: `remote_addr=172.19.0.14:50053`).

**Helm chart + K8s validation:**
- `charts/e-gaop/` umbrella chart — 3 community deps (postgresql, redis, temporal) + 11 custom subcharts.
- `helm dependency build` ✅ — vendored successfully.
- `helm template` ✅ — renders ~180 manifests after fixing 11 chart bugs (CRLF→LF; hyphenated value refs; subchart value-prefix removal; cert-manager CRD guard; ServiceMonitor CRD guard; OTel endpoint; secrets wiring; bitnami `allowInsecureImages`; OPA/otelCollector value-shape; configmap hostnames; ingress nested-quote).
- `helm install egaop-test charts/e-gaop -n egaop --set ingress.enabled=false` → **STATUS: deployed, REVISION 1** ✅.
- Real finding: OPA pod CrashLoopBackOff (root cause undiagnosed due to Docker daemon overload).
- Results in `scripts/helm-validation-bl-results.md` (55 lines, 11 bugs documented).

**CI/CD pipeline (added but unverified):**
- `.github/workflows/ci.yml` — PR checks: lint, typecheck, unit-tests, Docker build with GHA cache.
- `.github/workflows/deploy.yml` — Build, deploy via SSH + Compose, smoke test (`scripts/smoke-test.sh`), auto-rollback (`scripts/rollback.sh`).
- `.github/dependabot.yml` — Weekly npm + Docker + Actions updates.
- **Verification finding (Jul 19):** These workflow files exist but **have never executed**. No run logs, no artifacts, no run URLs exist. `deploy.yml` additionally requires GitHub runner + SSH host secrets unavailable locally.

**Senior-engineer independent verification (Tasks BM-BR):**
- Re-tested every "score=2" claim in the readiness assessment against real execution evidence.
- **Downgraded:** Vulnerability scanning (2→0) — workflow files exist but Trivy/npm audit never ran; zero SARIF artifacts. CI/CD pipeline (2→0) — workflows never triggered.
- **Upgraded on evidence:** TLS/mTLS (0→1) — prior-round real evidence confirmed but not re-verified live. Timeout handling (1→2) — load test demonstrated graceful degradation ceiling.
- Verified: eval improvement RL-1 68.4% → RL-2 84.2% (with infra-contamination caveat). Helm install succeeded with 11 chart bugs fixed (OPA CrashLoopBackOff still open).
- Full traceability: every claim in `docs/production-readiness-final.md` maps to a specific evidence artifact.

### Evidence

- **Alerting verified**: `scripts/grafana-init.mjs` — 5 alert rules created. Verification: `secret-store` stopped → `E-GAOP Service Down [active]` appeared in Grafana Alertmanager API within 5 min.
- **Backup verified**: `scripts/full-backup-test.sh` — 3/3 backup→destroy→restore→verify cycles. Grafana DS="Prometheus" preserved, Redis key `bk:test:val`="hello-world-42", Postgres `bk_verify` count=1 val="backup-test-record-1".
- **Load test verified**: `scripts/load-test-bk-results.md` — 10/12/15 concurrency table, temporal workflow describe output, `DEADLINE_EXCEEDED` log lines from workflow-engine at `172.19.0.14:50053`.
- **Helm install verified**: `scripts/helm-validation-bl-results.md` — `helm install` STATUS: deployed, REVISION 1. 11 bug fixes documented with before/after.
- **CI/CD files exist**: `.github/workflows/ci.yml` (170 lines), `deploy.yml`, `dependabot.yml`. Verified zero run artifacts.
- **Independent verification**: `docs/production-readiness-final.md` — 7 categories, 53 items, all evidence-traceable. Verification history documented.

### What's still open

- **Vulnerability scanning**: Never executed. No CVE review exists for any of the 17 container images. **Blocking for production.**
- **CI/CD execution**: Workflow files never triggered. No automated build-test-deploy pipeline. **Blocking for production.**
- **K8s OPA CrashLoopBackOff**: Helm install succeeded but OPA pod crashes on start (root cause undiagnosed — cluster overwhelmed before logs could be captured).
- **llm-router concurrency ceiling**: ≥12 concurrent agents → `DEADLINE_EXCEEDED` failures. Needs retry/backoff or vertical scaling.
- **Eval metric bug**: `tool_selection_accuracy` >1.0 is invalid. Scoring code needs denominator fix.
- **TLS/mTLS**: Working (prior-round evidence), but mTLS disabled (`@grpc/grpc-js` bug), no cert rotation, not re-verified live this round.
