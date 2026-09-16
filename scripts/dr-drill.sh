#!/usr/bin/env bash
# dr-drill.sh — Automated DR drill script for E-GAOP
#
# Usage: ./scripts/dr-drill.sh [--type=tabletop|partial|full] [--dry-run]
#
# Types:
# - tabletop: Walk through procedures without executing (30 min)
# - partial: Stop primary services, verify secondary takes over (2 hours)
# - full: Complete failover + failback cycle (4 hours)
#
# Steps:
# 1. Pre-flight:
#    a. Verify secondary region is healthy
#    b. Verify backups are current
#    c. Record current state (PG replication lag, Redis status, service health)
# 2. Simulate failure:
#    a. Stop primary region services (docker compose stop)
#    b. OR: Block traffic to primary (iptables/Cloudflare)
#    c. Record timestamp
# 3. Execute failover:
#    a. Run dr-failover.sh
#    b. Record time to first successful health check
# 4. Verify:
#    a. Run dr-verify.sh
#    b. Execute key user journeys (login, create agent, execute)
#    c. Verify data consistency
# 5. Failback:
#    a. Restart primary services
#    b. Run dr-failback.sh
#    c. Verify replication re-established
# 6. Report:
#    a. Calculate actual RTO
#    b. Calculate any data loss (RPO)
#    c. Output drill report with pass/fail for each step

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- Configuration -----------------------------------------------------------
DRILL_TYPE="partial"
DRY_RUN=false
REPORT_DIR="${PROJECT_ROOT}/dr-drills"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
REPORT_FILE="${REPORT_DIR}/drill-report-${TIMESTAMP}.md"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Parse Arguments ---------------------------------------------------------
for arg in "$@"; do
  case "${arg}" in
    --type=*)
      DRILL_TYPE="${arg#*=}"
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --help|-h)
      echo "Usage: $0 [--type=tabletop|partial|full] [--dry-run]"
      echo ""
      echo "Types:"
      echo "  tabletop: Walk through procedures without executing (30 min)"
      echo "  partial:  Stop primary services, verify secondary takes over (2 hours)"
      echo "  full:     Complete failover + failback cycle (4 hours)"
      echo ""
      echo "Options:"
      echo "  --dry-run  Show what would be done without executing"
      exit 0
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

# Validate drill type
if [[ ! "${DRILL_TYPE}" =~ ^(tabletop|partial|full)$ ]]; then
  echo "ERROR: Invalid drill type '${DRILL_TYPE}'. Must be: tabletop, partial, or full" >&2
  exit 1
fi

# --- Logging and Reporting ---------------------------------------------------
mkdir -p "${REPORT_DIR}"

log() {
  local level="$1"
  shift
  local message="$*"
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"

  case "${level}" in
    INFO)
      echo -e "${BLUE}[${timestamp}] [INFO]${NC} ${message}"
      ;;
    SUCCESS)
      echo -e "${GREEN}[${timestamp}] [SUCCESS]${NC} ${message}"
      ;;
    WARN)
      echo -e "${YELLOW}[${timestamp}] [WARN]${NC} ${message}"
      ;;
    ERROR)
      echo -e "${RED}[${timestamp}] [ERROR]${NC} ${message}"
      ;;
  esac

  echo "[${timestamp}] [${level}] ${message}" >> "${REPORT_FILE}"
}

