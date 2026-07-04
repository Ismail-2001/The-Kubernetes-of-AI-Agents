package egaop.runtime

import future.keywords.in

default allow = false

allow if {
  input.tool_name != "stripe.charges.create"
  input.tool_name != "stripe.refunds.create"
}

allow if {
  input.tool_name == "stripe.charges.create"
  input.args.amount <= 10000
}

requires_approval if {
  input.tool_name == "stripe.charges.create"
  input.args.amount > 10000
}

deny contains msg if {
  input.tool_name == "stripe.charges.create"
  input.args.amount > 1000000
  msg := sprintf("Absolute maximum charge amount (1M cents) exceeded: %v", [input.args.amount])
}

deny contains msg if {
  input.tool_name == "admin.user.delete"
  not input.agent_metadata.labels["security-clearance"] == "restricted"
  msg := "Agent does not have permission to use administrative deletion tools."
}
