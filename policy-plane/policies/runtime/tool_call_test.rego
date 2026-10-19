package egaop.runtime

test_allow_stripe_charge_at_limit {
  allow with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 10000},
  }
  not requires_approval with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 10000},
  }
  count(deny) == 0 with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 10000},
  }
}

test_stripe_above_soft_limit_requires_approval_and_is_denied_by_allow {
  not allow with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 50000},
  }
  requires_approval with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 50000},
  }
  count(deny) == 0 with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 50000},
  }
}

test_deny_stripe_above_absolute_max {
  not allow with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 2000000},
  }
  deny["Absolute maximum charge amount (1M cents) exceeded: 2000000"] with input as {
    "tool_name": "stripe.charges.create",
    "args": {"amount": 2000000},
  }
}

test_default_deny_stripe_missing_amount {
  not allow with input as {"tool_name": "stripe.charges.create", "args": {}}
}

test_allow_admin_delete_restricted {
  allow with input as {
    "tool_name": "admin.user.delete",
    "args": {},
    "agent_metadata": {"labels": {"security-clearance": "restricted"}},
  }
}

test_deny_admin_delete_without_restricted_clearance {
  not allow with input as {
    "tool_name": "admin.user.delete",
    "args": {},
    "agent_metadata": {"labels": {}},
  }
  deny["Agent does not have permission to use administrative deletion tools."] with input as {
    "tool_name": "admin.user.delete",
    "args": {},
    "agent_metadata": {"labels": {}},
  }
}

test_allow_ordinary_tool_without_agent_metadata {
  allow with input as {"tool_name": "files.read", "args": {"path": "/tmp/x"}}
}
