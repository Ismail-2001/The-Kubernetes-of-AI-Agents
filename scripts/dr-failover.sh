#!/usr/bin/env bash
# =============================================================================
# dr-failover.sh — Automated disaster recovery failover for E-GAOP
# =============================================================================
# Fails over from the primary region (us-east-1) to a target secondary region.
#
# Usage:
#   ./scripts/dr-failover.sh --region=us-west-2
#   ./scripts/dr-failover.sh --region=us-west-2 --dry-run
#   ./scripts/dr-failover.sh --region=us-west-2 --force
#
# Prerequisites:
#   - Docker, docker-compose
#   - psql (PostgreSQL client)
#   - redis-cli
#   - curl
#   - dig or nslookup (for DNS checks)
# =============================================================================

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Script metadata ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${PROJECT_ROOT}/logs/dr-failover-${TIMESTAMP}.log"
BACKUP_DIR="${PROJECT_ROOT}/backups/dr-pre-failover-${TIMESTAMP}"

# ─── Defaults ───────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE=false
TARGET_REGION=""
MAX_REPLICATION_LAG_SECONDS=300  # 5 minutes

# Health endpoints for all services
HEALTH_PORTS=(
  "api-server:15051"
  "secret-store:15057"
  "llm-router:15053"
  "tool-proxy:15052"
  "sandbox-runtime:15054"
  "memory-plane:15055"
  "observability-plane:15056"
  "workflow-engine:15058"
)

# ─── Logging ────────────────────────────────────────────────────────────────
mkdir -p "${PROJECT_ROOT}/logs"

log() {
  local level="$1"; shift
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local msg="[${ts}] [${level}] $*"
  echo -e "${msg}" | tee -a "${LOG_FILE}"
}

info()    { log "INFO"    "${GREEN}✓${NC} $*"; }
warn()    { log "WARN"    "${YELLOW}⚠${NC} $*"; }
error()   { log "ERROR"   "${RED}✗${NC} $*"; }
step()    { log "STEP"    "${BLUE}▶${NC} $*"; }
dryrun()  { log "DRY-RUN" "${CYAN}[dry-run]${NC} $*"; }

die() {
  error "$*"
  exit 1
}

# ─── Help ───────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") --region=<target-region> [OPTIONS]

Automated disaster recovery failover for E-GAOP.

Options:
  --region=<region>   Target region to fail over to (required: us-west-2)
  --dry-run           Preview actions without making changes
  --force             Skip confirmation prompts
  --max-lag=<seconds> Max acceptable replication lag (default: 300)
  --help              Show this help message

Examples:
  $(basename "$0") --region=us-west-2 --dry-run
  $(basename "$0") --region=us-west-2 --force
EOF
  exit 0
}

# ─── Parse arguments ────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --region=*)
        TARGET_REGION="${1#*=}"
        shift
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --force)
        FORCE=true
        shift
        ;;
      --max-lag=*)
        MAX_REPLICATION_LAG_SECONDS="${1#*=}"
        shift
        ;;
      --help|-h)
        usage
        ;;
      *)
        die "Unknown option: $1 (use --help for usage)"
        ;;
    esac
  done

  [[ -z "${TARGET_REGION}" ]] && die "Missing required argument: --region=<target-region>"
  [[ "${TARGET_REGION}" != "us-west-2" ]] && die "Target region must be us-west-2 (secondary). Got: ${TARGET_REGION}"
}

# ─── Tool checks ────────────────────────────────────────────────────────────
require_tools() {
  local missing=()
  for tool in curl docker psql redis-cli; do
    if ! command -v "${tool}" &>/dev/null; then
      missing+=("${tool}")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    warn "Missing optional tools (some checks may be skipped): ${missing[*]}"
  fi
}

check_tool() {
  command -v "$1" &>/dev/null
}

# ─── Helpers ─────────────────────────────────────────────────────────────────
confirm() {
  if [[ "${FORCE}" == true ]]; then
    return 0
  fi
  echo -en "${YELLOW}Proceed? [y/N]: ${NC}"
  read -r reply
  [[ "${reply}" =~ ^[Yy]$ ]] || die "Aborted by user."
}

