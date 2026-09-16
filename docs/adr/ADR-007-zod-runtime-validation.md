# ADR-007: Zod for Runtime Validation

## Status
Accepted

## Date
2026-09-17

## Context
E-GAOP APIs receive untrusted input from external clients and inter-service calls. We need runtime validation at API boundaries to prevent invalid data from entering the system. Maintaining separate TypeScript types and validation schemas leads to drift, duplication, and bugs when they get out of sync.

## Decision
Use Zod schemas as the single source of truth for both TypeScript types and runtime validation. All API request/response bodies, configuration objects, and external data boundaries will be defined as Zod schemas. TypeScript types will be inferred from these schemas using `z.infer<>`.

## Consequences

### Positive
- Single source of truth eliminates type/validation drift
- End-to-end type safety from API boundary to internal code
- Detailed, human-readable error messages for validation failures
- Composable schemas for complex validation patterns (nested objects, unions, discriminated unions)
- Seamless integration with Fastify's JSON schema validation

### Negative
- Zod adds ~14KB to the client bundle size (minimal for server-side)
- Schema-first approach requires upfront schema definition before implementation
- Complex conditional validation can be verbose in Zod compared to custom validators
- Runtime validation adds overhead compared to no validation

### Risks
- Bundle size impact mitigated by using Zod only server-side or using tree-shaking for client code
- Schema maintenance overhead mitigated by colocating schemas with their corresponding service modules
- Performance overhead mitigated by validating only at API boundaries, not internal service calls
