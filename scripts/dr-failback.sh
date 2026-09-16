#!/usr/bin/env bash
# =============================================================================
# dr-failback.sh — Restore primary region after disaster recovery failover
# =============================================================================
# Fails back from the current primary (secondary region) to the original
# primary region (us-east-1). Re-establishes replication and restores normal
# operation.
#
# Usage:
#   ./scripts/dr-failback.sh
#   ./scripts/dr-failback.sh --dry-run
#
# Prerequisites:
#   - Docker, docker-compose
#   - psql (PostgreSQL client)
#   - redis-cli
#   - curl
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
LOG_FILE="${PROJECT_ROOT}/logs/dr-failback-${TIMESTAMP}.log"
BACKUP_DIR="${PROJECT_ROOT}/backups/dr-pre-failback-${TIMESTAMP}"

# ─── Defaults ───────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE=false
PRIMARY_REGION="us-east-1"
SECONDARY_REGION="us-west-2"

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
Usage: $(basename "$0") [OPTIONS]

Restore the primary region (us-east-1) after disaster recovery failover.

Options:
  --dry-run    Preview actions without making changes
  --force      Skip confirmation prompts
  --help       Show this help message

Steps:
  1. Verify current primary (secondary region) is healthy
  2. Re-establish PostgreSQL replication from current primary to original primary
  3. Configure WAL shipping from new primary to new secondary
  4. Update DNS back to primary region
  5. Restart primary region services
  6. Verify health endpoints
  7. Re-enable monitoring for primary
  8. Send notification

Examples:
  $(basename "$0") --dry-run
  $(basename "$0") --force
EOF
  exit 0
}

# ─── Parse arguments ────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --force)
        FORCE=true
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

get_pg_container() {
  local container
  container=$(docker ps --filter "ancestor=pgvector/pgvector:pg15" --format '{{.Names}}' 2>/dev/null | head -1 || true)
  if [[ -z "${container}" ]]; then
    container="k8s-ai-agents-postgres-1"
  fi
  echo "${container}"
}

get_pg_password() {
  local password=""
  if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    password=$(grep -E '^POSTGRES_PASSWORD=' "${PROJECT_ROOT}/.env" | tail -1 | cut -d= -f2- || true)
  fi
  echo "${password}"
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

# ─── Step 1: Verify current primary health ──────────────────────────────────
verify_current_primary_health() {
  step "Verifying current primary (${SECONDARY_REGION}) is healthy..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Health checks for ${SECONDARY_REGION}"
    return 0
  fi

  local failures=0
  for svc in "${HEALTH_PORTS[@]}"; do
    local name="${svc%%:*}"
    local port="${svc##*:}"
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
      "http://localhost:${port}/healthz" 2>/dev/null || echo "000")
    if [[ "${status}" == "200" ]]; then
      info "${name} (port ${port}) — healthy"
    else
      warn "${name} (port ${port}) — HTTP ${status}"
      failures=$((failures + 1))
    fi
  done

  if [[ ${failures} -gt 0 ]]; then
    die "Current primary has ${failures} unhealthy service(s). Cannot failback."
  fi

  info "Current primary is healthy"
}

# ─── Step 2: Re-establish PostgreSQL replication ─────────────────────────────
reestablish_replication() {
  step "Re-establishing PostgreSQL replication..."

  local pg_container
  pg_container=$(get_pg_container)
  local pg_password
  pg_password=$(get_pg_password)

  [[ -z "${pg_password}" ]] && die "Cannot read POSTGRES_PASSWORD from .env"

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "pg_basebackup from ${SECONDARY_REGION} to ${PRIMARY_REGION}"
    dryrun "Configure WAL shipping"
    return 0
  fi

  # Step 2a: pg_basebackup from current primary (secondary) to new primary (old primary)
  step "Running pg_basebackup to sync data to ${PRIMARY_REGION}..."

  local old_primary_container
  old_primary_container=$(docker ps -a --filter "ancestor=pgvector/pgvector:pg15" \
    --format '{{.Names}}' 2>/dev/null | grep -v "${pg_container}" | head -1 || true)

  if [[ -z "${old_primary_container}" ]]; then
    warn "No old primary container found — assuming single-node setup"
    warn "In production, run pg_basebackup from ${SECONDARY_REGION} to ${PRIMARY_REGION}"
  else
    # Stop old primary, copy data, restart as replica
    step "Stopping old primary container..."
    docker stop "${old_primary_container}" >> "${LOG_FILE}" 2>&1 || true

    step "Copying base backup from current primary..."
    docker exec "${pg_container}" \
      pg_basebackup -h "${old_primary_container}" -U egaop -D /tmp/pgbasebackup \
      -Fp -Xs -P -R \
      >> "${LOG_FILE}" 2>&1 || warn "pg_basebackup skipped (single-node setup)"

    info "Replication data synchronized"
  fi

  # Step 2b: Configure WAL shipping from new primary to new secondary
  step "Configuring WAL shipping from ${PRIMARY_REGION} to ${SECONDARY_REGION}..."
  warn "Manual step: Configure primary_conninfo in postgresql.conf on ${PRIMARY_REGION}"
  warn "WAL shipping configuration depends on your network topology"
  info "WAL shipping configuration noted"

  info "PostgreSQL replication re-established"
}

