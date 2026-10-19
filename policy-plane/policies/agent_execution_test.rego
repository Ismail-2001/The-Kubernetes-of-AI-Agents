package egaop.execution

import future.keywords.in

test_allow_when_namespaces_match_and_no_denies {
  allow with input as {
    "subject": {"namespace": "default", "clearance": 2},
    "action": "agent.run",
    "resource": {"namespace": "default"},
  }
}

test_default_deny_on_empty_input {
  not allow with input as {}
}

test_deny_sandbox_network_egress {
  not allow with input as {
    "subject": {"namespace": "ns1", "tier": "sandbox", "clearance": 2},
    "action": "network_egress",
    "resource": {"namespace": "ns1"},
  }
  deny["Sandbox-tier agents are not permitted to perform network egress"] with input as {
    "subject": {"namespace": "ns1", "tier": "sandbox", "clearance": 2},
    "action": "network_egress",
    "resource": {"namespace": "ns1"},
  }
}

test_sandbox_tier_allowed_for_other_actions {
  allow with input as {
    "subject": {"namespace": "ns1", "tier": "sandbox", "clearance": 2},
    "action": "agent.run",
    "resource": {"namespace": "ns1"},
  }
}

test_deny_pii_below_clearance_2 {
  not allow with input as {
    "subject": {"namespace": "ns1", "clearance": 1},
    "action": "agent.run",
    "resource": {"namespace": "ns1", "pii_detected": true},
  }
  deny["Subject clearance level insufficient for PII-containing resources"] with input as {
    "subject": {"namespace": "ns1", "clearance": 1},
    "action": "agent.run",
    "resource": {"namespace": "ns1", "pii_detected": true},
  }
}

test_allow_pii_at_clearance_2 {
  allow with input as {
    "subject": {"namespace": "ns1", "clearance": 2},
    "action": "agent.run",
    "resource": {"namespace": "ns1", "pii_detected": true},
  }
}

test_deny_namespace_mismatch {
  not allow with input as {
    "subject": {"namespace": "ns1", "clearance": 3},
    "action": "agent.run",
    "resource": {"namespace": "ns2"},
  }
  deny["Namespace mismatch: subject 'ns1' cannot access resource in namespace 'ns2'"] with input as {
    "subject": {"namespace": "ns1", "clearance": 3},
    "action": "agent.run",
    "resource": {"namespace": "ns2"},
  }
}

test_matching_namespace_alone_insufficient_when_denied {
  not allow with input as {
    "subject": {"namespace": "ns1", "tier": "sandbox", "clearance": 3},
    "action": "network_egress",
    "resource": {"namespace": "ns1"},
  }
}
