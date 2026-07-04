package egaop.admission

import future.keywords.in

default allow = false

# Validate agent schema version
allow if {
  input.kind == "Agent"
  input.api_version == "egaop.io/v1"
  input.spec.version != ""
}

# Enforce mandatory security metadata
violation contains msg if {
  not input.metadata.labels["tier"]
  msg := "Agent must have a 'tier' label (e.g., critical, high, normal)"
}

# Restrict code execution for low-tier agents
violation contains msg if {
  input.metadata.labels["tier"] == "low"
  some tool in input.spec.tools
  tool.ref == "code-executor"
  msg := "Low-tier agents are not permitted to use code-execution tools."
}

# Require budget for all agents
violation contains msg if {
  not input.spec.cost_budget.per_day
  msg := "Agent must have a daily cost budget."
}

# Max token limit enforcement
violation contains msg if {
  input.spec.llm.max_tokens_per_execution > 100000
  msg := "Maximum tokens per execution cannot exceed 100,000."
}
