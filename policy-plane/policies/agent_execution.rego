package egaop.execution

import future.keywords.in

default allow = false

allow if {
  input.subject.namespace == input.resource.namespace
  count(deny) == 0
}

deny contains msg if {
  input.subject.tier == "sandbox"
  input.action == "network_egress"
  msg := "Sandbox-tier agents are not permitted to perform network egress"
}

deny contains msg if {
  input.resource.pii_detected == true
  input.subject.clearance < 2
  msg := "Subject clearance level insufficient for PII-containing resources"
}

deny contains msg if {
  input.subject.namespace != input.resource.namespace
  msg := sprintf("Namespace mismatch: subject '%s' cannot access resource in namespace '%s'", [
    input.subject.namespace,
    input.resource.namespace,
  ])
}
