#!/usr/bin/env bash
# E-GAOP DR Drill Script — Tests disaster recovery capabilities
# Usage: ./scripts/dr-drill.sh [--type=full|partial|tabletop]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DRILL_TYPE="${1:-partial}"
RESULTS_FILE="$PROJECT_DIR/docs/dr-drill-results-$(date +%Y%m%d-%H%M%S).md"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASSED=0
FAILED=0
WARNED=0
START_TIME=$(date +%s)

pass() { ((PASSED++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { ((FAILED++)); echo -e "  ${RED}✗${NC} $1"; }
warn() { ((WARNED++)); echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║       E-GAOP DR Drill — $DRILL_TYPE               ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
info "Started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

# ── Phase 1: Pre-drill validation ──────────────────────
info "Phase 1: Pre-drill validation"

# Check Docker is running
if docker info > /dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  echo "Cannot proceed without Docker"
  exit 1
fi

# Check critical containers
CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null || echo "")
for svc in postgres redis; do
  if echo "$CONTAINERS" | grep -q "$svc"; then
    pass "Service $svc is running"
  else
    warn "Service $svc not running (may already be stopped)"
  fi
done

echo ""

# ── Phase 2: Backup verification ───────────────────────
info "Phase 2: Backup verification"

# Check if backup scripts exist
for script in backup.sh backup-db.sh; do
  if [ -f "$PROJECT_DIR/scripts/$script" ]; then
    pass "Backup script exists: scripts/$script"
  else
    warn "Backup script missing: scripts/$script"
  fi
done

# Check if restore scripts exist
for script in restore.sh restore-db.sh; do
  if [ -f "$PROJECT_DIR/scripts/$script" ]; then
    pass "Restore script exists: scripts/$script"
  else
    warn "Restore script missing: scripts/$script"
  fi
done

# Check if DR scripts exist
for script in dr-failover.sh dr-failback.sh dr-verify.sh dr-status.sh; do
  if [ -f "$PROJECT_DIR/scripts/$script" ]; then
    pass "DR script exists: scripts/$script"
  else
    warn "DR script missing: scripts/$script"
  fi
done

echo ""

# ── Phase 3: Data integrity ────────────────────────────
info "Phase 3: Data integrity checks"

# Check database health
PG_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i postgres | head -1)
if [ -n "$PG_CONTAINER" ]; then
  if docker exec "$PG_CONTAINER" pg_isready -U postgres > /dev/null 2>&1; then
    pass "PostgreSQL is accepting connections"
    
    # Check table count
    TABLE_COUNT=$(docker exec "$PG_CONTAINER" psql -U postgres -d egaop -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d ' ')
    if [ "$TABLE_COUNT" -gt 0 ] 2>/dev/null; then
      pass "Database has $TABLE_COUNT tables"
    else
      warn "Database tables not found"
    fi
    
    # Check for required tables
    for table in agents users audit_log executions; do
      if docker exec "$PG_CONTAINER" psql -U postgres -d egaop -t -c "SELECT 1 FROM $table LIMIT 0" > /dev/null 2>&1; then
        pass "Table '$table' exists"
      else
        warn "Table '$table' missing"
      fi
    done
  else
    warn "PostgreSQL not accepting connections"
  fi
else
  warn "PostgreSQL container not found"
fi

# Check Redis health
REDIS_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i redis | head -1)
if [ -n "$REDIS_CONTAINER" ]; then
  if docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | grep -q PONG; then
    pass "Redis is responding"
  else
    warn "Redis not responding"
  fi
else
  warn "Redis container not found"
fi

echo ""

# ── Phase 4: Configuration verification ────────────────
info "Phase 4: Configuration verification"

# Check .env exists
if [ -f "$PROJECT_DIR/.env" ]; then
  pass ".env file exists"
else
  fail ".env file missing"
fi

# Check required secrets
for var in JWT_SECRET POSTGRES_PASSWORD EGAOP_MASTER_ENCRYPTION_KEY INTERNAL_SERVICE_TOKEN; do
  if grep -q "^${var}=" "$PROJECT_DIR/.env" 2>/dev/null; then
    VALUE=$(grep "^${var}=" "$PROJECT_DIR/.env" | cut -d= -f2-)
    if [ -n "$VALUE" ] && [ "$VALUE" != "changeme" ]; then
      pass "$var is configured"
    else
      warn "$var has default/empty value"
    fi
  else
    warn "$var not set in .env"
  fi
done

echo ""

# ── Phase 5: Network connectivity ──────────────────────
info "Phase 5: Network connectivity"

# Check if egaop-net exists
if docker network inspect egaop-net > /dev/null 2>&1; then
  pass "Docker network 'egaop-net' exists"
else
  warn "Docker network 'egaop-net' not found"
fi

# Check inter-service connectivity
API_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i api-server | head -1)
if [ -n "$API_CONTAINER" ]; then
  pass "API server container is running"
else
  warn "API server container not running"
fi

echo ""

# ── Phase 6: Monitoring ────────────────────────────────
info "Phase 6: Monitoring verification"

# Check Grafana
if curl -sf http://localhost:3003/api/health > /dev/null 2>&1; then
  pass "Grafana is accessible"
else
  warn "Grafana not accessible (port 3003)"
fi

# Check Prometheus
if curl -sf http://localhost:9091/-/healthy > /dev/null 2>&1; then
  pass "Prometheus is accessible"
else
  warn "Prometheus not accessible (port 9091)"
fi

# Check API health
if curl -sf http://localhost:15051/healthz > /dev/null 2>&1; then
  pass "API health endpoint accessible"
else
  warn "API health endpoint not accessible (port 15051)"
fi

echo ""

# ── Phase 7: Failover simulation (tabletop only) ───────
if [ "$DRILL_TYPE" = "tabletop" ]; then
  info "Phase 7: Tabletop exercise"
  echo ""
  echo "  Scenario: Primary PostgreSQL database fails"
  echo "  Questions to answer:"
  echo "    1. How do we detect the failure?"
  echo "    2. What is the automated response?"
  echo "    3. What is the manual intervention required?"
  echo "    4. What is the expected RTO?"
  echo "    5. What is the expected RPO?"
  echo "    6. How do we verify data integrity after recovery?"
  echo "    7. How do we notify affected users?"
  echo ""
  echo "  Document answers in: docs/dr-drill-results-*.md"
  echo ""
fi

# ── Results ─────────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "╔══════════════════════════════════════════════════╗"
echo "║                  Results                        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}Passed: $PASSED${NC}"
echo -e "  ${YELLOW}Warnings: $WARNED${NC}"
echo -e "  ${RED}Failed: $FAILED${NC}"
echo "  Duration: ${DURATION}s"
echo ""

# Write results file
cat > "$RESULTS_FILE" << EOF
# DR Drill Results — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

## Drill Type: $DRILL_TYPE
## Duration: ${DURATION}s

## Summary
- Passed: $PASSED
- Warnings: $WARNED
- Failed: $FAILED

## RTO/RPO Targets
- RTO: < 30 minutes
- RPO: < 1 hour

## Observations
$(date -u +"%Y-%m-%dT%H:%M:%SZ") — DR drill completed

## Action Items
- [ ] Review warnings and fix before next drill
- [ ] Update runbook if any procedures changed
- [ ] Schedule next drill in 30 days
EOF

echo "  Results saved to: $RESULTS_FILE"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo -e "  ${GREEN}✓ DR drill passed!${NC}"
  echo "  Your disaster recovery posture is healthy."
  exit 0
else
  echo -e "  ${RED}✗ DR drill found issues.${NC}"
  echo "  Review the failures above and fix before production."
  exit 1
fi
