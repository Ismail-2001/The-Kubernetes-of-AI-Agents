#!/usr/bin/env bash
# =============================================================================
# Smoke tests (The Kubernetes of AI Agents)
# =============================================================================
# Runs after deploy-staging. Exits 1 on any failure to trigger rollback.
# Usage: bash scripts/smoke-test.sh <staging-base-url>
# =============================================================================

set -euo pipefail

BASE_URL="${1:?Usage: $0 <staging-base-url>}"
FAILURES=0
SERVICES=(
  "api-server:15051"
  "secret-store:15057"
  "llm-router:15053"
  "tool-proxy:15052"
  "sandbox-runtime:15054"
  "memory-plane:15055"
  "observability-plane:15056"
  "workflow-engine:15058"
)

echo "══════════════════════════════════════════════════════════════"
echo "  Smoke Tests — $BASE_URL"
echo "══════════════════════════════════════════════════════════════"

# ─── Health Checks ──────────────────────────────────────────────────────────
echo ""
echo "── Health Checks ──"

for svc in "${SERVICES[@]}"; do
  name="${svc%%:*}"
  port="${svc##*:}"
  url="http://${BASE_URL}:${port}/healthz"

  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")

  if [ "$status" = "200" ]; then
    echo "  ✓ $name (port $port) — healthy"
  else
    echo "  ✗ $name (port $port) — HTTP $status"
    FAILURES=$((FAILURES + 1))
  fi
done

# ─── OTel Collector ────────────────────────────────────────────────────────
echo ""
echo "── OTel Collector ──"

OTEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${BASE_URL}:13133/" 2>/dev/null || echo "000")
if [ "$OTEL_STATUS" = "200" ]; then
  echo "  ✓ OTel Collector — healthy"
else
  echo "  ✗ OTel Collector — HTTP $OTEL_STATUS"
  FAILURES=$((FAILURES + 1))
fi

# ─── Prometheus ─────────────────────────────────────────────────────────────
echo ""
echo "── Prometheus ──"

PROM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${BASE_URL}:9090/-/healthy" 2>/dev/null || echo "000")
if [ "$PROM_STATUS" = "200" ]; then
  echo "  ✓ Prometheus — healthy"
else
  echo "  ✗ Prometheus — HTTP $PROM_STATUS"
  FAILURES=$((FAILURES + 1))
fi

# ─── Grafana ────────────────────────────────────────────────────────────────
echo ""
echo "── Grafana ──"

GRAFANA_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${BASE_URL}:3000/api/health" 2>/dev/null || echo "000")
if [ "$GRAFANA_STATUS" = "200" ]; then
  echo "  ✓ Grafana — healthy"
else
  echo "  ✗ Grafana — HTTP $GRAFANA_STATUS"
  FAILURES=$((FAILURES + 1))
fi

# ─── OTel Trace Arrival ────────────────────────────────────────────────────
echo ""
echo "── OTel Trace Verification ──"

# Query Tempo for any traces from the last 5 minutes
TRACE_QUERY=$(curl -s --max-time 10 \
  "http://${BASE_URL}:3200/api/search?query={service.name=%22egaop-api-server%22}&limit=1" \
  2>/dev/null || echo '{"traces":[]}')

TRACE_COUNT=$(echo "$TRACE_QUERY" | jq '.traces | length' 2>/dev/null || echo "0")

if [ "$TRACE_COUNT" -gt 0 ]; then
  echo "  ✓ Traces arriving in Tempo ($TRACE_COUNT found)"
else
  echo "  ⚠ No traces found in Tempo (may need warmup — not blocking)"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"

if [ "$FAILURES" -gt 0 ]; then
  echo "  FAILED — $FAILURES check(s) failed"
  echo "══════════════════════════════════════════════════════════════"
  exit 1
else
  echo "  ALL CHECKS PASSED"
  echo "══════════════════════════════════════════════════════════════"
  exit 0
fi
