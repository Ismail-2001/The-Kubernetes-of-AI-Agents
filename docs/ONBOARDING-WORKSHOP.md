# E-GAOP Onboarding Workshop

> Half-day workshop to get your team building agents.

## Pre-Workshop (15 min, before session)

- [ ] Clone repo: `git clone https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents.git`
- [ ] Run setup: `./scripts/setup.sh`
- [ ] Verify: `curl http://localhost:15051/healthz`
- [ ] Get OpenAI API key (or ask for shared key)

## Agenda

### Part 1: Platform Overview (30 min)

| Time | Topic | Demo |
|------|-------|------|
| 0:00 | What is E-GAOP? | Architecture diagram |
| 0:05 | Core concepts: Agents, Namespaces, Executions | Live walkthrough |
| 0:15 | Dashboard tour | Grafana, Swagger, Admin Console |
| 0:25 | Q&A | |

### Part 2: Build Your First Agent (60 min)

| Time | Topic | Exercise |
|------|-------|----------|
| 0:30 | Agent creation via API | Create "Hello World" agent |
| 0:40 | System prompts and tools | Add a tool to your agent |
| 0:50 | Running and debugging | Execute agent, view traces |
| 1:00 | Namespaces and RBAC | Create namespace, restrict access |
| 1:10 | Cost tracking | Check costs in Grafana |
| 1:20 | Q&A | |

### Part 3: Advanced Topics (45 min)

| Time | Topic | Demo |
|------|-------|------|
| 1:30 | Multi-model routing | Switch between GPT-4o, Claude, Ollama |
| 1:40 | Webhooks and notifications | Set up Slack alerts |
| 1:50 | Feature flags | Enable/disable agents gradually |
| 1:55 | Data retention | GDPR compliance demo |
| 2:00 | Q&A | |

### Part 4: Hands-On Challenge (45 min)

**Challenge**: Build a customer support agent that:
1. Answers questions about a product
2. Creates tickets for complex issues
3. Escalates to human agents when needed

**Deliverable**: Working agent with 3 tools, deployed to your namespace.

### Part 5: Wrap-Up (15 min)

| Time | Topic |
|------|-------|
| 2:45 | Resources and documentation |
| 2:50 | Support channels (Slack, office hours) |
| 2:55 | Feedback and next steps |

## Post-Workshop Checklist

- [ ] Agent deployed and running
- [ ] Namespace configured
- [ ] Monitoring dashboards bookmarked
- [ ] Support Slack channel joined
- [ ] Office hours calendar invite accepted

## Support

- **Office Hours**: Tuesdays 2-3 PM
- **Slack**: #egaop-support
- **Docs**: docs/ directory
- **Runbook**: docs/OPERATIONAL-RUNBOOK.md
