I built an AI agent platform. Then I spent 18 months learning that the hardest part isn't shipping features — it's being honest about what's actually working.

10 microservices. 812 tests. 17/17 CI green. 0 CVEs.

But here's what nobody talks about: documentation drift.

My mentor flagged the same issue THREE times. Three rounds of review. Three times I shipped new code without fixing the documentation contradictions. The score said 97% but the audit said 79.5%. The pentest was done but the docs said "not performed." Eval count was 37 but docs said 19.

That pattern — shipping features while leaving known documentation bugs unfixed — was more damaging than any technical debt. Because when someone clicks your GitHub link from a LinkedIn post, the README is the first thing they see. If that's lying, nothing else matters.

I fixed it. Finally. Here's what the platform actually does:

🔴 CHAOS ENGINEERING FOR AGENTS
• Kill PostgreSQL mid-execution → WAL replay recovers workflow state
• OPA policy service crash → fail-closed (deny all actions)
• LLM provider 429 flood → circuit breaker trips in 30s, fallback chain activates
• Concurrency exhaustion → graceful degradation, not collapse
15 chaos tests. 100% recovery rate.

🟠 COST ENGINEERING (Token FinOps)
• Per-token cost tracking per provider
• Token-budget-aware routing: cheap model first, escalate on failure
• Per-execution $5 hard budget cap
• HPA scales down idle agents → 60% compute savings off-peak
Result: 89.5% task success at 40% lower token cost.

🔵 SECURITY MATURITY
• Prompt injection detection with severity scoring
• SSRF protection with URL allowlisting
• Supply-chain scanning: CodeQL + Trivy + Dependabot + Gitleaks
• Independent audit: 5 Critical + 17 High findings remediated. Published.

🟢 OBSERVABILITY FOR NON-DETERMINISTIC SYSTEMS
• Distributed tracing across 11 services (OpenTelemetry)
• Per-execution span trees: see every tool call, every token, every ms
• 11 Grafana alerts + runbooks for every failure mode

🟣 RELIABILITY FOR MULTI-MODEL FALLBACK
• Per-provider circuit breakers (not just global)
• Blast radius containment: one agent crash ≠ system crash
• Graceful degradation: GPT-4 → Claude → Ollama → cached response
• SLO/SLI per agent type

🟡 DEVELOPER EXPERIENCE
• docker-compose up → full system with mock LLM (no API keys needed)
• Contract testing: OpenAPI + proto validation on every PR
• Pre-commit: lint + typecheck + eval regression check

⚫ AGENTIC-SPECIFIC ENGINEERING
• Eval-driven development: 37 golden cases across 11 categories
• Hallucination detection: scoring with [0,1] clamping
• Human-in-the-loop escalation: agent escalates when uncertain
• Agent versioning: rollback if new spec regresses

And now — CI guards against documentation drift. Because I learned the hard way that if you don't automate honesty, it doesn't happen.

The full architecture is open-source.
Link in comments. 👇

If you're building agentic systems in production — let's connect. I'm always trading notes on what breaks and how to fix it.

#AgenticAI #LLMOps #ChaosEngineering #PromptInjection #AIEngineering #ReAct #MultiAgent #SiteReliability #BuildInPublic