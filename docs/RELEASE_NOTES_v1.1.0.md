## E-GAOP v1.1.0 — Production-Grade Agent Orchestration

**The Kubernetes of AI Agents.** 10 microservices, 5 architectural planes, 360+ tests, 0 CVEs, 37 eval cases.

### What's New in v1.1.0

#### Security (Penetration Test Remediation)
- Removed V1 weak encryption fallback — only V2 (scrypt + Argon2id + AES-256-GCM) remains
- Blocked `code_interpreter` host execution — must route through K8s sandbox runtime
- Added JWT authentication to all WebSocket endpoints (`/api/ws/executions/:id`, `/api/ws/events`)
- Pinned all 14 Docker images to specific versions (zero `:latest` tags)
- Persisted audit chain to PostgreSQL for durability
- Added newline-blocked command injection filter in K8s exec path
- Added Trivy image-scan gate to CI that blocks pushes on CRITICAL/HIGH findings

#### Evaluation & Quality
- Expanded golden eval dataset from 19 → **37 cases** across 11 categories
- New coverage: multi-turn conversations, error recovery, edge cases, workflow orchestration, security scenarios
- Added multi-turn `messages` support to the eval runner
- Enabled TypeScript strictness (`noUnusedLocals`, `noUnusedParameters`) — all 10 workspaces clean
- Added coverage thresholds (80/75/80/80) to all workspace Jest configs

#### Reliability
- mTLS now opt-in (TLS-only is the safe default due to upstream Node http2/grpc-js bug)
- Eval runner uses dynamic Temporal container lookup (no hardcoded names)
- Retry logic added to eval workflow triggers

#### Documentation
- New 5-minute `docs/quickstart.md` and `docs/troubleshooting.md`
- Expanded `CONTRIBUTING.md` (architecture, env vars, dev workflow)
- Updated `SECURITY.md` (scanning active, audit completed)
- Rewritten multi-audience README

### Highlights
- 360+ unit tests passing across 10 npm workspaces
- 0 known CVEs (19 fixed)
- 79.5% production-readiness score (FAANG audit, 10 categories, pilot workloads scope)
- 37 eval cases, 89.5%+ pass rate on prior baseline
- CI: 17/17 jobs green · Security scan: 14/14 jobs green
- Helm: 11 sub-charts with HPA, PDB, NetworkPolicy, canary

### Breaking Changes
- `code_interpreter` no longer executes on the host — must run through the sandbox runtime
- Docker images use explicit version tags (no `:latest`)

### Upgrading
```bash
docker compose pull
docker compose up -d
```
