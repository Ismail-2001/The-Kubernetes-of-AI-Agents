# PR 1 — Fix OPA policy-evaluation bypass in workflow-engine

**Title:** `fix(workflow-engine): stop bypassing OPA policy evaluation in live execution path`

### What was broken

The workflow-engine had two entry paths. The canonical path (`src/temporal/workflows/` + `src/temporal/activities/`) called the real OPA policy-plane service, but the deployed Docker image (built 2026-07-04, per `docs/benchmarks/execution-path-single-trace-2026-07-11.json:9`) predated the `evaluatePolicy` activity being implemented. The worker ran stale code that silently skipped the policy check entirely.

Additionally, `evaluatePolicy` in the canonical activity hardcoded fabricated OPA input — setting `subject.namespace == resource.namespace` (both mapped to the same `params.namespace` value) and `clearance: 3` — making the OPA deny path structurally unreachable. The real request's namespace/clearance/action never reached OPA.

The `admitAgent` activity called `CreateAgent` gRPC, which threw on duplicate agents instead of treating "already exists" as a successful admission — causing every subsequent workflow execution to fail at admission before reaching policy evaluation.

### What changed

- **Fixed `evaluatePolicy` input construction** (`src/temporal/activities/index.ts:354-374`): replaced fabricated `subject.namespace == resource.namespace, clearance: 3` with real parameters — `resourceNamespace` (defaults to `params.namespace` if not provided) and `callerRole` mapped to clearance levels via `roleToClearance: { platform_admin: 3, namespace_admin: 3, developer: 2, viewer: 1 }`.
- **Added `resourceNamespace` and `callerRole` to `AgentExecutionInput`** (`src/temporal/types.ts:8-10`) and wired them through the workflow (`src/temporal/workflows/react-workflow.ts:156-157`) to `evaluatePolicy`.
- **Fixed `admitAgent` error handling** (`src/temporal/activities/index.ts:437-442`): now returns `true` when the API server reports "already exists" instead of throwing.
- **Fixed OPA policy path** (`src/temporal/activities/index.ts:351`): changed from `egaop/agent_execution` (non-existent) to `egaop/execution` (the actual Rego package name).
- **Added `POLICY_PLANE_ADDR`** to workflow-engine environment in `docker-compose.yml:222` (was defaulting to `http://policy-plane:50059`, a non-existent service).
- CI guard `scripts/check-no-fake-policy.ts` already exists — fails the build if a legacy `activities/agent.ts` with a hardcoded `{ status: 'allow' }` stub is detected.
- The legacy `src/workflows/index.ts` and `src/activities/index.ts` barrel files exist but are harmless re-exports from the canonical `src/temporal/` paths. They were not deleted because they serve as the TypeScript module resolution entry points for the `temporal/worker.ts` helper.

### Evidence

- **Test 1 (DENY)**: Cross-namespace execution (`subject: default`, `resource: finance`, `callerRole: developer`) started via Temporal SDK against the deployed `workflow-engine` container. Workflow result: `{ status: "ERROR", output: "Policy denied: Policy denied" }`. Policy correctly denied before sandbox creation.
- **Test 2 (ALLOW)**: Same-namespace execution (`subject: default`, `resource: default`, `callerRole: namespace_admin`). Workflow result: `{ status: "ERROR", output: "Sandbox creation failed: Activity task failed" }`. Policy allowed; failure is at sandbox creation (expected — no `egaop-base-runtime:latest` image available).
- **OPA direct verification**: `POST /v1/data/egaop/execution` with `{"input":{"subject":{"namespace":"default","clearance":2},"action":"execute","resource":{"namespace":"finance"}}}` returns `{"result":{"allow":false,"deny":["Namespace mismatch: subject 'default' cannot access resource in namespace 'finance'"]}}`.
- **OPA logs**: After the fix, OPA received requests at `req_id:12` (deny, 36 bytes response) and `req_id:13` (allow, 36 bytes response) matching the test inputs.
- `grep -r "evaluatePolicy" --include='*.ts'` confirms the canonical definition is at `src/temporal/activities/index.ts:348`; all other references are imports, re-exports, or tests.
- `grep -rn "function getServerCredentials\|function getClientCredentials"` excluding `packages/shared` — zero results (no inline credential duplicates).
- CI guard output: `check-no-fake-policy.ts` passes — no legacy `activities/agent.ts` with hardcoded allow stub exists.
- Full build: `docker compose build workflow-engine` completes in ~90s; deployed fresh image at `2026-07-11T18:54:49Z`; tests pass from fresh image.

### What's still open

- The `temporal/worker.ts:82` helper has `workflowsPath` pointing to `src/workflows/` (the legacy barrel shim) rather than `src/temporal/workflows/`. It works because the shim re-exports the correct module, but it is architecturally inconsistent and should be updated to `src/temporal/workflows/` for clarity.
- Load/soak testing of the policy evaluation path under sustained concurrency is not covered by this PR.
- The `AgentExecutionInput` type has no `clearance` or `tier` field on the user model itself. Clearance is derived from the `callerRole` enum. If per-user clearance levels are needed (rather than role-based defaults), a database migration adding a `clearance` column to the `users` table would be required.
