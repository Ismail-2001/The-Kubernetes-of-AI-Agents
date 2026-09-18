package egaop.execution

import future.keywords.in

default allow = false

allow {
  input.subject.namespace == input.resource.namespace
  count(deny) == 0
}

deny[msg] {
  input.subject.tier == "sandbox"
  input.action == "network_egress"
  msg := "Sandbox-tier agents are not permitted to perform network egress"
}

deny[msg] {
  input.resource.pii_detected == true
  input.subject.clearance < 2
  msg := "Subject clearance level insufficient for PII-containing resources"
}

deny[msg] {
  input.subject.namespace != input.resource.namespace
  msg := sprintf("Namespace mismatch: subject '%s' cannot access resource in namespace '%s'", [
    input.subject.namespace,
    input.resource.namespace,
  ])
}