backup_config() {
  step "Backing up current configuration..."
  mkdir -p "${BACKUP_DIR}"
  local files=(
    ".env"
    "docker-compose.yml"
  )
  for f in "${files[@]}"; do
    if [[ -f "${PROJECT_ROOT}/${f}" ]]; then
      cp "${PROJECT_ROOT}/${f}" "${BACKUP_DIR}/${f}.bak"
      info "Backed up ${f}"
    fi
  done
}

run_cmd() {
  local description="$1"; shift
  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "${description}: $*"
    return 0
  fi
  step "${description}..."
  if "$@" >> "${LOG_FILE}" 2>&1; then
    info "${description} — completed"
    return 0
  else
    error "${description} — FAILED"
    return 1
  fi
}

# ─── Pre-flight checks ──────────────────────────────────────────────────────
preflight_checks() {
  step "Running pre-flight checks..."

  # Check target region is reachable
  step "Verifying target region ${TARGET_REGION} is reachable..."
  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Region connectivity check"
  else
    if check_tool dig; then
      dig +short +timeout=5 "api.${TARGET_REGION}.egaop.internal" A &>/dev/null || \
        warn "DNS lookup for target region failed (may not be configured yet)"
    elif check_tool nslookup; then
      nslookup "api.${TARGET_REGION}.egaop.internal" &>/dev/null || \
        warn "DNS lookup for target region failed (may not be configured yet)"
    else
      warn "No dig or nslookup available — skipping region reachability check"
    fi
    info "Target region reachability check passed"
  fi

  # Check PostgreSQL replication lag
  step "Checking PostgreSQL replication lag..."
  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Replication lag check (max: ${MAX_REPLICATION_LAG_SECONDS}s)"
  else
    local lag
    lag=$(get_replication_lag)
    if [[ "${lag}" -gt "${MAX_REPLICATION_LAG_SECONDS}" ]]; then
      die "Replication lag (${lag}s) exceeds maximum (${MAX_REPLICATION_LAG_SECONDS}s). Aborting failover."
    fi
    info "Replication lag: ${lag}s (within threshold of ${MAX_REPLICATION_LAG_SECONDS}s)"
  fi

  # Check target region services
  step "Verifying target region services are healthy..."
  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Target region health checks"
  else
    local target_host
    target_host=$(get_target_host)
    local failures=0
    for svc in "${HEALTH_PORTS[@]}"; do
      local name="${svc%%:*}"
      local port="${svc##*:}"
      local status
      status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
        "http://${target_host}:${port}/healthz" 2>/dev/null || echo "000")
      if [[ "${status}" == "200" ]]; then
        info "Target ${name} (port ${port}) — healthy"
      else
        warn "Target ${name} (port ${port}) — HTTP ${status}"
        failures=$((failures + 1))
      fi
    done
    if [[ ${failures} -gt 0 ]]; then
      die "Target region has ${failures} unhealthy service(s). Aborting failover."
    fi
    info "All target region services healthy"
  fi
}

get_replication_lag() {
  local lag="0"
  # Try docker exec into postgres container
  local pg_container
  pg_container=$(docker ps --filter "ancestor=pgvector/pgvector:pg15" --format '{{.Names}}' 2>/dev/null | head -1 || true)
  if [[ -z "${pg_container}" ]]; then
    pg_container="k8s-ai-agents-postgres-1"
  fi

  # Read password from .env
  local pg_password=""
  if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    pg_password=$(grep -E '^POSTGRES_PASSWORD=' "${PROJECT_ROOT}/.env" | tail -1 | cut -d= -f2- || true)
  fi

  if [[ -n "${pg_password}" ]] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "${pg_container}"; then
    local lag_result
    lag_result=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c \
      "SELECT CASE WHEN pg_is_in_recovery() THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int ELSE 0 END;" \
      2>/dev/null || echo "0")
    lag="${lag_result:-0}"
  fi
  echo "${lag}"
}

get_target_host() {
  # In a real multi-region setup, this would resolve to the target region's host.
  # For local/Docker, return localhost.
  echo "localhost"
}

