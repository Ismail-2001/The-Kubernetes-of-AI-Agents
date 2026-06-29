package egaop.runtime

import future.keywords.in

default allow = false

# Allow all non-financial tools by default (if no other blocks)
allow {
  input.tool_name != "stripe.charges.create"
  input.tool_name != "stripe.refunds.create"
}

# Enforce limits on Stripe charges
allow {
  input.tool_name == "stripe.charges.create"
  input.args.amount <= 10000 # Max 10,000 cents ($100) for standard agents
}

# Require manual approval (gate) for large charges
requires_approval {
  input.tool_name == "stripe.charges.create"
  input.args.amount > 10000
}

# Absolute maximum charge limit — no approval can bypass
violation[msg] {
  input.tool_name == "stripe.charges.create"
  input.args.amount > 1000000
  msg := sprintf("Absolute maximum charge amount (1M cents) exceeded: %v", [input.args.amount])
}

# Block sensitive tools for agents without proper clearance
violation[msg] {
  input.tool_name == "admin.user.delete"
  not input.agent_metadata.labels["security-clearance"] == "restricted"
  msg := "Agent does not have permission to use administrative deletion tools."
}
