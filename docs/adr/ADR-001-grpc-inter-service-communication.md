# ADR-001: gRPC for Inter-Service Communication

## Status
Accepted

## Date
2026-09-17

## Context
The E-GAOP platform consists of 10+ microservices that need to communicate with each other. We need a high-performance, type-safe communication protocol that supports efficient serialization, bidirectional streaming, and strong contract enforcement between services. REST/JSON introduces unnecessary overhead and lacks compile-time type checking for service interfaces.

## Decision
Use gRPC with Protocol Buffers for all inter-service communication. REST APIs will only be exposed for external-facing endpoints (client applications, third-party integrations). Each service will define its `.proto` files, and shared proto definitions will be maintained in a common repository.

## Consequences

### Positive
- Strong compile-time typing eliminates entire classes of serialization bugs
- HTTP/2 multiplexing enables high-throughput concurrent calls
- Protocol Buffers provide efficient binary serialization (5-10x smaller than JSON)
- Built-in streaming support for real-time agent communication
- Automatic code generation for client/server stubs in TypeScript, Go, and Python

### Negative
- Harder to debug than REST (binary payloads require special tooling like grpcurl)
- Smaller ecosystem of debugging/monitoring tools compared to REST
- Learning curve for team members unfamiliar with Protocol Buffers
- Browser clients cannot directly call gRPC without a proxy layer

### Risks
- Team unfamiliarity with gRPC tooling mitigated by investing in internal developer documentation and grpcurl/gRPC UI tooling setup
- Browser compatibility mitigated by gRPC-Web proxy or REST gateway for frontend clients