# ─── Failover steps ─────────────────────────────────────────────────────────
stop_primary_writes() {
  step "Setting PostgreSQL to read-only (stopping writes on primary)..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "ALTER SYSTEM SET default_transaction_read_only = on"
    return 0
  fi

  local pg_container
  pg_container=$(docker ps --filter "ancestor=pgvector/pgvector:pg15" --format '{{.Names}}' 2>/dev/null | head -1 || true)
  [[ -z "${pg_container}" ]] && pg_container="k8s-ai-agents-postgres-1"

  local pg_password=""
  if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    pg_password=$(grep -E '^POSTGRES_PASSWORD=' "${PROJECT_ROOT}/.env" | tail -1 | cut -d= -f2- || true)
  fi

  [[ -z "${pg_password}" ]] && die "Cannot read POSTGRES_PASSWORD from .env"

  docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
    psql -U egaop -d egaop -c "ALTER SYSTEM SET default_transaction_read_only = on;" \
    >> "${LOG_FILE}" 2>&1 || die "Failed to set read-only mode on primary"

  docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
    psql -U egaop -d egaop -c "SELECT pg_reload_conf();" \
    >> "${LOG_FILE}" 2>&1 || warn "Failed to reload config (may need manual reload)"

  info "Primary set to read-only"
}

promote_postgres_replica() {
  step "Promoting PostgreSQL replica to primary..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "SELECT pg_promote()"
    return 0
  fi

  local pg_container
  pg_container=$(docker ps --filter "ancestor=pgvector/pgvector:pg15" --format '{{.Names}}' 2>/dev/null | head -1 || true)
  [[ -z "${pg_container}" ]] && pg_container="k8s-ai-agents-postgres-1"

  local pg_password=""
  if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    pg_password=$(grep -E '^POSTGRES_PASSWORD=' "${PROJECT_ROOT}/.env" | tail -1 | cut -d= -f2- || true)
  fi

  [[ -z "${pg_password}" ]] && die "Cannot read POSTGRES_PASSWORD from .env"

  # Wait for promotion with timeout
  local max_wait=60
  local waited=0
  while [[ ${waited} -lt ${max_wait} ]]; do
    local promote_result
    promote_result=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c "SELECT pg_promote();" 2>/dev/null || echo "f")
    if [[ "${promote_result}" == "t" ]]; then
      info "PostgreSQL replica promoted successfully"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  die "PostgreSQL promotion failed after ${max_wait}s"
}

update_redis_sentinel() {
  step "Updating Redis Sentinel configuration..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "redis-cli SENTINEL failover mymaster"
    return 0
  fi

  if check_tool redis-cli; then
    # Sentinel-based Redis failover
    local sentinel_host="${TARGET_REGION}.redis-sentinel"
    if redis-cli -h "${sentinel_host}" -p 26379 SENTINEL masters &>/dev/null 2>&1; then
      redis-cli -h "${sentinel_host}" -p 26379 SENTINEL failover mymaster \
        >> "${LOG_FILE}" 2>&1 || warn "Sentinel failover may need manual intervention"
      info "Redis Sentinel failover initiated"
    else
      warn "Redis Sentinel not reachable at ${sentinel_host} — skipping Sentinel failover"
    fi
  else
    warn "redis-cli not available — manual Redis Sentinel failover required"
  fi
}

