# Task BL — Kubernetes / Helm Validation Results

**Date**: 2026-07-19
**Environment**: kind v0.32.0 (single-node), Helm v3.17.3 (had to install v3 — see note), kubectl v1.34.1
**Chart**: `charts/e-gaop` (umbrella: 3 community deps + 11 custom subcharts)

## What was VERIFIED (real, executed)

1. **`helm dependency build`** → succeeded. Vendored `postgresql` (bitnami 16.4.1), `redis` (bitnami 20.6.2), `temporal` (0.44.0) into `charts/e-gaop/charts/`.
2. **`helm template egaop-test charts/e-gaop --namespace egaop`** → renders cleanly to ~180 manifests (33 Services, 20 Deployments, 20 ConfigMaps, 5 StatefulSets, etc.) after the fixes below.
3. **`helm install egaop-test charts/e-gaop --namespace egaop`** → **STATUS: deployed** (REVISION 1). The umbrella chart installs end-to-end.
4. Pods began scheduling: infra (postgresql, redis, temporal-frontend/history/matching/worker, cassandra, otel-collector, opa, prometheus/grafana/elasticsearch stacks) + all app Deployments (api-server, llm-router, tool-proxy, sandbox-runtime, memory-plane, observability-plane, secret-store, workflow-engine, admin-console) entered `ContainerCreating`/`Pending`.

## Real chart bugs found & FIXED (in repo, uncommitted)

| # | Bug | File(s) | Fix |
|---|-----|---------|-----|
| 1 | **CRLF line endings** in all chart YAML → Helm parse error `bad character U+002D '-'` on every template. | all `charts/**/*.yaml` | Converted CRLF→LF. |
| 2 | **Hyphenated value refs in templates**: `.Values.admin-console.port`, `.Values.api-server.restPort` etc. Helm parses `admin-console` as `admin` MINUS `console` → nil. | `templates/ingress.yaml` | Use `index .Values "admin-console" "port"` etc. |
| 3 | **Subchart value-prefix bug**: every subchart template used `.Values.<service>.field` (e.g. `.Values.workflow-engine.healthPort`), but in a subchart's own scope values are at `.Values.field` (no prefix). Caused all `if .Values.X.enabled` to be nil → Deployments/Services never rendered. | all 9 app subchart `templates/*.yaml` | Removed the service-name prefix. |
| 4 | **cert-manager CRDs** (Certificate/ClusterIssuer) rendered but CRDs absent in kind → install failed. | `templates/networkpolicy.yaml` (lines 382-403) | Guarded behind `tls.certManager.enabled` (default false). |
| 5 | **ServiceMonitor** templates require prometheus-operator CRDs (absent) → parse error. | all 9 subchart `templates/servicemonitor.yaml` | Guarded behind `serviceMonitor.enabled` (default false). |
| 6 | **OTel endpoint wrong**: `global.otelEndpoint: http://otel-collector-collector:4317` — actual service is `<release>-otel-collector`. | `values.yaml` | `http://egaop-test-otel-collector:4317`. |
| 7 | **Secrets never wired into deployments** + External Secrets/Vault required but absent. `postgresql.auth.existingSecret: e-gaop-managed-secrets` pointed at a non-existent secret. | `templates/external-secrets.yaml`, `templates/secrets.yaml` (new), `values.yaml`, `templates/configmap-shared.yaml` | Added `templates/secrets.yaml` rendering a managed Secret from `.Values.secrets` when `externalSecrets.enabled=false`; fixed configmap hostnames (`<release>-postgresql`, `<release>-redis-master`, `<release>-temporal-frontend`); corrected postgres/redis auth to match. |
| 8 | **bitnami image security gate**: redis chart refused `ghcr.io` images. | `values.yaml` `global` | Added `global.security.allowInsecureImages: true`. |
| 9 | **opa/otelCollector values shape mismatch**: parent passed `image:` as a STRING; subcharts expect `image: {repository,tag,pullPolicy}` + `ports` map → template field error. | `values.yaml` `opa:` / `otelCollector:` blocks | Aligned to subchart-expected map shape. |
| 10 | **configmap-shared** referenced `.Values.postgres.database` / `.Values.temporal.namespace` (undefined). | `templates/configmap-shared.yaml` | Use `.Values.postgresql.auth.database` / `.Values.temporal.namespace`. |
| 11 | **ingress nested-quote bug**: `"{{ .Values.ingress.rateLimit | default "100" }}"`. | `templates/ingress.yaml` | `default 100`. |

## Real runtime findings (from the deployed cluster, before it was overwhelmed)

- **OPA pod `CrashLoopBackOff`** (2 restarts in first 44s) — the OPA container crashed on start. Needs log investigation (likely the policy mount or args). This is a genuine app-chart defect.
- **App images `egaop/*:latest` do not exist** in any registry → app Deployments would hit `ImagePullBackOff`. To truly run the app tier on K8s, images must be built (`docker build`) and loaded into kind (`kind load docker-image`). Not yet done.
- **Footprint is very heavy for a single node**: the default chart pulls in Temporal **+ Cassandra + Elasticsearch + a full Prometheus/Grafana/kube-state-metrics stack** (via temporal & prometheus sub-charts/deps). On a single kind node this saturated the host (see blocker below).

## Blocker encountered (environment, not chart)

After `helm install` succeeded and pods began scheduling, the **Docker daemon on the host became unresponsive (HTTP 500 / TLS-handshake timeouts on every `docker`/`kubectl` call)**. Root cause: the combination of the 16-container E-GAOP docker-compose stack (still running for Task BK) PLUS the kind node running temporal+cassandra+elasticsearch+prometheus exceeded the Windows host's CPU/memory. The daemon could not recover without a Docker Desktop restart.

**To finish Task BL cleanly:** restart Docker Desktop, then:
1. Keep the E-GAOP compose stack down (free host resources).
2. Re-create the kind cluster (`kind create cluster --name egaop-test`).
3. `helm install egaop-test charts/e-gaop -n egaop --set ingress.enabled=false --set temporal.cassandra.enabled=false --set temporal.elasticsearch.enabled=false` (slim profile) OR build & `kind load` the app images first.
4. Capture `kubectl get pods -n egaop` and `kubectl logs -n egaop egaop-test-opa-...` to confirm OPA crash root cause and infra readiness.

## Tooling note
`winget` installed Helm **v4.2.3**, which failed identically to v3 on the (CRLF) charts — the blocker was CRLF, not Helm version. For the actual validation I used Helm **v3.17.3** (downloaded from get.helm.sh) because the charts target Helm 3 conventions. kind v0.32.0 installed via winget.

## Reproduce
```powershell
# from repo root
kind create cluster --name egaop-test
helm install egaop-test charts/e-gaop --namespace egaop --create-namespace --set ingress.enabled=false
helm test / kubectl get pods -n egaop
```
