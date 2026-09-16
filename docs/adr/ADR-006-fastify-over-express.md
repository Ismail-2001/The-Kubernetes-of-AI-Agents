# ADR-006: Fastify over Express

## Status
Accepted

## Date
2026-09-17

## Context
The E-GAOP API gateway needs a high-performance HTTP framework to handle high throughput with low latency. Express, while widely used, has known performance limitations and lacks built-in features like schema validation and serialization that are needed for a production API gateway.

## Decision
Use Fastify v5 as the HTTP framework for the API gateway and all TypeScript HTTP services instead of Express. Fastify will provide the foundation for request handling, validation, serialization, and plugin management.

## Consequences

### Positive
- 2-3x throughput improvement over Express in benchmarks
- Built-in JSON schema validation and serialization (no separate validation middleware)
- Plugin architecture with encapsulated context for better code organization
- Native TypeScript support with first-class type inference
- Lower memory footprint under high concurrency
- Built-in logging with structured output

### Negative
- Smaller ecosystem of middleware compared to Express
- Request/response lifecycle differs from Express (may require rewriting Express middleware)
- Less community documentation and Stack Overflow answers compared to Express
- Plugin compatibility: some Express middleware may not work directly

### Risks
- Ecosystem limitations mitigated by using Fastify's rich plugin ecosystem and wrapping critical Express middleware where needed
- Migration effort mitigated by using Fastify's Express compatibility layer during transition
- Team familiarity mitigated by Fastify's similar API surface to Express (routes, hooks, middleware concepts)
