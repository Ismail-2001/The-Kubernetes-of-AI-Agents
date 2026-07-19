# Security

## Current Status

**Vulnerability scanning has never run on this repository's container images.**
See `docs/production-readiness-final.md` (Known Gaps section) for details.

## Reporting a Vulnerability

If you discover a security issue in E-GAOP, please report it privately:

1. **Do not** open a public GitHub issue.
2. Send details to the repository maintainer via GitHub's security advisory tool at:
   `https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/security/advisories/new`
3. Include:
   - Component affected (service name, port)
   - Type of vulnerability (XSS, injection, auth bypass, etc.)
   - Steps to reproduce
   - Potential impact

## What's Implemented

- OPA policy enforcement for agent execution authorization
- JWT authentication for API access
- Encrypted secret storage (AES-256-GCM, Postgres-backed)
- Sandbox network isolation (egaop-sandbox internal network)
- TLS encryption for gRPC (mTLS not yet active — known limitation)

## What's Not Implemented

- Automated vulnerability scanning (planned, not yet active)
- Penetration testing (not performed)
- mTLS (disabled due to upstream library bug)
- Formal security audit (not conducted)
- Automated secret scanning in CI (not configured)

See `docs/production-readiness-final.md` for the full security assessment.
