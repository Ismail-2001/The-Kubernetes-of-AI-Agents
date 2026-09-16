# ADR-008: Docker Compose for Local Dev, Helm for Production

## Status
Accepted

## Date
2026-09-17

## Context
The E-GAOP development team needs a consistent local development environment that mirrors production while keeping developer onboarding simple. Production runs on Kubernetes and requires proper deployment manifests, secrets management, and scaling capabilities. A single deployment approach cannot satisfy both developer experience and production operational needs.

## Decision
Use Docker Compose for local development and staging environments. Use Helm charts for production Kubernetes deployments. Both environments will share the same container images but with environment-specific configurations.

## Consequences

### Positive
- Simple local development with `docker compose up` (single command)
- Docker Compose provides fast iteration cycles for developers
- Helm charts enable proper Kubernetes deployment with rollbacks, scaling, and configuration management
- Shared container images ensure consistency between local and production
- Environment-specific configurations managed through Helm values and Docker Compose env files
- Helm supports template functions for dynamic Kubernetes manifests

### Negative
- Two deployment paths to maintain (Docker Compose and Helm)
- Feature parity between local and production environments may drift over time
- Docker Compose networking differs from Kubernetes networking (service discovery, DNS)
- Local environment may not replicate Kubernetes-specific behaviors (init containers, resource limits)

### Risks
- Environment drift mitigated by using shared Dockerfiles and CI pipeline that tests both environments
- Kubernetes-specific issues not caught locally mitigated by integration test suite that runs against a local K8s cluster (kind/minikube) in CI
- Helm chart complexity mitigated by providing well-documented values.yaml with sensible defaults and environment-specific overrides
