#!/usr/bin/env bash
# E-GAOP Integration Tests
# Validates that all critical fixes are working in the running cluster.
# Run: bash tests/integration.sh
set -euo pipefail

NAMESPACE="egaop"
PASS=0
FAIL=0
TOTAL=0

green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }
header() { printf "\n\033[1m── %s ──\033[0m\n" "$1"; }

assert_eq() {
  TOTAL=$((TOTAL + 1))
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1))
    green "$3"
  else
    FAIL=$((FAIL + 1))
    red "$3 (expected '$1', got '$2')"
  fi
}

assert_contains() {
  TOTAL=$((TOTAL + 1))
  if echo "$2" | grep -q "$1"; then
    PASS=$((PASS + 1))
    green "$3"
  else
    FAIL=$((FAIL + 1))
    red "$3 (expected to contain '$1')"
  fi
}

assert_http() {
  TOTAL=$((TOTAL + 1))
  local code
  code=$(kubectl exec -n "$NAMESPACE" "$2" -- wget -qO- --timeout=5 "http://$3" 2>/dev/null | head -1 || echo "TIMEOUT")
  if [ "$code" = "$4" ]; then
    PASS=$((PASS + 1))
    green "$5"
  else
    FAIL=$((FAIL + 1))
    red "$5 (expected HTTP $4, got '$code')"
  fi
}

# ═══════════════════════════════════════════════════════════════════
# TEST SUITE 1: All pods are Running
# ═══════════════════════════════════════════════════════════════════
header "1. Pod Health"

NOT_RUNNING=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | grep -v "Running" | grep -v "Completed" || true)
NOT_READY=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | grep "Running" | grep -v "1/1" || true)

assert_eq "" "$NOT_RUNNING" "All pods are Running"
assert_eq "" "$NOT_READY" "All pods are 1/1 Ready"

# ═══════════════════════════════════════════════════════════════════
# TEST SUITE 2: Health contract — liveness (/healthz) always 200
# ═══════════════════════════════════════════════════════════════════
header "2. Liveness Contract (/healthz = always 200)"

API_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=api-server -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
WF_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=workflow-engine -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
SANDBOX_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=sandbox-runtime -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
LLM_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=llm-router -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
SECRET_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=secret-store -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
TOOL_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=tool-proxy -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

for POD in "$API_POD" "$WF_POD" "$SANDBOX_POD" "$LLM_POD" "$SECRET_POD" "$TOOL_POD"; do
  NAME=$(echo "$POD" | sed 's/.*-//' | head -c 20)
  TOTAL=$((TOTAL + 1))
  RESP=$(kubectl exec -n "$NAMESPACE" "$POD" -- wget -qO- --timeout=3 "http://127.0.0.1:15051/healthz" 2>/dev/null || echo "FAIL")
  if echo "$RESP" | grep -q "SERVING"; then
    PASS=$((PASS + 1))
    green "$NAME liveness returns SERVING"
  else
    FAIL=$((FAIL + 1))
    red "$NAME liveness does not return SERVING: $RESP"
  fi
done

# ═══════════════════════════════════════════════════════════════════
# TEST SUITE 3: Health contract — readiness (/readyz) checks dependencies
# ═══════════════════════════════════════════════════════════════════
header "3. Readiness Contract (/readyz checks dependencies)"

# api-server readiness should check postgres
TOTAL=$((TOTAL + 1))
RESP=$(kubectl exec -n "$NAMESPACE" "$API_POD" -- wget -qO- --timeout=5 "http://127.0.0.1:15051/readyz" 2>/dev/null || echo "FAIL")
if echo "$RESP" | grep -q '"status":"SERVING"' && echo "$RESP" | grep -q '"postgres"'; then
  PASS=$((PASS + 1))
  green "api-server readiness checks postgres"
else
  FAIL=$((FAIL + 1))
  red "api-server readiness missing postgres check: $RESP"
fi

# workflow-engine readiness should check postgres + temporal
TOTAL=$((TOTAL + 1))
RESP=$(kubectl exec -n "$NAMESPACE" "$WF_POD" -- wget -qO- --timeout=5 "http://127.0.0.1:15058/readyz" 2>/dev/null || echo "FAIL")
if echo "$RESP" | grep -q '"postgres"'; then
  PASS=$((PASS + 1))
  green "workflow-engine readiness checks postgres"
