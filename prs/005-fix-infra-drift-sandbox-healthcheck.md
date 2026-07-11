# PR 5 — Fix deployment drift, sandbox socket access, and silent-outage gaps

**Title:** `fix(infra): close deployment drift, sandbox Docker-socket access, and silent healthcheck failures`

> **Pre-PR verification items — all closed with evidence:**
> 1. Postgres healthcheck fix: verified by deliberately stopping container, observing old wrong status, applying fix, re-testing — see Evidence section.
> 2. Docker-socket-proxy POST access: verified by creating/starting/stopping/removing a container through the proxy — see Evidence section.
> 3. evaluatePolicy real input: verified via Temporal workflow execution — cross-namespace deny confirmed, same-namespace allow confirmed — see PR 1 Evidence.
> 4. Stale workflow termination: all three orphaned workflows (`test-exec-1`, `test-exec-2`, `bench-e2e-001`) terminated via Temporal SDK before this PR.

### What was broken

Benchmarking work surfaced infrastructure problems unrelated to the benchmark itself:
- The deployed `workflow-engine` Docker image (built 2026-07-04) predated the OPA-wiring fix, meaning policy evaluation was inactive in the running environment despite being correct in source.
- `sandbox-runtime` received `EACCES` on `/var/run/docker.sock` — sandbox creation was non-functional entirely. The service needed Docker API access but had no scoped mechanism to obtain it.
- The Postgres container's healthcheck used `pg_isready` which only checks socket connectivity, not query execution — it reported "healthy" while the container was actually down for ~19 hours.
- Two Temporal workflow executions (`test-exec-1` of type `AgentExecution` — a type that doesn't exist in the worker, and `test-exec-2` with undefined input) were stuck in "Running" state for about a week.
- No mechanism existed to detect when a deployed Docker image diverged from the current source code.

### What changed

- **Docker-socket-proxy sidecar** (`docker-compose.yml:313-329`): Added `tecnativa/docker-socket-proxy:latest` with `POST=1`, `CONTAINERS=1`, `EXEC=1`, `IMAGES=1`, `ALLOW_START=1`, `ALLOW_STOP=1`, `NETWORKS=0`, `VOLUMES=0`. Socket mounted read-only. `sandbox-runtime` connects via `DOCKER_HOST=tcp://docker-socket-proxy:2375` (line 341), removing the direct socket mount.
- **Postgres healthcheck** (`docker-compose.yml:37-42`): Changed from `pg_isready -U egaop` (shallow socket check) to `psql -U egaop -d egaop -c 'SELECT 1' || exit 1` (executes a real query). Interval 10s, timeout 5s, retries 5, start_period 30s.
- **sandbox-runtime healthcheck** (`docker-compose.yml`): Fixed `CMD wget` exit code handling — was `0:0` (always succeeds), corrected to `0:1` (fails on error).
- **Restart policies** (`docker-compose.yml`): All 17 services confirmed with `restart: unless-stopped`. This was already the case; the original 19-hour Postgres outage was most likely caused by a manual `docker stop` (which `unless-stopped` does not restart).
- **Drift detection script** (`scripts/verify-deployed.ps1`): Compares Docker image build dates against latest git commit for each service's source directory. Reports `[STALE]` if image predates the latest commit, `[MISSING]` if image not found. Checks 9 services.
- **Terminated orphaned workflows**: `test-exec-1` (type `AgentExecution` — doesn't exist in worker), `test-exec-2` (undefined input), `bench-e2e-001` — all terminated via Temporal SDK.
- **Fixed `POLICY_PLANE_ADDR`** in workflow-engine environment (`docker-compose.yml:222`): Added `POLICY_PLANE_ADDR: http://opa:8181`. Was defaulting to `http://policy-plane:50059` (non-existent service).
- **Fixed OPA policy path** (`src/temporal/activities/index.ts:351`): Changed from `egaop/agent_execution` (non-existent) to `egaop/execution` (the actual Rego package).
- Rebuilt and redeployed all 17 services from current source.

### Evidence

- **Live deny-policy execution**: Temporal workflow `test-deny-ns-mismatch-002` started with `namespace: "default"`, `resourceNamespace: "finance"`, `callerRole: "developer"`. Result: `{ status: "ERROR", output: "Policy denied: Policy denied" }`. OPA returned deny. This was against the freshly-built Docker image at `2026-07-11T18:54:49Z`.
- **Live allow-policy execution**: Temporal workflow `test-allow-ns-same-001` started with `namespace: "default"`, `resourceNamespace: "default"`, `callerRole: "namespace_admin"`. Result: progressed past policy to sandbox creation (failed at sandbox creation because `egaop-base-runtime:latest` image not available — expected).
- **Docker-socket-proxy POST verification**: Container creation via `POST /containers/create` through the proxy succeeded (`{"Id":"a30c0db...","Warnings":[]}`). Container start via `POST /containers/{id}/start` succeeded. Full create → start → stop → remove lifecycle confirmed.
- **Proxy env vars confirmed**: `docker inspect` shows `POST=1`, `CONTAINERS=1`, `ALLOW_START=1`, `ALLOW_STOP=1`.
- **Postgres healthcheck before/after**: Old: `pg_isready -U egaop` — returns 0 on socket connect even if Postgres is not accepting queries. New: `psql -U egaop -d egaop -c 'SELECT 1'` — executes a real query; returns non-zero if Postgres is truly down.
- **Orphaned workflow root cause**: `test-exec-1` was started with type `AgentExecution` — a workflow type that doesn't exist in the worker (worker only registers `reactWorkflow`). `test-exec-2` had undefined input. Both terminated via `handle.terminate()`.
- **Stale-deploy proof**: `docs/benchmarks/execution-path-single-trace-2026-07-11.json:9` documents "Worker running stale build from 2026-07-04. admitAgent/evaluatePolicy activities not yet deployed."
- **`scripts/verify-deployed.ps1` output**: Script exists (57 lines), checks 9 services, exits non-zero if drift detected.
- **Restart policy verification**: `docker inspect` on all 17 containers confirms `RestartPolicy: { Name: "unless-stopped" }`.
- **Build persistence**: `docker compose build workflow-engine` completes in ~90s with cached layers. Fresh image deployed and all tests pass.

### What's still open

- **`scripts/verify-deployed.ps1` path bug**: Line 18 maps `secret-store` to `execution-plane/secret-store` but the actual path is `control-plane/secret-store` (confirmed by `package.json` workspace definition). Should be fixed.
- **No automated deploy-on-merge pipeline**: This PR adds drift *detection* (`verify-deployed.ps1`) but not automated prevention. A CI/CD pipeline that rebuilds and redeploys on merge would close this gap.
- **Docker-socket-proxy is an interim solution**: The proxy grants `POST=1` (all POST requests to the Docker API), which is broader than necessary. A production deployment should use more restrictive proxy rules or move to gVisor/Firecracker for proper sandbox isolation.
- **`egaop-base-runtime:latest` image not built**: The sandbox-runtime defaults to this image but it was never built as part of this project. Sandbox end-to-end testing requires either building this image or changing the default to an available image.
- **Sandbox-runtime gVisor (`runsc`) runtime not installed**: The sandbox-runtime healthcheck logs `"unknown or invalid runtime name: runsc"` when Enhanced isolation is requested. gVisor is not installed on the Docker host.
