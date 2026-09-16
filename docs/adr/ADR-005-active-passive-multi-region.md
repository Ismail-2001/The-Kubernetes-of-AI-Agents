# ADR-005: Active-Passive Multi-Region

## Status
Accepted

## Date
2026-09-17

## Context
E-GAOP requires 99.95% availability with disaster recovery capabilities. The platform needs to survive a full region outage while maintaining data consistency. Active-active multi-region deployments introduce significant complexity for data synchronization, conflict resolution, and routing.

## Decision
Deploy E-GAOP in an active-passive multi-region configuration. The primary region handles all traffic while the secondary region maintains a warm standby with asynchronous data replication. DNS failover will be used to redirect traffic to the secondary region during primary region outages.

## Consequences

### Positive
- Simpler data consistency model (single-writer)
- No distributed transaction complexity or conflict resolution
- Clear failover semantics: secondary region takes over during outages
- Lower infrastructure cost compared to active-active (secondary is standby)
- Well-understood operational model for disaster recovery

### Negative
- Secondary region is idle 99% of the time (cost inefficiency)
- Failover introduces DNS propagation delay (typically 30-60 seconds)
- Data loss window exists based on replication lag (RPO > 0)
- Manual or semi-automated failover process may introduce human error
- Recovery time (RTO) depends on failover automation maturity

### Risks
- DNS propagation delay mitigated by using low TTL values and health-check-based failover
- Data loss mitigated by synchronous replication for critical data and monitoring replication lag
- Failover complexity mitigated by regular disaster recovery drills and runbook automation