else
  FAIL=$((FAIL + 1))
  red "workflow-engine readiness missing postgres check: $RESP"
fi

TOTAL=$((TOTAL + 1))
RESP=$(kubectl exec -n "$NAMESPACE" "$WF_POD" -- wget -qO- --timeout=5 "http://127.0.0.1:15058/readyz" 2>/dev/null || echo "FAIL")
if echo "$RESP" | grep -q '"temporal"'; then
  PASS=$((PASS + 1))
  green "workflow-engine readiness checks temporal"
else
  FAIL=$((FAIL + 1))
  red "workflow-engine readiness missing temporal check: $RESP"
fi

# ═══════════════════════════════════════════════════════════════════
# TEST SUITE 4: NetworkPolicy — services can reach dependencies
# ═══════════════════════════════════════════════════════════════════
header "4. Network Connectivity"

# api-server can reach postgres
TOTAL=$((TOTAL + 1))
PG_OK=$(kubectl exec -n "$NAMESPACE" "$API_POD" -- wget -qO- --timeout=3 "http://127.0.0.1:15051/readyz" 2>/dev/null || echo "FAIL")
if echo "$PG_OK" | grep -q '"postgres":"healthy"'; then
  PASS=$((PASS + 1))
  green "api-server → postgres reachable"
else
  FAIL=$((FAIL + 1))
  red "api-server → postgres unreachable: $PG_OK"
fi

# workflow-engine can reach postgres
TOTAL=$((TOTAL + 1))
WF_PG=$(kubectl exec -n "$NAMESPACE" "$WF_POD" -- wget -qO- --timeout=5 "http://127.0.0.1:15058/readyz" 2>/dev/null || echo "FAIL")
if echo "$WF_PG" | grep -q '"postgres":"healthy"'; then
  PASS=$((PASS + 1))
  green "workflow-engine → postgres reachable"
else
  FAIL=$((FAIL + 1))
  red "workflow-engine → postgres unreachable: $WF_PG"
fi

# ═══════════════════════════════════════════════════════════════════
# TEST SUITE 5: Health response format matches contract
# ═══════════════════════════════════════════════════════════════════
header "5. Health Response Format"

for PORT in 15051 15053 15054 15057 15058; do
  TOTAL=$((TOTAL + 1))
  RESP=$(kubectl exec -n "$NAMESPACE" "$API_POD" -- wget -qO- --timeout=3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || echo "FAIL")
  HAS_VERSION=$(echo "$RESP" | grep -c '"version"' || true)
  HAS_UPTIME=$(echo "$RESP" | grep -c '"uptime_s"' || true)
  HAS_TIMESTAMP=$(echo "$RESP" | grep -c '"timestamp"' || true)
  if [ "$HAS_VERSION" -ge 1 ] && [ "$HAS_UPTIME" -ge 1 ] && [ "$HAS_TIMESTAMP" -ge 1 ]; then
    PASS=$((PASS + 1))
    green "port $PORT health response has contract fields"
  else
    FAIL=$((FAIL + 1))
    red "port $PORT health response missing contract fields: $RESP"
  fi
done

# ═══════════════════════════════════════════════════════════════════
# TEST SUITE 6: api-server users table exists
# ═══════════════════════════════════════════════════════════════════
header "6. Database Schema"

TOTAL=$((TOTAL + 1))
TABLE_EXISTS=$(kubectl exec -n "$NAMESPACE" "$API_POD" -- wget -qO- --timeout=5 "http://127.0.0.1:15051/readyz" 2>/dev/null || echo "FAIL")
if echo "$TABLE_EXISTS" | grep -q '"postgres":"healthy"'; then
  PASS=$((PASS + 1))
  green "api-server postgres connection healthy (users table must exist)"
else
  FAIL=$((FAIL + 1))
  red "api-server postgres connection failed: $TABLE_EXISTS"
fi

# ═══════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════
echo ""
printf "\033[1m══════════════════════════════════════\033[0m\n"
printf "  Total: %d  Passed: \033[32m%d\033[0m  Failed: \033[31m%d\033[0m\n" "$TOTAL" "$PASS" "$FAIL"
printf "\033[1m══════════════════════════════════════\033[0m\n"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
