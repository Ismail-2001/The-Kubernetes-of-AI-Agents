# E-GAOP Threat Model

Status: living document. Controls listed here were verified against the code
during the security hardening pass (commits `c2a1f33`..`0708a76`); anything
not listed should be assumed absent, not merely undocumented.

## Assets

| Asset | Why it matters |
|-------|----------------|
| Tenant agent memory (PostgreSQL/pgvector) | Cross-tenant data leakage |
| LLM API keys / master encryption key | Credential theft, cost abuse |
| Sandbox containers | Host compromise, lateral movement |
| Audit log (hash-chained) | Tamper detection |
| Workflow state (Temporal) | Execution integrity |

## Trust boundaries

1. **Public edge** (admin-console, api-server REST :3001) - untrusted users.
2. **Internal gRPC mesh** - mutually distrusted services; identity via
   `x-service-token` (HMAC compare against `INTERNAL_SERVICE_TOKEN`).
3. **Sandbox network** (`egaop-sandbox`, compose subnet 172.30.0.0/16) -
   agent code is hostile. tool-proxy is the only caller.
4. **OPA** - policy decisions for workflow admission.

## Controls (verified in code)

| Control | Where |
|---------|-------|
| Secrets validated at boot, fail-closed (entropy + minimum lengths) | `packages/shared/src/config/validate-secrets.ts` |
| Password KDF: scrypt (N=2^15) with per-secret salt, versioned | `packages/shared/src/crypto` (P0-1) |
| JWT: HS256-only, `exp` mandatory, timing-safe compare, old-secret rotation | `packages/shared/src/crypto/index.ts` (P1-4, P0 era) |
| REST authz fail-closed: RBAC + namespace scoping on every route | `control-plane/api-server/src/index.ts` preHandler (P1-1) |
| gRPC service identity: timing-safe `x-service-token` (required whenever `INTERNAL_SERVICE_TOKEN` is set) | `packages/shared/src/grpc/interceptors.ts` |
| Policy enforcement: real Rego loaded and queried; fake-stub check in CI | workflow-engine `check-no-fake-policy.ts` + `opa test` (P0-3) |
| Sandbox: read-only rootfs + tmpfs /tmp + /workspace, CapDrop ALL, no-new-privileges, seccomp opt, image allowlist | `execution-plane/sandbox-runtime/src/docker-driver.ts` (P1-5) |
| SSRF: always-denied CIDRs (loopback/link-local/CGNAT/metadata), scoped sandbox-IP allowlist, no redirects, no creds to sandbox targets | `execution-plane/tool-proxy/src/index.ts` (P1-2) |
| PII scan on tool arguments before egress | tool-proxy `scanForPII` |
| Audit entries hash-chained | `packages/shared/src/audit` |
| Memory plane gRPC route: fail-closed service-token check | `memory-plane/src/service-token.ts` (P1-4) |
| NetworkPolicy default-deny + explicit per-service egress/ingress | `charts/e-gaop/templates/networkpolicy.yaml` |
| Compose sandbox network pinned to 172.30.0.0/16; tool-proxy allowlisted to it | `docker-compose.yml` (P1-2) |

## Known gaps (residual risk - accepted, documented)

| Gap | Risk | Notes |
|-----|------|-------|
| gRPC namespace-enforcement interceptor no-op in production | High | No client attaches `x-agent-claims`; downstream never reads `x-caller-*`. REST and memory-plane paths do enforce namespaces. Live isolation suite in CI will fail until redesigned. |
| mTLS client-cert verification disabled | Medium | `@grpc/grpc-js` upstream issue; server can request certs but does not verify. See SECURITY.md. |
| Tool-proxy auth to serpapi relies on query param | Low | Header injection kept for other tools. |
| REST secret-store check-then-use race | Low | Single-instance deployments only affected. |
| OTLP egress only when Tempo enabled | Info | Intentional; no otel-collector deployment exists. |
| Docker socket reachable by sandbox-runtime | Medium | Mitigated by docker-socket-proxy allowlist in compose; treat the sandbox-runtime pod as privileged-tier. |

## Out of scope

- Physical security, OS-level attacks on nodes.
- LLM prompt-injection outcomes (tool + policy layers bound blast radius,
  they do not eliminate it).
- Supply-chain compromise of base images beyond Trivy scanning in CI.