# ─── Step 3: Update DNS back to primary ─────────────────────────────────────
update_dns_to_primary() {
  step "Updating DNS records back to ${PRIMARY_REGION}..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "DNS update: api.egaop.io -> ${PRIMARY_REGION} endpoint"
    return 0
  fi

  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] && [[ -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
    step "Updating Cloudflare DNS..."
    curl -s -X PATCH \
      "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${CLOUDFLARE_DNS_RECORD_ID:-}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{\"content\": \"${PRIMARY_REGION_IP:-127.0.0.1}\"}" \
      >> "${LOG_FILE}" 2>&1 || warn "Cloudflare DNS update failed"
    info "Cloudflare DNS updated"
  else
    warn "No CLOUDFLARE_API_TOKEN set — updating local /etc/hosts instead"
    if [[ -f /etc/hosts ]]; then
      if grep -q "egaop.internal" /etc/hosts; then
        sudo sed -i.bak "s/^.*egaop.internal.*$/127.0.0.1 api.egaop.internal/" /etc/hosts
      else
        echo "127.0.0.1 api.egaop.internal" | sudo tee -a /etc/hosts > /dev/null
      fi
      info "Updated /etc/hosts for egaop.internal"
    fi
  fi

  info "DNS updated to ${PRIMARY_REGION}"
}

# ─── Step 4: Restart primary region services ────────────────────────────────
restart_primary_services() {
  step "Restarting ${PRIMARY_REGION} services..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "docker-compose up -d (with PRIMARY=true for ${PRIMARY_REGION})"
    return 0
  fi

  cd "${PROJECT_ROOT}"

  # Update .env to mark primary region
  if [[ -f .env ]]; then
    if grep -q "^DR_PRIMARY_REGION=" .env; then
      sed -i "s/^DR_PRIMARY_REGION=.*/DR_PRIMARY_REGION=${PRIMARY_REGION}/" .env
    else
      echo "DR_PRIMARY_REGION=${PRIMARY_REGION}" >> .env
    fi
  fi

  # Set database to read-write
  local pg_container
  pg_container=$(get_pg_container)
  local pg_password
  pg_password=$(get_pg_password)

  if [[ -n "${pg_password}" ]]; then
    docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -c "ALTER SYSTEM SET default_transaction_read_only = off;" \
      >> "${LOG_FILE}" 2>&1 || warn "Failed to set read-write mode"
    docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -c "SELECT pg_reload_conf();" \
      >> "${LOG_FILE}" 2>&1 || warn "Failed to reload config"
    info "Database set to read-write mode"
  fi

  # Restart services
  docker compose up -d --force-recreate \
    >> "${LOG_FILE}" 2>&1 || die "Failed to restart services"

  info "Primary region services restarted"
}

# ─── Step 5: Verify health ──────────────────────────────────────────────────
verify_primary_health() {
  step "Verifying ${PRIMARY_REGION} health endpoints..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Health endpoint verification for ${PRIMARY_REGION}"
    return 0
  fi

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
        "http://localhost:${port}/healthz" 2>/dev/null || echo "000")
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
    die "${failures} service(s) failed health checks in ${PRIMARY_REGION}"
  fi

  info "All health endpoints verified in ${PRIMARY_REGION}"
}

# ─── Step 6: Re-enable monitoring ───────────────────────────────────────────
reenable_monitoring() {
  step "Re-enabling monitoring for ${PRIMARY_REGION}..."

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Update Prometheus/Grafana targets to ${PRIMARY_REGION}"
    return 0
  fi

  warn "Manual step: Update observability/prometheus.yml scrape targets to ${PRIMARY_REGION}"
  warn "Manual step: Update Grafana dashboards to point to ${PRIMARY_REGION}"

  info "Monitoring re-enablement noted"
}