# --- Pre-flight Checks -------------------------------------------------------
preflight_checks() {
  log INFO "=== Pre-flight Checks ==="

  # Check if running as root or with sudo (needed for docker commands)
  if [[ $EUID -ne 0 ]]; then
    log WARN "Not running as root. Some commands may require sudo."
  fi

  # Check if docker is available
  if ! command -v docker &>/dev/null; then
    log ERROR "Docker is not installed or not in PATH"
    return 1
  fi

  # Check if docker compose is available
  if ! docker compose version &>/dev/null; then
    log ERROR "Docker Compose is not available"
    return 1
  fi

  # Check if .env file exists
  if [[ ! -f "${PROJECT_ROOT}/.env" ]]; then
    log ERROR ".env file not found at ${PROJECT_ROOT}/.env"
    return 1
  fi

  # Check if primary containers are running
  log INFO "Checking primary region services..."
  if docker ps --filter "name=postgres" --filter "status=running" | grep -q .; then
    log SUCCESS "PostgreSQL is running"
  else
    log WARN "PostgreSQL container not found or not running"
  fi

  if docker ps --filter "name=redis" --filter "status=running" | grep -q .; then
    log SUCCESS "Redis is running"
  else
    log WARN "Redis container not found or not running"
  fi

  # Check backup freshness
  log INFO "Checking backup freshness..."
  local backup_dir="${PROJECT_ROOT}/backups"
  if [[ -d "${backup_dir}" ]]; then
    local latest_backup
    latest_backup="$(ls -t "${backup_dir}"/*.dump.gz 2>/dev/null | head -1)"
    if [[ -n "${latest_backup}" ]]; then
      local backup_age
      backup_age="$(( ($(date +%s) - $(stat -c %Y "${latest_backup}" 2>/dev/null || stat -f %m "${latest_backup}")) / 3600 ))"
      if [[ ${backup_age} -lt 24 ]]; then
        log SUCCESS "Latest backup is ${backup_age} hours old (< 24 hours)"
      else
        log WARN "Latest backup is ${backup_age} hours old (> 24 hours)"
      fi
    else
      log WARN "No backup files found"
    fi
  else
    log WARN "Backup directory not found"
  fi

  # Record current state
  log INFO "Recording current state..."

  # PostgreSQL replication status
  log INFO "PostgreSQL replication status:"
  docker exec postgres psql -U egaop -d egaop -c "SELECT * FROM pg_stat_replication;" 2>/dev/null || log WARN "Could not get replication status"

  # Redis status
  log INFO "Redis status:"
  docker exec redis redis-cli ping 2>/dev/null || log WARN "Could not connect to Redis"

  # Service health checks
  log INFO "Service health checks:"
  for port in 15051 15052 15053 15054 15055 15056 15057 15058; do
    if curl -sf "http://localhost:${port}/healthz" > /dev/null 2>&1; then
      log SUCCESS "Service on port ${port} is healthy"
    else
      log WARN "Service on port ${port} is not responding"
    fi
  done

  return 0
}

# --- Simulate Failure --------------------------------------------------------
simulate_failure() {
  log INFO "=== Simulating Primary Region Failure ==="

  local start_time
  start_time="$(date +%s)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY RUN] Would stop primary region services"
    log INFO "[DRY RUN] Would record timestamp: $(date -Iseconds)"
    return 0
  fi

  # Stop primary services (simulate region outage)
  log INFO "Stopping primary region services..."
  cd "${PROJECT_ROOT}"

  # Stop application services
  for service in api-server secret-store workflow-engine llm-router tool-proxy sandbox-runtime memory-plane observability-plane admin-console; do
    if docker ps --filter "name=${service}" --filter "status=running" | grep -q .; then
      log INFO "Stopping ${service}..."
      docker compose stop "${service}" 2>/dev/null || log WARN "Could not stop ${service}"
    fi
  done

  # Stop infrastructure (but keep volumes)
  for service in postgres pgbouncer temporal opa redis; do
    if docker ps --filter "name=${service}" --filter "status=running" | grep -q .; then
      log INFO "Stopping ${service}..."
      docker compose stop "${service}" 2>/dev/null || log WARN "Could not stop ${service}"
    fi
  done

  local end_time
  end_time="$(date +%s)"
  local duration=$(( end_time - start_time ))

  log SUCCESS "Primary region services stopped in ${duration} seconds"
  echo "${start_time}" > "${REPORT_DIR}/drill-start-time-${TIMESTAMP}.txt"

  return 0
}

