#!/usr/bin/env bash
# E-GAOP Setup Validation — Comprehensive health check
# Usage: ./scripts/validate-setup.sh [base_url]

set -euo pipefail

BASE="${1:-http://localhost:3001}"
HEALTH_PORT=15051
PASSED=0
FAILED=0
WARNED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { ((PASSED++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { ((FAILED++)); echo -e "  ${RED}✗${NC} $1"; }
warn() { ((WARNED++)); echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║       E-GAOP Setup Validation                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Infrastructure ─────────────────────────────────
info "Checking infrastructure..."

if docker ps > /dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
fi

# Check required containers
REQUIRED_CONTAINERS=("egaop-postgres" "egaop-redis" "egaop-api-server")
for container in "${REQUIRED_CONTAINERS[@]}"; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "$container"; then
    STATUS=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo "unknown")
    if [ "$STATUS" = "running" ]; then
      pass "Container $container is running"
    else
      warn "Container $container is $STATUS"
    fi
  else
    fail "Container $container not found"
  fi
done

echo ""

# ── API Health ─────────────────────────────────────
info "Checking API endpoints..."

# Health endpoint
HEALTH=$(curl -sf "$BASE/healthz" 2>/dev/null || echo '{"status":"unavailable"}')
if echo "$HEALTH" | grep -q '"ok"\|"healthy"\|"up"'; then
  pass "API health endpoint responding"
else
  fail "API health endpoint not responding"
fi

# Dedicated health port
HEALTH2=$(curl -sf "http://localhost:$HEALTH_PORT/healthz" 2>/dev/null || echo '{"status":"unavailable"}')
if echo "$HEALTH2" | grep -q '"ok"\|"healthy"\|"up"'; then
  pass "Dedicated health port responding"
else
  fail "Dedicated health port not responding"
fi

# API docs
if curl -sf "$BASE/api/docs" > /dev/null 2>&1; then
  pass "Swagger UI available"
else
  warn "Swagger UI not available"
fi

echo ""

# ── Authentication ─────────────────────────────────
info "Checking authentication..."

# Register test user
REGISTER_RESPONSE=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"Validation Test","email":"validate-'$(date +%s)'@test.com","password":"TestPassword123!"}' 2>/dev/null || echo '{"error":"unavailable"}')

if echo "$REGISTER_RESPONSE" | grep -q '"token"\|"data"\|"id"'; then
  pass "User registration working"
else
  fail "User registration failed: $REGISTER_RESPONSE"
fi

# Login
LOGIN_RESPONSE=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@egaop.io","password":"DemoPassword123!"}' 2>/dev/null || echo '{"error":"unavailable"}')

TOKEN=$(echo "$LOGIN_RESPONSE" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).data.token||'')}catch{console.log('')}})" 2>/dev/null || echo "")

if [ -n "$TOKEN" ]; then
  pass "User login working"
else
  warn "Login requires demo user to exist"
fi

echo ""

# ── Core API ───────────────────────────────────────
info "Checking core API endpoints..."

if [ -n "$TOKEN" ]; then
  # Agents list
  AGENTS=$(curl -sf "$BASE/api/agents" -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo '{"error":"unavailable"}')
  if echo "$AGENTS" | grep -q '"data"'; then
    AGENT_COUNT=$(echo "$AGENTS" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).data.length||0)}catch{console.log(0)}})" 2>/dev/null || echo "0")
    pass "Agents endpoint working ($AGENT_COUNT agents)"
  else
    warn "Agents endpoint may need authentication"
  fi

  # Namespaces
  NAMESPACES=$(curl -sf "$BASE/api/namespaces" -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo '{"error":"unavailable"}')
  if echo "$NAMESPACES" | grep -q '"data"'; then
    pass "Namespaces endpoint working"
  else
    warn "Namespaces endpoint may need authentication"
  fi

  # Metrics
  METRICS=$(curl -sf "$BASE/api/metrics" -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo '{"error":"unavailable"}')
  if echo "$METRICS" | grep -q '"data"'; then
    pass "Metrics endpoint working"
  else
    warn "Metrics endpoint may need authentication"
  fi

  # Workflows
  WORKFLOWS=$(curl -sf "$BASE/api/workflows" -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo '{"error":"unavailable"}')
  if echo "$WORKFLOWS" | grep -q '"data"'; then
    pass "Workflows endpoint working"
  else
    warn "Workflows endpoint may need authentication"
  fi
else
  warn "Skipping authenticated endpoints (no token)"
fi

echo ""

# ── Database ───────────────────────────────────────
info "Checking database..."

if docker exec egaop-postgres pg_isready -U postgres > /dev/null 2>&1; then
  pass "PostgreSQL is accepting connections"
else
  fail "PostgreSQL is not accepting connections"
fi

# Check for required tables
TABLES=$(docker exec egaop-postgres psql -U postgres -d egaop -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")
TABLES=$(echo "$TABLES" | tr -d ' ')
if [ "$TABLES" -gt 0 ] 2>/dev/null; then
  pass "Database has $TABLES tables"
else
  warn "Database tables not found (may need migration)"
fi

echo ""

# ── Redis ──────────────────────────────────────────
info "Checking Redis..."

if docker exec egaop-redis redis-cli ping 2>/dev/null | grep -q PONG; then
  pass "Redis is responding"
else
  fail "Redis is not responding"
fi

echo ""

# ── Observability ──────────────────────────────────
info "Checking observability stack..."

# Grafana
if curl -sf http://localhost:3003/api/health > /dev/null 2>&1; then
  pass "Grafana is running"
else
  warn "Grafana is not running (optional)"
fi

# Prometheus
if curl -sf http://localhost:9091/-/healthy > /dev/null 2>&1; then
  pass "Prometheus is running"
else
  warn "Prometheus is not running (optional)"
fi

echo ""

# ── Summary ────────────────────────────────────────
echo "╔══════════════════════════════════════════════════╗"
echo "║                  Results                        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}Passed: $PASSED${NC}"
echo -e "  ${YELLOW}Warnings: $WARNED${NC}"
echo -e "  ${RED}Failed: $FAILED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo -e "  ${GREEN}✓ Setup is valid!${NC}"
  echo ""
  echo "  Your E-GAOP platform is ready."
  echo "  API: $BASE"
  echo "  Docs: $BASE/api/docs"
  echo "  Grafana: http://localhost:3003"
  echo ""
  exit 0
else
  echo -e "  ${RED}✗ Setup has issues. Check the failures above.${NC}"
  echo ""
  echo "  Try:"
  echo "    docker compose logs api-server | tail -20"
  echo "    docker compose down -v && docker compose up -d"
  echo ""
  exit 1
fi
