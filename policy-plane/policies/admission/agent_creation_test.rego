package egaop.admission

test_allow_valid_agent {
  allow with input as {
    "kind": "Agent",
    "api_version": "egaop.io/v1",
    "metadata": {"labels": {"tier": "normal"}},
    "spec": {
      "version": "v1",
      "cost_budget": {"per_day": 5},
      "tools": [{"ref": "http-fetch"}],
      "llm": {"max_tokens_per_execution": 32000},
    },
  }
  count(violation) == 0 with input as {
    "kind": "Agent",
    "api_version": "egaop.io/v1",
    "metadata": {"labels": {"tier": "normal"}},
    "spec": {
      "version": "v1",
      "cost_budget": {"per_day": 5},
      "tools": [{"ref": "http-fetch"}],
      "llm": {"max_tokens_per_execution": 32000},
    },
  }
}

test_default_deny_without_kind_or_version {
  not allow with input as {"kind": "Agent", "api_version": "egaop.io/v1", "metadata": {"labels": {"tier": "normal"}}, "spec": {}}
}

test_violation_missing_tier_label {
  violation["Agent must have a 'tier' label (e.g., critical, high, normal)"] with input as {
    "kind": "Agent",
    "api_version": "egaop.io/v1",
    "metadata": {"labels": {}},
    "spec": {"version": "v1", "cost_budget": {"per_day": 1}, "tools": [], "llm": {"max_tokens_per_execution": 1}},
  }
}

test_violation_low_tier_with_code_executor {
  violation["Low-tier agents are not permitted to use code-execution tools."] with input as {
    "kind": "Agent",
    "api_version": "egaop.io/v1",
    "metadata": {"labels": {"tier": "low"}},
    "spec": {"version": "v1", "cost_budget": {"per_day": 1}, "tools": [{"ref": "code-executor"}], "llm": {"max_tokens_per_execution": 1}},
  }
}

test_violation_missing_cost_budget {
  violation["Agent must have a daily cost budget."] with input as {
    "kind": "Agent",
    "api_version": "egaop.io/v1",
    "metadata": {"labels": {"tier": "normal"}},
    "spec": {"version": "v1", "tools": [], "llm": {"max_tokens_per_execution": 1}},
  }
}

test_violation_max_tokens_exceeded {
  violation["Maximum tokens per execution cannot exceed 100,000."] with input as {
    "kind": "Agent",
    "api_version": "egaop.io/v1",
    "metadata": {"labels": {"tier": "normal"}},
    "spec": {"version": "v1", "cost_budget": {"per_day": 1}, "tools": [], "llm": {"max_tokens_per_execution": 250000}},
  }
}