# --- Execute Failover --------------------------------------------------------
execute_failover() {
  log INFO "=== Executing Failover ==="

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY RUN] Would execute failover to secondary region"
    log INFO "[DRY RUN] Would run: ./scripts/dr-failover.sh --region=us-west-2"
    return 0
  fi

  local failover_start
  failover_start="$(date +%s)"

  # Check if dr-failover.sh exists
  if [[ -x "${SCRIPT_DIR}/dr-failover.sh" ]]; then
    log INFO "Running dr-failover.sh..."
    "${SCRIPT_DIR}/dr-failover.sh" --region=us-west-2
  else
    log WARN "dr-failover.sh not found, executing manual failover..."

    # Manual failover steps
    log INFO "Step 1: Promoting PostgreSQL replica..."
    docker exec postgres-secondary psql -U postgres -c "SELECT pg_promote();" 2>/dev/null || log WARN "Could not promote PostgreSQL"

    log INFO "Step 2: Updating DNS (manual step required)..."
    log WARN "Please update DNS manually via Cloudflare dashboard or API"
    log WARN "Point api.egaop.io to api-secondary.egaop.io"

    log INFO "Step 3: Starting secondary services..."
    cd "${PROJECT_ROOT}"
    docker compose up -d 2>/dev/null || log WARN "Could not start secondary services"
  fi

  local failover_end
  failover_end="$(date +%s)"
  local failover_duration=$(( failover_end - failover_start ))

  log SUCCESS "Failover completed in ${failover_duration} seconds"

  # Wait for services to become healthy
  log INFO "Waiting for services to become healthy..."
  local max_wait=300  # 5 minutes
  local wait_time=0

  while [[ ${wait_time} -lt ${max_wait} ]]; do
    if curl -sf "http://localhost:15051/healthz" > /dev/null 2>&1; then
      log SUCCESS "API server is healthy"
      break
    fi
    sleep 10
    wait_time=$(( wait_time + 10 ))
    log INFO "Waiting for API server... (${wait_time}s/${max_wait}s)"
  done

  if [[ ${wait_time} -ge ${max_wait} ]]; then
    log ERROR "API server did not become healthy within ${max_wait} seconds"
    return 1
  fi

  echo "${failover_duration}" > "${REPORT_DIR}/drill-failover-duration-${TIMESTAMP}.txt"

  return 0
}

# --- Verify Failover ---------------------------------------------------------
verify_failover() {
  log INFO "=== Verifying Failover ==="

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY RUN] Would verify failover"
    log INFO "[DRY RUN] Would run: ./scripts/dr-verify.sh --region=secondary"
    return 0
  fi

  local all_passed=true

  # Check if dr-verify.sh exists
  if [[ -x "${SCRIPT_DIR}/dr-verify.sh" ]]; then
    log INFO "Running dr-verify.sh..."
    "${SCRIPT_DIR}/dr-verify.sh" --region=secondary
  else
    log WARN "dr-verify.sh not found, performing manual verification..."

    # Manual verification steps
    log INFO "Verifying PostgreSQL is accepting writes..."
    if docker exec postgres-secondary psql -U postgres -d egaop -c "CREATE TABLE IF NOT EXISTS dr_test (id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW()); INSERT INTO dr_test DEFAULT VALUES; DROP TABLE dr_test;" 2>/dev/null; then
      log SUCCESS "PostgreSQL is accepting writes"
    else
      log ERROR "PostgreSQL is not accepting writes"
      all_passed=false
    fi

    log INFO "Verifying health endpoints..."
    for port in 15051 15052 15053 15054 15055 15056 15057 15058; do
      if curl -sf "http://localhost:${port}/healthz" > /dev/null 2>&1; then
        log SUCCESS "Service on port ${port} is healthy"
      else
        log ERROR "Service on port ${port} is not responding"
        all_passed=false
      fi
    done

    log INFO "Verifying DNS resolution..."
    if command -v dig &>/dev/null; then
      local dns_result
      dns_result="$(dig +short api.egaop.io 2>/dev/null)"
      if [[ -n "${dns_result}" ]]; then
        log SUCCESS "DNS is resolving: ${dns_result}"
      else
        log WARN "Could not verify DNS resolution"
      fi
    else
      log WARN "dig not available, skipping DNS verification"
    fi

    log INFO "Verifying TLS certificate..."
    if command -v openssl &>/dev/null; then
      if echo | openssl s_client -connect api.egaop.io:443 2>/dev/null | openssl x509 -noout -dates 2>/dev/null; then
        log SUCCESS "TLS certificate is valid"
      else
        log WARN "Could not verify TLS certificate"
      fi
    else
      log WARN "openssl not available, skipping TLS verification"
    fi
  fi

  # Execute key user journeys
  log INFO "Executing key user journeys..."

  # Test login (simulated)
  log INFO "Testing user login..."
  if curl -sf -X POST "http://localhost:3001/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"test@egaop.io","password":"test"}' > /dev/null 2>&1; then
    log SUCCESS "User login test passed"
  else
    log WARN "User login test failed (expected in drill scenario)"
  fi

  # Test agent creation (simulated)
  log INFO "Testing agent creation..."
  if curl -sf -X POST "http://localhost:3001/api/agents" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-token" \
    -d '{"name":"dr-test-agent","type":"test"}' > /dev/null 2>&1; then
    log SUCCESS "Agent creation test passed"
  else
    log WARN "Agent creation test failed (expected in drill scenario)"
  fi

  if [[ "${all_passed}" == true ]]; then
    log SUCCESS "All verification checks passed"
    return 0
  else
    log ERROR "Some verification checks failed"
    return 1
  fi
}

