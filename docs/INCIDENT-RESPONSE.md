# E-GAOP Incident Response

> When things go wrong, follow this playbook.

## Severity Levels

| Level | Description | Response Time | Example |
|-------|-------------|--------------|---------|
| P1 | Service completely down, data loss, security breach | 5 min | API server unreachable, database corruption |
| P2 | Major feature broken, significant user impact | 15 min | Authentication failing, agent execution errors |
| P3 | Minor feature broken, limited user impact | 1 hour | Dashboard not loading, slow queries |
| P4 | Cosmetic issue, no user impact | Next business day | UI glitch, log noise |

## Incident Commander Responsibilities

1. **Coordinate response** — Who's doing what
2. **Communicate status** — Update #incidents channel every 15 min
3. **Make decisions** — Rollback vs. fix-forward
4. **Escalate** — When to bring in more people
5. **Document** — Capture timeline and decisions

## Communication Templates

### Initial Acknowledgment
```
🚨 INCIDENT: [Brief description]
Severity: P[1-4]
Impact: [What users are affected]
Status: Investigating
Next update: [Time]
```

### Status Update
```
📋 INCIDENT UPDATE: [Brief description]
Status: [Investigating/Mitigating/Resolved]
Impact: [Current user impact]
Actions taken: [What we've done]
Next steps: [What we're doing next]
Next update: [Time]
```

### Resolution
```
✅ INCIDENT RESOLVED: [Brief description]
Duration: [Total time]
Root cause: [Brief explanation]
Impact: [Total user impact]
Action items: [Link to postmortem]
```

## Rollback Procedure

```bash
# 1. Identify the problematic commit
git log --oneline -10

# 2. Revert to previous version
git revert HEAD

# 3. Rebuild and deploy
docker compose build [service]
docker compose up -d [service]

# 4. Verify
curl http://localhost:15051/healthz

# 5. Communicate
# Update #incidents channel
```

## Emergency Contacts

| Situation | Contact | When |
|-----------|---------|------|
| Database corruption | DBA Team | P1 only |
| Security breach | Security Team + CTO | Immediately |
| Data loss | Engineering Manager + CTO | Immediately |
| Customer impact | Support Team + PM | After mitigation |
