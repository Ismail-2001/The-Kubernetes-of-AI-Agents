package egaop.admission

import future.keywords.in

default allow = false

allow {
  input.kind == "Agent"
  input.api_version == "egaop.io/v1"
  input.spec.version != ""
}

violation[msg] {
  not input.metadata.labels["tier"]
  msg := "Agent must have a 'tier' label (e.g., critical, high, normal)"
}

violation[msg] {
  input.metadata.labels["tier"] == "low"
  some tool in input.spec.tools
  tool.ref == "code-executor"
  msg := "Low-tier agents are not permitted to use code-execution tools."
}

violation[msg] {
  not input.spec.cost_budget.per_day
  msg := "Agent must have a daily cost budget."
}

violation[msg] {
  input.spec.llm.max_tokens_per_execution > 100000
  msg := "Maximum tokens per execution cannot exceed 100,000."
}