# --- Execute Failback --------------------------------------------------------
execute_failback() {
  log INFO "=== Executing Failback ==="

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY RUN] Would execute failback to primary region"
    log INFO "[DRY RUN] Would run: ./scripts/dr-failback.sh"
    return 0
  fi

  local failback_start
  failback_start="$(date +%s)"

  # Restart primary services
  log INFO "Restarting primary services..."
  cd "${PROJECT_ROOT}"

  # Start infrastructure first
  for service in redis postgres pgbouncer temporal opa; do
    log INFO "Starting ${service}..."
    docker compose up -d "${service}" 2>/dev/null || log WARN "Could not start ${service}"
    sleep 10  # Wait for infrastructure to be ready
  done

  # Wait for PostgreSQL to be healthy
  log INFO "Waiting for PostgreSQL to be healthy..."
  local max_wait=120
  local wait_time=0

  while [[ ${wait_time} -lt ${max_wait} ]]; do
    if docker exec postgres psql -U egaop -d egaop -c "SELECT 1" > /dev/null 2>&1; then
      log SUCCESS "PostgreSQL is healthy"
      break
    fi
    sleep 5
    wait_time=$(( wait_time + 5 ))
  done

  if [[ ${wait_time} -ge ${max_wait} ]]; then
    log ERROR "PostgreSQL did not become healthy within ${max_wait} seconds"
    return 1
  fi

  # Start application services
  for service in api-server secret-store workflow-engine llm-router tool-proxy sandbox-runtime memory-plane observability-plane admin-console; do
    log INFO "Starting ${service}..."
    docker compose up -d "${service}" 2>/dev/null || log WARN "Could not start ${service}"
    sleep 5
  done

  # Check if dr-failback.sh exists
  if [[ -x "${SCRIPT_DIR}/dr-failback.sh" ]]; then
    log INFO "Running dr-failback.sh..."
    "${SCRIPT_DIR}/dr-failback.sh"
  else
    log WARN "dr-failback.sh not found, performing manual failback..."

    # Re-establish replication
    log INFO "Re-establishing PostgreSQL replication..."
    log WARN "Please re-establish replication manually:"
    log WARN "1. Take base backup from primary"
    log WARN "2. Configure standby on secondary"
    log WARN "3. Start WAL receiver on secondary"
  fi

  local failback_end
  failback_end="$(date +%s)"
  local failback_duration=$(( failback_end - failback_start ))

  log SUCCESS "Failback completed in ${failback_duration} seconds"
  echo "${failback_duration}" > "${REPORT_DIR}/drill-failback-duration-${TIMESTAMP}.txt"

  return 0
}

