# E-GAOP Security

**Category score in readiness assessment: 55% (11/20).**
Full assessment: [`production-readiness-final.md`](production-readiness-final.md).

This document describes what's implemented and what's not. It is not a compliance declaration.

---

## Implemented

### OPA Policy Enforcement (score: 2/2)

Every agent execution request is evaluated against OPA/Rego policies before proceeding. The `evaluatePolicy` activity in the workflow engine sends real request parameters (namespace, clearance, action) to the OPA sidecar, which returns allow/deny. Verified live:

- **Deny**: cross-namespace execution (`namespace: default`, `resourceNamespace: finance`, `callerRole: developer`) → `"Policy denied: Policy denied"`
- **Allow**: same-namespace execution (`callerRole: namespace_admin`) → passes policy check

Source: `prs/001-fix-opa-bypass.md`, `policy-plane/`

### JWT Authentication (score: 2/2)

All REST API requests require a Bearer JWT token obtained from `POST /api/auth/login`. Tokens are verified on every request. User passwords are hashed (not stored in plaintext). Token expiry and refresh are partially implemented (database schema supports it, API routes not fully wired).

### Sandbox Network Isolation (score: 2/2)

Agent containers run on `egaop-sandbox` (internal Docker network, no internet). They can reach only the LLM router for model inference. They cannot reach postgres, temporal, redis, OPA, or any control-plane service. The Docker socket is accessed through a scoped proxy (`technativa/docker-socket-proxy`) with limited permissions (containers only — no volumes, no networks).

### Encrypted Secrets (score: 1/2)

Secrets are encrypted with AES-256-GCM before being written to PostgreSQL. Decryption happens in-process after read. Encryption key is provided via `EGAOP_MASTER_ENCRYPTION_KEY` environment variable. No HashiCorp Vault integration exists.

### RBAC / Namespace Isolation (score: 1/2)

Role-to-clearance mapping is implemented: `platform_admin: 3, namespace_admin: 3, developer: 2, viewer: 1`. Not comprehensively tested across all API endpoints.

---

## Not Implemented

### Vulnerability Scanning (score: 0/2)

Trivy image scan and `npm audit` configurations exist in `.github/workflows/` but **have never executed**. No CVE review has been performed on the 17 container images. No SARIF artifacts, no scan logs, no findings report exists. **Blocking for production.**

### CI/CD Pipeline (score: 0/2)

Workflow files (`ci.yml`, `deploy.yml`) exist but have **never been triggered**. There is no automated path from code change to running deployment. Every deploy is manual. **Blocking for production.**

### TLS / mTLS (score: 1/2 — partial)

TLS encryption is active (`TLS_ENABLED=true` in `.env`). The code at `packages/shared/src/tls.ts` implements `getServerCredentials` and `getClientCredentials` using real CA/server/client certificates. However:

- **mTLS is disabled**: `requestCert: false` workaround due to `@grpc/grpc-js` v1.14.4 bug (client connections fail when server requests client certs)
- **No cert rotation**: Certs in `certs/` are static
- **Not re-verified live** in the most recent validation round (Docker daemon was wedged)

### Penetration Testing (score: 0/2)

No injection testing, fuzzing, or red-team exercise has been performed. No security audit by an external firm.

### Audit Trail (score: 1/2)

The observability plane records step-level events (tool execution, LLM call, policy decision). However, there is no formal audit log format, no tamper-evident logging, and no SIEM integration.

### Rate Limiting (score: 1/2)

Rate limits are configured per-service via environment variables (`RATE_LIMIT_RPM=30`, `RATE_LIMIT_AGENT_EXECUTIONS=10`). Not verified under load — the load test that hit llm-router limits was constrained by OpenRouter upstream, not E-GAOP's rate limiter.

---

## Known Gaps Summary

| Gap | Priority | Status |
|-----|----------|--------|
| Vulnerability scanning | High | Not started |
| CI/CD execution | High | Not started |
| Penetration testing | Medium | Not started |
| mTLS enablement | Medium | Partially done |
| Cert rotation | Medium | Not started |
| Formal audit log | Low | Basic implementation exists |
| RBAC completeness | Low | Partially done |

> Full gap list: [`production-readiness-final.md`](production-readiness-final.md) (Known Gaps section).
