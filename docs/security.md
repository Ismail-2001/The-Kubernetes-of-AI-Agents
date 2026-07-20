# E-GAOP Security

**Category score in readiness assessment: 75% (15/20).**
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

### PII Scan — Blocks Requests (score: 2/2, part of Input Sanitization)

The tool-proxy intercepts tool arguments before execution and scans for PII patterns (credit card numbers, SSNs, emails, API keys). If PII is detected, the request is **blocked** with a `PIIViolationError` (callback error), not just logged. Source: `execution-plane/tool-proxy/src/index.ts:137`.

### Rate Limiting — Namespace-Aware (score: 2/2)

Rate limits are scoped per-namespace, not per-IP. The API server extracts namespace from the `x-namespace` header (falls back to client IP). The llm-router and tool-proxy derive namespace from `agent_id` using `extractNamespace()`. Three services implement namespace-aware keying: `control-plane/api-server/src/index.ts`, `execution-plane/llm-router/src/index.ts`, `execution-plane/tool-proxy/src/index.ts`.

### Security Headers & Body Size Limits (score: 2/2, part of Input Validation)

The Fastify API server enforces:
- `bodyLimit: 1048576` (1MB max request body)
- Content-type enforcement (rejects non-`application/json`)
- Security headers via `onSend` hook: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Strict-Transport-Security: max-age=31536000`, `Content-Security-Policy: default-src 'self'`, `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(), microphone=(), camera=()`

---

## Not Implemented

### Vulnerability Scanning (score: 2/2)

`npm audit` executed across all 9 workspace packages — **0 vulnerabilities found** (down from 19: 11 high, 8 moderate). Fixes applied:
- `npm audit fix` upgraded protobufjs, @opentelemetry/core, uuid
- Upgraded testcontainers from `^10.18.0` to `^12.0.4` in 4 workspace package.json files (api-server, secret-store, memory-plane, observability-plane)
- Remaining dev-only vulns (undici, uuid via dockerode) resolved by testcontainers upgrade
- All workspace builds and 54/54 shared tests pass

Trivy image scan configuration exists in `.github/workflows/` but needs GitHub Actions execution for container-level scanning.

### CI/CD Pipeline (score: 0/2)

Workflow files (`ci.yml`, `deploy.yml`) exist but have **never been triggered**. There is no automated path from code change to running deployment. Every deploy is manual. **Blocking for production.**

### TLS / mTLS (score: 1/2 — partial)

TLS encryption is active (`TLS_ENABLED=true` in `.env`). The code at `packages/shared/src/tls.ts` implements `getServerCredentials` and `getClientCredentials` using real CA/server/client certificates. However:

- **mTLS is disabled**: `requestCert: false` workaround due to `@grpc/grpc-js` v1.14.4 bug (client connections fail when server requests client certs)
- **No cert rotation**: Certs in `certs/` are static
- **Not re-verified live** in the most recent validation round (Docker daemon was wedged)

### Penetration Testing (score: 0/2, partially addressed by PII scan)

No injection testing, fuzzing, or red-team exercise has been performed. No security audit by an external firm. The PII scan and content-type enforcement partially mitigate injection risk but do not replace formal security testing.

### Audit Trail (score: 1/2)

The observability plane records step-level events (tool execution, LLM call, policy decision). However, there is no formal audit log format, no tamper-evident logging, and no SIEM integration.

---

## Known Gaps Summary

| Gap | Priority | Status |
|-----|----------|--------|
| CI/CD execution | High | Not started |
| Penetration testing | Medium | Not started |
| mTLS enablement | Medium | Partially done (blocked by upstream grpc-js bug) |
| Cert rotation | Medium | Not started |
| Formal audit log | Low | Basic implementation exists |
| RBAC completeness | Low | Partially done |

## Closed Gaps

| Gap | What was done |
|-----|---------------|
| Vulnerability scanning | `npm audit` — 0 CVEs across all 9 workspaces. 19 vulnerabilities (11 high) fixed via `npm audit fix` + testcontainers upgrade. All builds and tests pass. |

> Full gap list: [`production-readiness-final.md`](production-readiness-final.md) (Known Gaps section).
