# ADR-002: Temporal for Workflow Orchestration

## Status
Accepted

## Date
2026-09-17

## Context
Agent execution workflows in E-GAOP need to be durable, fault-tolerant, and observable. Workflows can span minutes to hours, involve multiple service calls, and must survive process restarts, deployments, and infrastructure failures. A custom orchestrator would require significant effort to handle retries, timeouts, compensation logic, and state persistence reliably.

## Decision
Use Temporal as the workflow orchestration engine for all agent execution workflows. Temporal will manage workflow state, retries, timeouts, and provide visibility into running/completed workflows. Custom orchestration logic will be written as Temporal workflows and activities.

## Consequences

### Positive
- Built-in durability and fault tolerance without custom state management
- Automatic retries with configurable backoff and timeout policies
- Built-in workflow versioning for safe deployment of workflow changes
- Rich observability: workflow history, execution logs, and Temporal UI
- Compensating transactions (saga pattern) supported natively
- Language-agnostic: workflows can be written in TypeScript, Go, or Java

### Negative
- Adds Temporal server as a critical infrastructure dependency
- Operational complexity of managing Temporal cluster (or using Temporal Cloud)
- Debugging workflow failures requires understanding Temporal's execution model
- Activity timeout and retry configuration requires careful tuning to avoid cascading failures

### Risks
- Temporal cluster availability is critical path mitigated by using Temporal Cloud for production or deploying a multi-node Temporal cluster with proper failover
- Team learning curve mitigated by starting with simple workflows and gradually introducing advanced patterns
- Vendor lock-in mitigated by Temporal's open-source nature and ability to self-host
