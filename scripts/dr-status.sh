#!/usr/bin/env bash
# =============================================================================
# dr-status.sh — Disaster recovery status overview for E-GAOP
# =============================================================================
# Displays a comprehensive status overview of the DR setup including
# service health, replication lag, Redis status, DNS configuration,
# last failover/failback events, and backup recency.
#
# Usage:
#   ./scripts/dr-status.sh
#   ./scripts/dr-status.sh --json
# =============================================================================

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Script metadata ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# ─── Defaults ───────────────────────────────────────────────────────────────
JSON_OUTPUT=false

# Health endpoints
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

# ─── Help ───────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Display disaster recovery status overview for E-GAOP.

Options:
  --json    Output results as JSON
  --help    Show this help message

Displays:
  1. Primary region status (services, DB replication, Redis)
  2. Secondary region status
  3. DNS configuration
  4. Last failover/failback event
  5. Backup recency

Examples:
  $(basename "$0")
  $(basename "$0") --json
EOF
  exit 0
}

# ─── Parse arguments ────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)
        JSON_OUTPUT=true
        shift
        ;;
      --help|-h)
        usage
        ;;
      *)
        echo "Unknown option: $1 (use --help for usage)" >&2
        exit 1
        ;;
    esac
  done
}

# ─── Helpers ─────────────────────────────────────────────────────────────────
get_pg_container() {
  docker ps --filter "ancestor=pgvector/pgvector:pg15" --format '{{.Names}}' 2>/dev/null | head -1 || \
    echo "k8s-ai-agents-postgres-1"
}

get_pg_password() {
  local password=""
  if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    password=$(grep -E '^POSTGRES_PASSWORD=' "${PROJECT_ROOT}/.env" | tail -1 | cut -d= -f2- || true)
  fi
  echo "${password}"
}

check_health() {
  local host="$1"
  local port="$2"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
    "http://${host}:${port}/healthz" 2>/dev/null || echo "000")
  echo "${status}"
}

# ─── Primary region status ─────────────────────────────────────────────────
get_primary_region_status() {
  local host="localhost"
  local healthy=0
  local total=${#HEALTH_PORTS[@]}
  local services=()

  for svc in "${HEALTH_PORTS[@]}"; do
    local name="${svc%%:*}"
    local port="${svc##*:}"
    local status
    status=$(check_health "${host}" "${port}")
    local is_healthy="false"
    if [[ "${status}" == "200" ]]; then
      is_healthy="true"
      healthy=$((healthy + 1))
    fi
    services+=("{\"name\":\"${name}\",\"port\":${port},\"status\":\"${status}\",\"healthy\":${is_healthy}}")
  done

  # PostgreSQL status
  local pg_status="unknown"
  local pg_replication_lag="N/A"
  local pg_role="unknown"
  local pg_container
  pg_container=$(get_pg_container)
  local pg_password
  pg_password=$(get_pg_password)

  if [[ -n "${pg_password}" ]] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "${pg_container}"; then
    pg_status="running"
    pg_role=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c "SELECT CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END;" \
      2>/dev/null || echo "unknown")

    pg_replication_lag=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c \
      "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int, 0);" \
      2>/dev/null || echo "N/A")
  fi

  # Redis status
  local redis_status="unknown"
  local redis_role="unknown"
  if command -v redis-cli &>/dev/null; then
    local redis_ping
    redis_ping=$(redis-cli -h redis -p 6379 ping 2>/dev/null || echo "FAILED")
    if [[ "${redis_ping}" == "PONG" ]]; then
      redis_status="connected"
      redis_role=$(redis-cli -h redis -p 6379 INFO replication 2>/dev/null | grep "role:" | cut -d: -f2 | tr -d '\r' || echo "unknown")
    else
      redis_status="disconnected"
    fi
  else
    redis_status="unavailable"
  fi

  echo "{
    \"region\": \"us-east-1\",
    \"role\": \"primary\",
    \"services\": {
      \"healthy\": ${healthy},
      \"total\": ${total},
      \"details\": [$(IFS=,; echo "${services[*]}")]
    },
    \"postgres\": {
      \"status\": \"${pg_status}\",
      \"role\": \"${pg_role}\",
      \"replication_lag\": \"${pg_replication_lag}\"
    },
    \"redis\": {
      \"status\": \"${redis_status}\",
      \"role\": \"${redis_role}\"
    }
  }"
}

