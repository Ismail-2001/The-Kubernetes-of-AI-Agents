# PR 4 — Consolidate duplicate shared packages and TLS credential helpers

**Title:** `refactor(shared): consolidate duplicate shared package and inline TLS credential copies`

### What was broken

The initial audit identified two shared packages (`shared/`, unwired into the workspace; and `packages/shared/`, the canonical workspace-registered one) with overlapping and diverging files. Separately, multiple services contained inline redefinitions of `getServerCredentials()` / `getClientCredentials()` alongside imports of the canonical versions from `@e-gaop/shared` — a duplication pattern with security relevance, since a patched cipher/cert-validation fix in one copy wouldn't propagate to the other(s).

### What changed

- The root-level `shared/` directory was removed. Only `packages/shared/` exists now, with a full package structure (`src/`, `dist/`, `package.json`, `tsconfig.json`).
- Root `package.json` defines workspaces including `packages/shared` as the first entry (line 6-17). All other services import from `@e-gaop/shared`.
- All 9 services (`api-server`, `secret-store`, `workflow-engine`, `llm-router`, `tool-proxy`, `sandbox-runtime`, `memory-plane`, `observability-plane`, `policy-plane`) import `getServerCredentials` and `getClientCredentials` from `@e-gaop/shared`. Zero inline redefinitions exist outside `packages/shared/src/tls.ts`.
- Canonical TLS definitions at `packages/shared/src/tls.ts:28` (`getServerCredentials`) and `:40` (`getClientCredentials`).
- Re-exported from `packages/shared/src/index.ts:71`.
- Negative tests for TLS helpers added at `tests/tls.test.ts`: missing certs, nonexistent cert directories, TLS disabled — all verify fail-closed behavior.
- `docs/benchmarks/` directory contains the execution-path single-trace evidence.

### Evidence

- `grep -r "packages/shared" --include='package.json'` confirms workspace registration.
- `grep -rn "function getServerCredentials\|function getClientCredentials"` excluding `packages/shared/src/tls.ts` — **zero results**. Before: the audit found inline copies in multiple services. After: all consumers import from `@e-gaop/shared`.
- `ls shared/` at root returns "not found" — the duplicate package has been removed.
- `ls packages/shared/src/` confirms: `tls.ts`, `db.ts`, `rate-limiter.ts`, `crypto.ts`, `config.ts`, `errors.ts`, `grpc.ts`, `metrics.ts`, `namespaces.ts`, `quotas.ts`, `telemetry.ts`, `index.ts`.
- Full typecheck across all workspaces: pass.
- Full test suite: all TLS tests pass (`tests/tls.test.ts`), including negative cases for missing certs and TLS-disabled mode.
- All Dockerfiles reference only `packages/shared` via the workspace mechanism (no hardcoded paths to a root `shared/`).

### What's still open

- The `temporal/worker.ts` helper (line 82) has `workflowsPath` pointing to the legacy `src/workflows/` barrel shim rather than `src/temporal/workflows/`. This is a cosmetic inconsistency — the shim re-exports correctly — but should be cleaned up for architectural clarity.
- The `packages/shared` package version is not semantically versioned — it uses `"version": "1.0.0"` with no release process. If the package is consumed outside this monorepo in the future, a proper versioning strategy will be needed.