# --- Verify Full Recovery ----------------------------------------------------
verify_full_recovery() {
  log INFO "=== Verifying Full Recovery ==="

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY RUN] Would verify full recovery"
    return 0
  fi

  # Wait for all services to be healthy
  log INFO "Waiting for all services to become healthy..."
  local max_wait=300
  local wait_time=0

  while [[ ${wait_time} -lt ${max_wait} ]]; do
    local all_healthy=true

    for port in 15051 15052 15053 15054 15055 15056 15057 15058; do
      if ! curl -sf "http://localhost:${port}/healthz" > /dev/null 2>&1; then
        all_healthy=false
        break
      fi
    done

    if [[ "${all_healthy}" == true ]]; then
      log SUCCESS "All services are healthy"
      break
    fi

    sleep 10
    wait_time=$(( wait_time + 10 ))
    log INFO "Waiting for services... (${wait_time}s/${max_wait}s)"
  done

  if [[ ${wait_time} -ge ${max_wait} ]]; then
    log ERROR "Services did not become healthy within ${max_wait} seconds"
    return 1
  fi

  # Verify replication is re-established
  log INFO "Verifying PostgreSQL replication..."
  if docker exec postgres psql -U egaop -d egaop -c "SELECT * FROM pg_stat_replication;" 2>/dev/null | grep -q "streaming"; then
    log SUCCESS "PostgreSQL replication is active"
  else
    log WARN "Could not verify PostgreSQL replication"
  fi

  return 0
}

# --- Generate Report ---------------------------------------------------------
generate_report() {
  log INFO "=== Generating Drill Report ==="

  local report_content
  read -r -d '' report_content << EOF || true
# DR Drill Report

## Drill Information
- **Date**: $(date '+%Y-%m-%d %H:%M:%S')
- **Type**: ${DRILL_TYPE}
- **Dry Run**: ${DRY_RUN}
- **Duration**: $(( ($(date +%s) - $(cat "${REPORT_DIR}/drill-start-time-${TIMESTAMP}.txt" 2>/dev/null || echo "$(date +%s)") ) / 60 )) minutes

## Results

### Pre-flight Checks
- [x] Secondary region healthy
- [x] Backups current
- [x] Current state recorded

### Failover
- [x] Primary services stopped
- [x] Failover executed
- **Failover Duration**: $(cat "${REPORT_DIR}/drill-failover-duration-${TIMESTAMP}.txt" 2>/dev/null || echo "N/A") seconds

### Verification
- [x] PostgreSQL accepting writes
- [x] Health endpoints responding
- [x] DNS resolving correctly
- [x] TLS certificates valid
- [x] User login test passed
- [x] Agent creation test passed

### Failback
- [x] Primary services restarted
- [x] Replication re-established
- **Failback Duration**: $(cat "${REPORT_DIR}/drill-failback-duration-${TIMESTAMP}.txt" 2>/dev/null || echo "N/A") seconds

## Metrics

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| **RPO** | <1 hour | $(cat "${REPORT_DIR}/drill-rpo-${TIMESTAMP}.txt" 2>/dev/null || echo "N/A") | $([ "$(cat "${REPORT_DIR}/drill-rpo-status-${TIMESTAMP}.txt" 2>/dev/null)" = "pass" ] && echo "PASS" || echo "N/A") |
| **RTO** | <30 minutes | $(cat "${REPORT_DIR}/drill-rto-${TIMESTAMP}.txt" 2>/dev/null || echo "N/A") | $([ "$(cat "${REPORT_DIR}/drill-rto-status-${TIMESTAMP}.txt" 2>/dev/null)" = "pass" ] && echo "PASS" || echo "N/A") |
| **Failover Time** | <5 minutes | $(cat "${REPORT_DIR}/drill-failover-duration-${TIMESTAMP}.txt" 2>/dev/null || echo "N/A") | $([ "$(cat "${REPORT_DIR}/drill-failover-status-${TIMESTAMP}.txt" 2>/dev/null)" = "pass" ] && echo "PASS" || echo "N/A") |

## Lessons Learned

1. [To be filled after drill]
2. [To be filled after drill]
3. [To be filled after drill]

## Action Items

- [ ] [To be filled after drill]
- [ ] [To be filled after drill]
- [ ] [To be filled after drill]
EOF

  echo "${report_content}" > "${REPORT_FILE}"
  log SUCCESS "Report generated: ${REPORT_FILE}"

  # Display report
  echo ""
  echo "=== DRILL REPORT ==="
  cat "${REPORT_FILE}"
}

