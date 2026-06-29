package egaop.execution

import future.keywords.in

default allow = false

# Allow if subject namespace matches resource namespace and no other rules deny
allow {
  input.subject.namespace == input.resource.namespace
  not deny[_]
}

# Deny: sandbox agents cannot perform network egress
deny[msg] {
  input.subject.tier == "sandbox"
  input.action == "network_egress"
  msg := "Sandbox-tier agents are not permitted to perform network egress"
}

# Deny: PII resources require clearance level >= 2
deny[msg] {
  input.resource.pii_detected == true
  input.subject.clearance < 2
  msg := "Subject clearance level insufficient for PII-containing resources"
}

# Deny: namespace mismatch
deny[msg] {
  input.subject.namespace != input.resource.namespace
  msg := sprintf("Namespace mismatch: subject '%s' cannot access resource in namespace '%s'", [
    input.subject.namespace,
    input.resource.namespace,
  ])
}