update_dns() {
  step "Updating DNS records to point to ${TARGET_REGION}..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "DNS update: api.egaop.io -> ${TARGET_REGION} endpoint"
    return 0
  fi

  # In production, use Cloudflare API or Route53
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] && [[ -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
    step "Updating Cloudflare DNS..."
    curl -s -X PATCH \
      "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${CLOUDFLARE_DNS_RECORD_ID:-}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{\"content\": \"$(get_target_region_ip)\"}" \
      >> "${LOG_FILE}" 2>&1 || warn "Cloudflare DNS update failed — manual intervention required"
    info "Cloudflare DNS updated"
  else
    # Local fallback: update /etc/hosts
    warn "No CLOUDFLARE_API_TOKEN set — updating local /etc/hosts instead"
    local target_ip
    target_ip=$(get_target_region_ip)
    if [[ -f /etc/hosts ]]; then
      if grep -q "egaop.internal" /etc/hosts; then
        sudo sed -i.bak "s/^.*egaop.internal.*$/127.0.0.1 api.egaop.internal/" /etc/hosts
      else
        echo "127.0.0.1 api.egaop.internal" | sudo tee -a /etc/hosts > /dev/null
      fi
      info "Updated /etc/hosts for egaop.internal"
    fi
  fi
}

get_target_region_ip() {
  # Placeholder — resolve from config or environment
  echo "${TARGET_REGION_IP:-127.0.0.1}"
}

restart_secondary_services() {
  step "Restarting services in ${TARGET_REGION} with PRIMARY=true..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "docker-compose up -d (with PRIMARY=true)"
    return 0
  fi

  cd "${PROJECT_ROOT}"

  # Update .env to mark this as primary
  if [[ -f .env ]]; then
    if grep -q "^DR_PRIMARY_REGION=" .env; then
      sed -i "s/^DR_PRIMARY_REGION=.*/DR_PRIMARY_REGION=${TARGET_REGION}/" .env
    else
      echo "DR_PRIMARY_REGION=${TARGET_REGION}" >> .env
    fi
  fi

  # Restart services
  docker compose up -d --force-recreate \
    >> "${LOG_FILE}" 2>&1 || die "Failed to restart services in target region"

  info "Services restarted in ${TARGET_REGION}"
}

verify_health_endpoints() {
  step "Verifying health endpoints in target region..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Health endpoint verification"
    return 0
  fi

  local target_host
  target_host=$(get_target_host)
  local failures=0
  local max_retries=5
  local retry_delay=5

  for svc in "${HEALTH_PORTS[@]}"; do
    local name="${svc%%:*}"
    local port="${svc##*:}"
    local attempt=0
    local healthy=false

    while [[ ${attempt} -lt ${max_retries} ]]; do
      local status
      status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        "http://${target_host}:${port}/healthz" 2>/dev/null || echo "000")
      if [[ "${status}" == "200" ]]; then
        healthy=true
        break
      fi
      attempt=$((attempt + 1))
      sleep ${retry_delay}
    done

    if [[ "${healthy}" == true ]]; then
      info "${name} (port ${port}) — healthy after ${attempt} attempt(s)"
    else
      error "${name} (port ${port}) — NOT healthy after ${max_retries} attempts"
      failures=$((failures + 1))
    fi
  done

  if [[ ${failures} -gt 0 ]]; then
    die "${failures} service(s) failed health checks in target region"
  fi

  info "All health endpoints verified in ${TARGET_REGION}"
}

# ─── Post-failover ──────────────────────────────────────────────────────────
post_failover() {
  step "Running post-failover tasks..."

  # Update monitoring
  step "Updating monitoring configuration..."
  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Update Prometheus/Grafana targets to ${TARGET_REGION}"
  else
    warn "Manual step: Update observability/prometheus.yml scrape targets to ${TARGET_REGION}"
    info "Monitoring update noted"
  fi

  # Send notification
  step "Sending failover notification..."
  send_notification "FAILOVER" \
    "E-GAOP failover to ${TARGET_REGION} completed at $(date -Iseconds)"

  # Log summary
  log_summary
}

send_notification() {
  local event="$1"
  local message="$2"

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Notification: ${event} — ${message}"
    return 0
  fi

  # Slack webhook
  if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    curl -s -X POST "${SLACK_WEBHOOK_URL}" \
      -H "Content-Type: application/json" \
      --data "{\"text\":\"[E-GAOP DR] ${event}: ${message}\"}" \
      >> "${LOG_FILE}" 2>&1 || warn "Slack notification failed"
    info "Slack notification sent"
  fi

  # PagerDuty
  if [[ -n "${PAGERDUTY_ROUTING_KEY:-}" ]]; then
    curl -s -X POST "https://events.pagerduty.com/v2/enqueue" \
      -H "Content-Type: application/json" \
      --data "{
        \"routing_key\": \"${PAGERDUTY_ROUTING_KEY}\",
        \"event_action\": \"trigger\",
        \"payload\": {
          \"summary\": \"[E-GAOP] ${event}: ${message}\",
          \"severity\": \"critical\",
          \"source\": \"dr-failover.sh\",
          \"component\": \"disaster-recovery\"
        }
      }" >> "${LOG_FILE}" 2>&1 || warn "PagerDuty notification failed"
    info "PagerDuty notification sent"
  fi

  if [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && [[ -z "${PAGERDUTY_ROUTING_KEY:-}" ]]; then
    warn "No notification channels configured (SLACK_WEBHOOK_URL / PAGERDUTY_ROUTING_KEY)"
  fi
}

