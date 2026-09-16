# ADR-004: OPA for Policy Enforcement

## Status
Accepted

## Date
2026-09-17

## Context
E-GAOP requires fine-grained access control across namespaces, agents, tools, and resources. Policies need to be dynamic, auditable, and centrally managed. Hardcoding authorization logic in each service leads to inconsistency, duplication, and difficulty in updating policies across the platform.

## Decision
Use Open Policy Agent (OPA) as the centralized policy engine for all authorization decisions across the platform. OPA will evaluate policies written in Rego for every request to sensitive endpoints, tool invocations, and cross-service calls. Policies will be version-controlled and deployed alongside service releases.

## Consequences

### Positive
- Centralized, consistent policy enforcement across all services
- Policies are version-controlled and auditable
- Rego language supports complex, fine-grained policy logic
- Hot-reload of policies without service restarts
- Decouples policy decisions from application code
- OPA can be embedded as a library or run as a sidecar/service

### Negative
- Rego has a learning curve for policy authors unfamiliar with the language
- Policy evaluation latency adds overhead to each authorized request
- Debugging complex Rego policies can be non-trivial
- OPA becomes a critical dependency for authorization

### Risks
- OPA availability mitigated by embedding OPA as a library (in-process) for low-latency evaluation with local policy cache
- Rego learning curve mitigated by providing policy templates and examples for common patterns
- Policy drift mitigated by automated policy testing in CI/CD pipeline using OPA's test framework