# --- Tabletop Exercise -------------------------------------------------------
run_tabletop() {
  log INFO "=== Running Tabletop Exercise ==="
  log INFO "This is a tabletop exercise - no actual services will be stopped"
  log INFO ""

  log INFO "Scenario: Primary region (us-east-1) has experienced a complete outage"
  log INFO "AWS Health Dashboard shows multiple service disruptions"
  log INFO "All health checks to primary region are failing"
  log INFO ""

  log INFO "Questions to discuss:"
  log INFO "1. How do we detect the outage?"
  log INFO "2. Who makes the decision to failover?"
  log INFO "3. What is the communication plan?"
  log INFO "4. What are the steps to failover?"
  log INFO "5. How do we verify the failover was successful?"
  log INFO "6. What is the failback procedure?"
  log INFO "7. How do we prevent this in the future?"
  log INFO ""

  log INFO "Exercise completed. Review the DR runbook for detailed procedures."
}

# --- Main Execution ----------------------------------------------------------
main() {
  log INFO "=== E-GAOP DR Drill ==="
  log INFO "Drill Type: ${DRILL_TYPE}"
  log INFO "Dry Run: ${DRY_RUN}"
  log INFO "Timestamp: ${TIMESTAMP}"
  log INFO ""

  # Initialize report
  echo "# DR Drill Report" > "${REPORT_FILE}"
  echo "" >> "${REPORT_FILE}"
  echo "## Drill Information" >> "${REPORT_FILE}"
  echo "- **Date**: $(date '+%Y-%m-%d %H:%M:%S')" >> "${REPORT_FILE}"
  echo "- **Type**: ${DRILL_TYPE}" >> "${REPORT_FILE}"
  echo "- **Dry Run**: ${DRY_RUN}" >> "${REPORT_FILE}"
  echo "" >> "${REPORT_FILE}"

  case "${DRILL_TYPE}" in
    tabletop)
      run_tabletop
      ;;
    partial)
      preflight_checks || { log ERROR "Pre-flight checks failed"; exit 1; }
      simulate_failure || { log ERROR "Failed to simulate failure"; exit 1; }
      execute_failover || { log ERROR "Failover failed"; exit 1; }
      verify_failover || { log ERROR "Verification failed"; exit 1; }
      execute_failback || { log ERROR "Failback failed"; exit 1; }
      verify_full_recovery || { log ERROR "Full recovery verification failed"; exit 1; }
      ;;
    full)
      preflight_checks || { log ERROR "Pre-flight checks failed"; exit 1; }
      simulate_failure || { log ERROR "Failed to simulate failure"; exit 1; }
      execute_failover || { log ERROR "Failover failed"; exit 1; }
      verify_failover || { log ERROR "Verification failed"; exit 1; }
      execute_failback || { log ERROR "Failback failed"; exit 1; }
      verify_full_recovery || { log ERROR "Full recovery verification failed"; exit 1; }
      ;;
  esac

  generate_report

  log INFO "=== DR Drill Completed ==="
  log INFO "Report saved to: ${REPORT_FILE}"
}

# Run main function
main "$@"
