# Sandbox Authentication & Cross-Tenant Isolation

This document outlines the authentication and network boundary protections implemented to prevent cross-tenant lateral movement through the shared sandbox network (`egaop-sandbox`).

---

## 1. Threat Model & Lateral Movement Vector

In containerized agent environments, sandboxes run within an execution network (e.g. `egaop-sandbox` subnet `172.30.0.0/16`).
Prior to this enhancement:
- The base runtime HTTP agent server (`server.js`) listened on `0.0.0.0:8080` without authentication.
- A raw `command` execution path accepted arbitrary shell commands behind a regex blocklist (`isCommandSafe`).
- The `tool-proxy` service trusted caller-supplied `sandbox_ip` values as long as they resided in the subnet CIDR.

**Vulnerability:** A compromised agent or malicious tenant inside the sandbox network could:
1. Scan the sandbox subnet for neighbor containers on port 8080.
2. Directly execute arbitrary shell commands via `/exec` without credentials.
3. Supply a victim's IP address to `tool-proxy`, coercing the proxy into attacking or reading state from another tenant's sandbox.

---

## 2. Security Architecture & Controls

```
+-------------------------------------------------------------------------------+
|                             Tool-Proxy Service                                |
|                                                                               |
|  1. Inbound ToolCallRequest (agent_id, execution_id, tool_name, args)         |
|  2. Resolve SandboxRecord from ISandboxRegistry via execution_id               |
|  3. Validate caller namespace == sandbox.namespace (Fail-closed on mismatch)   |
|  4. Disregard caller-supplied sandbox_ip (log warning if divergent)            |
|  5. Attach Authorization: Bearer <sandbox.token>                              |
|  6. Dispatch with 10s timeout & cap response body read at 1 MiB                |
+-------------------------------------------------------------------------------+
                                      |
                                      | HTTP POST /exec
                                      | Authorization: Bearer <32-byte-hex-token>
                                      v
+-------------------------------------------------------------------------------+
|                        Sandbox Container (server.js)                          |
|                                                                               |
|  1. Verify SANDBOX_EXEC_TOKEN at startup (process exits immediately if unset) |
|  2. /healthz: Open, returns { "status": "ok" } (pid stripped)                 |
|  3. /exec: Validates Authorization: Bearer <token> with timingSafeEqual       |
|  4. Raw shell command execution path deleted; only structured tools allowed   |
+-------------------------------------------------------------------------------+
```

### Key Mitigations

1. **Per-Sandbox Execution Token:**
   - For every sandbox creation, `DockerSandboxDriver` generates a cryptographically secure 32-byte token (`crypto.randomBytes(32).toString("hex")`).
   - The token is injected into the container environment as `SANDBOX_EXEC_TOKEN`.
   - The sandbox runtime (`server.js`) strictly verifies `Authorization: Bearer <token>` on all `/exec` requests using `crypto.timingSafeEqual` (preventing timing attacks).
   - If `SANDBOX_EXEC_TOKEN` is unset or blank at container startup, `server.js` terminates immediately with code 1.

2. **Removal of Raw Shell Execution:**
   - The regex-based blocklist (`BLOCKED_PATTERNS` / `isCommandSafe`) and raw `command` path have been eliminated.
   - Only structured `{ tool, args }` handlers (`code_interpreter`, `file_read`, `file_write`, `database_query`) are accepted.
   - Any payload containing a raw `command` returns HTTP 400.

3. **Authoritative Sandbox Registry (`ISandboxRegistry`):**
   - Sandboxes are registered with `{ executionId, agentId, namespace, ip, token }` under `InMemorySandboxRegistry` with TTL (default 1 hour).
   - On sandbox termination (`terminateSandbox`) or driver cleanup, the sandbox record is revoked from the registry.

4. **Namespace-Bound Access Control:**
   - `tool-proxy` never trusts caller-supplied `sandbox_ip`. It looks up the sandbox by `execution_id`.
   - The caller's namespace (extracted from `x-egaop-namespace` metadata or `agent_id`) must match `sandbox.namespace`. Cross-namespace access fails closed with HTTP/gRPC failure.
   - If a caller supplies a deprecated `sandbox_ip` that differs from the resolved IP, a warning is logged and the resolved IP is used.

5. **Streaming Body Cap & Timeouts:**
   - Sandbox HTTP requests are protected with a 10-second timeout (`AbortSignal.timeout(10000)`).
   - Response streams are capped at 1 MiB (`1,048,576` bytes) using a stream reader with early cancellation to prevent memory exhaustion (DoS).

