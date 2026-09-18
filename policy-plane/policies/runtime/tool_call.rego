package egaop.runtime

import future.keywords.in

default allow = false

allow {
  input.tool_name == "stripe.charges.create"
  input.args.amount <= 10000
}

allow {
  input.tool_name == "admin.user.delete"
  input.agent_metadata.labels["security-clearance"] == "restricted"
}

allow {
  not startswith(input.tool_name, "stripe.")
  not startswith(input.tool_name, "admin.")
}

requires_approval {
  input.tool_name == "stripe.charges.create"
  input.args.amount > 10000
}

deny[msg] {
  input.tool_name == "stripe.charges.create"
  input.args.amount > 1000000
  msg := sprintf("Absolute maximum charge amount (1M cents) exceeded: %v", [input.args.amount])
}

deny[msg] {
  input.tool_name == "admin.user.delete"
  not input.agent_metadata.labels["security-clearance"] == "restricted"
  msg := "Agent does not have permission to use administrative deletion tools."
}