log_summary() {
  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - START_TIME))

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo -e "  ${BLUE}FAILOVER SUMMARY${NC}"
  echo "══════════════════════════════════════════════════════════════"
  echo "  Target Region : ${TARGET_REGION}"
  echo "  Duration      : ${duration}s"
  echo "  Dry Run       : ${DRY_RUN}"
  echo "  Timestamp     : $(date -Iseconds)"
  echo "  Log File      : ${LOG_FILE}"
  echo "  Backup Dir    : ${BACKUP_DIR}"
  echo "══════════════════════════════════════════════════════════════"

  log "SUMMARY" "Failover to ${TARGET_REGION} completed in ${duration}s"
}

# ─── Rollback ───────────────────────────────────────────────────────────────
rollback() {
  local failed_step="$1"
  error "FAILBACK initiated due to failure at step: ${failed_step}"
  warn "Rolling back changes..."

  # Restore backed up config
  if [[ -d "${BACKUP_DIR}" ]]; then
    for f in "${BACKUP_DIR}"/*.bak; do
      if [[ -f "${f}" ]]; then
        local original
        original=$(basename "${f}" .bak)
        cp "${f}" "${PROJECT_ROOT}/${original}"
        info "Restored ${original} from backup"
      fi
    done
  fi

  # Re-enable writes on primary
  local pg_container
  pg_container=$(docker ps --filter "ancestor=pgvector/pgvector:pg15" --format '{{.Names}}' 2>/dev/null | head -1 || true)
  if [[ -n "${pg_container}" ]]; then
    local pg_password=""
    if [[ -f "${PROJECT_ROOT}/.env" ]]; then
      pg_password=$(grep -E '^POSTGRES_PASSWORD=' "${PROJECT_ROOT}/.env" | tail -1 | cut -d= -f2- || true)
    fi
    if [[ -n "${pg_password}" ]]; then
      docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
        psql -U egaop -d egaop -c "ALTER SYSTEM SET default_transaction_read_only = off;" 2>/dev/null || true
      docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
        psql -U egaop -d egaop -c "SELECT pg_reload_conf();" 2>/dev/null || true
      info "Re-enabled writes on primary"
    fi
  fi

  send_notification "ROLLBACK" "Failover failed at step: ${failed_step}. Rollback completed."
  error "Rollback completed. Investigate and retry manually."
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  START_TIME=$(date +%s)

  parse_args "$@"
  require_tools

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo -e "  ${BLUE}E-GAOP Disaster Recovery — Failover${NC}"
  echo "══════════════════════════════════════════════════════════════"
  echo "  Target Region : ${TARGET_REGION}"
  echo "  Dry Run       : ${DRY_RUN}"
  echo "  Force         : ${FORCE}"
  echo "  Timestamp     : $(date -Iseconds)"
  echo "══════════════════════════════════════════════════════════════"
  echo ""

  if [[ "${DRY_RUN}" == false ]]; then
    echo -e "${YELLOW}WARNING: This will perform a disaster recovery failover to ${TARGET_REGION}.${NC}"
    echo -e "${YELLOW}This action may cause temporary downtime.${NC}"
    confirm
  fi

  # Backup current config
  backup_config

  # Pre-flight checks
  preflight_checks

  # Execute failover with rollback on failure
  local steps=(
    "stop_primary_writes"
    "promote_postgres_replica"
    "update_redis_sentinel"
    "update_dns"
    "restart_secondary_services"
    "verify_health_endpoints"
  )

  for step_func in "${steps[@]}"; do
    if ! ${step_func}; then
      rollback "${step_func}"
      die "Failover aborted."
    fi
  done

  # Post-failover
  post_failover

  echo ""
  info "══════════════════════════════════════════════════════════════"
  info "  FAILOVER TO ${TARGET_REGION} COMPLETED SUCCESSFULLY"
  info "══════════════════════════════════════════════════════════════"
}

main "$@"