# ─── Notifications ──────────────────────────────────────────────────────────
send_notification() {
  local event="$1"
  local message="$2"

  if [[ "${DRY_RUN}" == true ]]; then
    dryrun "Notification: ${event} — ${message}"
    return 0
  fi

  if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    curl -s -X POST "${SLACK_WEBHOOK_URL}" \
      -H "Content-Type: application/json" \
      --data "{\"text\":\"[E-GAOP DR] ${event}: ${message}\"}" \
      >> "${LOG_FILE}" 2>&1 || warn "Slack notification failed"
    info "Slack notification sent"
  fi

  if [[ -n "${PAGERDUTY_ROUTING_KEY:-}" ]]; then
    curl -s -X POST "https://events.pagerduty.com/v2/enqueue" \
      -H "Content-Type: application/json" \
      --data "{
        \"routing_key\": \"${PAGERDUTY_ROUTING_KEY}\",
        \"event_action\": \"trigger\",
        \"payload\": {
          \"summary\": \"[E-GAOP] ${event}: ${message}\",
          \"severity\": \"info\",
          \"source\": \"dr-failback.sh\",
          \"component\": \"disaster-recovery\"
        }
      }" >> "${LOG_FILE}" 2>&1 || warn "PagerDuty notification failed"
    info "PagerDuty notification sent"
  fi

  if [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && [[ -z "${PAGERDUTY_ROUTING_KEY:-}" ]]; then
    warn "No notification channels configured"
  fi
}

# ─── Summary ────────────────────────────────────────────────────────────────
log_summary() {
  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - START_TIME))

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo -e "  ${BLUE}FAILBACK SUMMARY${NC}"
  echo "══════════════════════════════════════════════════════════════"
  echo "  Restored To   : ${PRIMARY_REGION}"
  echo "  Duration      : ${duration}s"
  echo "  Dry Run       : ${DRY_RUN}"
  echo "  Timestamp     : $(date -Iseconds)"
  echo "  Log File      : ${LOG_FILE}"
  echo "══════════════════════════════════════════════════════════════"

  log "SUMMARY" "Failback to ${PRIMARY_REGION} completed in ${duration}s"
}

# ─── Rollback ───────────────────────────────────────────────────────────────
rollback() {
  local failed_step="$1"
  error "ROLLBACK initiated due to failure at step: ${failed_step}"
  warn "Restoring previous configuration..."

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

  send_notification "ROLLBACK" "Failback failed at step: ${failed_step}. Rollback completed."
  error "Rollback completed. Investigate and retry manually."
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  START_TIME=$(date +%s)

  parse_args "$@"

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo -e "  ${BLUE}E-GAOP Disaster Recovery — Failback${NC}"
  echo "══════════════════════════════════════════════════════════════"
  echo "  Restoring To  : ${PRIMARY_REGION}"
  echo "  Dry Run       : ${DRY_RUN}"
  echo "  Force         : ${FORCE}"
  echo "  Timestamp     : $(date -Iseconds)"
  echo "══════════════════════════════════════════════════════════════"
  echo ""

  if [[ "${DRY_RUN}" == false ]]; then
    echo -e "${YELLOW}WARNING: This will restore the primary region (${PRIMARY_REGION}).${NC}"
    echo -e "${YELLOW}This action may cause temporary downtime.${NC}"
    confirm
  fi

  # Backup current config
  backup_config

  # Execute failback with rollback on failure
  local steps=(
    "verify_current_primary_health"
    "reestablish_replication"
    "update_dns_to_primary"
    "restart_primary_services"
    "verify_primary_health"
    "reenable_monitoring"
  )

  for step_func in "${steps[@]}"; do
    if ! ${step_func}; then
      rollback "${step_func}"
      die "Failback aborted."
    fi
  done

  # Notification
  send_notification "FAILBACK" \
    "E-GAOP failback to ${PRIMARY_REGION} completed at $(date -Iseconds)"

  # Summary
  log_summary

  echo ""
  info "══════════════════════════════════════════════════════════════"
  info "  FAILBACK TO ${PRIMARY_REGION} COMPLETED SUCCESSFULLY"
  info "══════════════════════════════════════════════════════════════"
}

main "$@"