# ─── DNS configuration ──────────────────────────────────────────────────────
get_dns_status() {
  local dns_records=()

  local domains=("api.egaop.internal" "redis.egaop.internal" "postgres.egaop.internal")
  for domain in "${domains[@]}"; do
    local resolved=""
    if command -v dig &>/dev/null; then
      resolved=$(dig +short +timeout=3 "${domain}" A 2>/dev/null | head -1 || true)
    elif command -v nslookup &>/dev/null; then
      resolved=$(nslookup "${domain}" 2>/dev/null | grep "Address:" | tail -1 | awk '{print $2}' || true)
    fi

    if [[ -n "${resolved}" ]]; then
      dns_records+=("{\"domain\":\"${domain}\",\"resolved\":\"${resolved}\",\"status\":\"ok\"}")
    else
      dns_records+=("{\"domain\":\"${domain}\",\"resolved\":\"N/A\",\"status\":\"unresolved\"}")
    fi
  done

  echo "{
    \"records\": [$(IFS=,; echo "${dns_records[*]}")]
  }"
}

# ─── Last DR events ─────────────────────────────────────────────────────────
get_last_dr_events() {
  local events=()

  # Look for DR event logs
  local dr_logs
  dr_logs=$(find "${PROJECT_ROOT}/logs" -name "dr-*.log" -type f 2>/dev/null | sort -r | head -5 || true)

  if [[ -n "${dr_logs}" ]]; then
    while IFS= read -r log_file; do
      local event_type
      local event_time
      local event_result

      event_type=$(basename "${log_file}" | sed 's/dr-//; s/-[0-9]*_[0-9]*\.log//' || echo "unknown")
      event_time=$(stat -c %Y "${log_file}" 2>/dev/null || stat -f %m "${log_file}" 2>/dev/null || echo "0")
      event_result=$(grep -o "COMPLETED\|FAILED\|ABORTED" "${log_file}" 2>/dev/null | tail -1 || echo "unknown")

      local human_time
      human_time=$(date -d "@${event_time}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || \
        date -r "${event_time}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "unknown")

      events+=("{\"type\":\"${event_type}\",\"time\":\"${human_time}\",\"result\":\"${event_result}\"}")
    done <<< "${dr_logs}"
  fi

  if [[ ${#events[@]} -eq 0 ]]; then
    events+=("{\"type\":\"none\",\"time\":\"N/A\",\"result\":\"N/A\"}")
  fi

  echo "{
    \"events\": [$(IFS=,; echo "${events[*]}")]
  }"
}

# ─── Backup status ──────────────────────────────────────────────────────────
get_backup_status() {
  local backup_dir="${PROJECT_ROOT}/backups"
  local latest_backup="N/A"
  local backup_count=0
  local backup_age="N/A"

  if [[ -d "${backup_dir}" ]]; then
    local latest_file
    latest_file=$(find "${backup_dir}" -name "*.dump.gz" -o -name "*.dump" 2>/dev/null | sort -r | head -1 || true)

    if [[ -n "${latest_file}" ]]; then
      latest_backup=$(basename "${latest_file}")
      local file_time
      file_time=$(stat -c %Y "${latest_file}" 2>/dev/null || stat -f %m "${latest_file}" 2>/dev/null || echo "0")
      local now_time
      now_time=$(date +%s)
      local age_seconds=$((now_time - file_time))

      if [[ ${age_seconds} -lt 3600 ]]; then
        backup_age="$((age_seconds / 60)) minutes ago"
      elif [[ ${age_seconds} -lt 86400 ]]; then
        backup_age="$((age_seconds / 3600)) hours ago"
      else
        backup_age="$((age_seconds / 86400)) days ago"
      fi
    fi

    backup_count=$(find "${backup_dir}" -name "*.dump.gz" -o -name "*.dump" 2>/dev/null | wc -l || echo "0")
  fi

  echo "{
    \"latest\": \"${latest_backup}\",
    \"age\": \"${backup_age}\",
    \"count\": ${backup_count},
    \"directory\": \"${backup_dir}\"
  }"
}

# ─── Output results ─────────────────────────────────────────────────────────
output_results() {
  if [[ "${JSON_OUTPUT}" == true ]]; then
    local primary_status
    primary_status=$(get_primary_region_status)
    local dns_status
    dns_status=$(get_dns_status)
    local dr_events
    dr_events=$(get_last_dr_events)
    local backup_status
    backup_status=$(get_backup_status)

    echo "{
  \"timestamp\": \"$(date -Iseconds)\",
  \"primary_region\": ${primary_status},
  \"dns\": ${dns_status},
  \"dr_events\": ${dr_events},
  \"backup\": ${backup_status}
}"
  else
    echo ""
    echo "══════════════════════════════════════════════════════════════"
    echo -e "  ${BOLD}E-GAOP DISASTER RECOVERY STATUS${NC}"
    echo "══════════════════════════════════════════════════════════════"
    echo "  Timestamp : $(date -Iseconds)"
    echo ""

    # Primary region
    echo -e "  ${BOLD}${BLUE}Primary Region (us-east-1)${NC}"
    echo "  ─────────────────────────────────────────────────────────"

    local primary_healthy=0
    local primary_total=${#HEALTH_PORTS[@]}

    for svc in "${HEALTH_PORTS[@]}"; do
      local name="${svc%%:*}"
      local port="${svc##*:}"
      local status
      status=$(check_health "localhost" "${port}")

      if [[ "${status}" == "200" ]]; then
        echo -e "    ${GREEN}✓${NC} ${name} (port ${port})"
        primary_healthy=$((primary_healthy + 1))
      else
        echo -e "    ${RED}✗${NC} ${name} (port ${port}) — HTTP ${status}"
      fi
    done
    echo ""

    # PostgreSQL
    local pg_container
    pg_container=$(get_pg_container)
    local pg_password
    pg_password=$(get_pg_password)

    if [[ -n "${pg_password}" ]] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "${pg_container}"; then
      local pg_role
      pg_role=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
        psql -U egaop -d egaop -t -A -c "SELECT CASE WHEN pg_is_in_recovery() THEN 'REPLICA' ELSE 'PRIMARY' END;" \
        2>/dev/null || echo "UNKNOWN")

      local pg_lag
      pg_lag=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
        psql -U egaop -d egaop -t -A -c \
        "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int, 0);" \
        2>/dev/null || echo "N/A")

      echo -e "    ${GREEN}✓${NC} PostgreSQL — ${pg_role} (replication lag: ${pg_lag}s)"
    else
      echo -e "    ${RED}✗${NC} PostgreSQL — not running"
    fi

    # Redis
    if command -v redis-cli &>/dev/null; then
      local redis_ping
      redis_ping=$(redis-cli -h redis -p 6379 ping 2>/dev/null || echo "FAILED")
      if [[ "${redis_ping}" == "PONG" ]]; then
        local redis_role
        redis_role=$(redis-cli -h redis -p 6379 INFO replication 2>/dev/null | grep "role:" | cut -d: -f2 | tr -d '\r' || echo "unknown")
        echo -e "    ${GREEN}✓${NC} Redis — connected (${redis_role})"
      else
        echo -e "    ${RED}✗${NC} Redis — disconnected"
      fi
    else
      echo -e "    ${YELLOW}⚠${NC} Redis — redis-cli not available"
    fi

    echo ""
    echo -e "  ${BOLD}Service Health: ${primary_healthy}/${primary_total} healthy${NC}"
    echo ""

    # DNS
    echo -e "  ${BOLD}${BLUE}DNS Configuration${NC}"
    echo "  ─────────────────────────────────────────────────────────"

    local domains=("api.egaop.internal" "redis.egaop.internal" "postgres.egaop.internal")
    for domain in "${domains[@]}"; do
      local resolved=""
      if command -v dig &>/dev/null; then
        resolved=$(dig +short +timeout=3 "${domain}" A 2>/dev/null | head -1 || true)
      elif command -v nslookup &>/dev/null; then
        resolved=$(nslookup "${domain}" 2>/dev/null | grep "Address:" | tail -1 | awk '{print $2}' || true)
      fi

      if [[ -n "${resolved}" ]]; then
        echo -e "    ${GREEN}✓${NC} ${domain} → ${resolved}"
      else
        echo -e "    ${YELLOW}⚠${NC} ${domain} → unresolvable"
      fi
    done
    echo ""

    # Last DR events
    echo -e "  ${BOLD}${BLUE}Last DR Events${NC}"
    echo "  ─────────────────────────────────────────────────────────"

    local dr_logs
    dr_logs=$(find "${PROJECT_ROOT}/logs" -name "dr-*.log" -type f 2>/dev/null | sort -r | head -3 || true)

    if [[ -n "${dr_logs}" ]]; then
      while IFS= read -r log_file; do
        local event_type
        local event_result
        event_type=$(basename "${log_file}" | sed 's/dr-//; s/-[0-9]*_[0-9]*\.log//' || echo "unknown")
        event_result=$(grep -o "COMPLETED\|FAILED\|ABORTED" "${log_file}" 2>/dev/null | tail -1 || echo "unknown")
        local file_time
        file_time=$(stat -c %y "${log_file}" 2>/dev/null | cut -d. -f1 || \
          stat -f "%Sm" "${log_file}" 2>/dev/null || echo "unknown")

        local color="${GREEN}"
        [[ "${event_result}" == "FAILED" ]] && color="${RED}"
        [[ "${event_result}" == "ABORTED" ]] && color="${YELLOW}"

        echo -e "    ${color}${event_type}${NC} — ${event_result} (${file_time})"
      done <<< "${dr_logs}"
    else
      echo -e "    ${DIM}No DR events recorded${NC}"
    fi
    echo ""

    # Backup status
    echo -e "  ${BOLD}${BLUE}Backup Status${NC}"
    echo "  ─────────────────────────────────────────────────────────"

    local backup_dir="${PROJECT_ROOT}/backups"
    if [[ -d "${backup_dir}" ]]; then
      local backup_count
      backup_count=$(find "${backup_dir}" -name "*.dump.gz" -o -name "*.dump" 2>/dev/null | wc -l || echo "0")

      local latest_file
      latest_file=$(find "${backup_dir}" -name "*.dump.gz" -o -name "*.dump" 2>/dev/null | sort -r | head -1 || true)

      if [[ -n "${latest_file}" ]]; then
        local file_time
        file_time=$(stat -c %Y "${latest_file}" 2>/dev/null || stat -f %m "${latest_file}" 2>/dev/null || echo "0")
        local now_time
        now_time=$(date +%s)
        local age_seconds=$((now_time - file_time))
        local age_human

        if [[ ${age_seconds} -lt 3600 ]]; then
          age_human="$((age_seconds / 60)) minutes ago"
        elif [[ ${age_seconds} -lt 86400 ]]; then
          age_human="$((age_seconds / 3600)) hours ago"
        else
          age_human="$((age_seconds / 86400)) days ago"
        fi

        echo -e "    Latest  : $(basename "${latest_file}")"
        echo -e "    Age     : ${age_human}"
        echo -e "    Total   : ${backup_count} backup(s)"

        if [[ ${age_seconds} -gt 86400 ]]; then
          echo -e "    ${YELLOW}⚠ Warning: Latest backup is more than 1 day old${NC}"
        fi
      else
        echo -e "    ${YELLOW}No backups found${NC}"
      fi
    else
      echo -e "    ${YELLOW}Backup directory not found${NC}"
    fi

    echo ""
    echo "══════════════════════════════════════════════════════════════"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  output_results
}

main "$@"
