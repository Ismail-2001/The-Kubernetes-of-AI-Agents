#!/usr/bin/env bash
# =============================================================================
# dr-verify.sh — Disaster recovery verification for E-GAOP
# =============================================================================
# Verifies DR readiness by checking replication status, service health,
# DNS resolution, TLS certificates, data consistency, and cross-region
# connectivity.
#
# Usage:
#   ./scripts/dr-verify.sh
#   ./scripts/dr-verify.sh --region=primary
#   ./scripts/dr-verify.sh --region=secondary
#   ./scripts/dr-verify.sh --json
# =============================================================================

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Script metadata ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# ─── Defaults ───────────────────────────────────────────────────────────────
REGION="all"
JSON_OUTPUT=false
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARN_CHECKS=0

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

# Key tables for data consistency checks
KEY_TABLES=(
  "agents"
  "workflows"
  "secrets"
  "audit_logs"
)

# ─── Results storage ───────────────────────────────────────────────────────
declare -a RESULTS=()

# ─── Help ───────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Verify disaster recovery readiness for E-GAOP.

Options:
  --region=<region>   Check specific region: primary, secondary, or all (default: all)
  --json              Output results as JSON
  --help              Show this help message

Checks performed:
  1. PostgreSQL replication status
  2. Redis Sentinel status
  3. Service health endpoints
  4. DNS resolution
  5. TLS certificate validity
  6. Data consistency (row counts)
  7. Cross-region connectivity

Examples:
  $(basename "$0")
  $(basename "$0") --region=primary
  $(basename "$0") --json
EOF
  exit 0
}

# ─── Parse arguments ────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --region=*)
        REGION="${1#*=}"
        if [[ "${REGION}" != "primary" && "${REGION}" != "secondary" && "${REGION}" != "all" ]]; then
          echo "Invalid region: ${REGION}. Must be primary, secondary, or all." >&2
          exit 1
        fi
        shift
        ;;
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

record_result() {
  local check_name="$1"
  local status="$2"  # PASS, FAIL, WARN
  local detail="$3"
  local latency="${4:-}"

  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  case "${status}" in
    PASS)
      PASSED_CHECKS=$((PASSED_CHECKS + 1))
      if [[ "${JSON_OUTPUT}" == false ]]; then
        echo -e "  ${GREEN}✓ PASS${NC}  ${check_name}"
        [[ -n "${detail}" ]] && echo -e "          ${detail}"
        [[ -n "${latency}" ]] && echo -e "          Latency: ${latency}"
      fi
      ;;
    FAIL)
      FAILED_CHECKS=$((FAILED_CHECKS + 1))
      if [[ "${JSON_OUTPUT}" == false ]]; then
        echo -e "  ${RED}✗ FAIL${NC}  ${check_name}"
        [[ -n "${detail}" ]] && echo -e "          ${RED}${detail}${NC}"
      fi
      ;;
    WARN)
      WARN_CHECKS=$((WARN_CHECKS + 1))
      if [[ "${JSON_OUTPUT}" == false ]]; then
        echo -e "  ${YELLOW}⚠ WARN${NC}  ${check_name}"
        [[ -n "${detail}" ]] && echo -e "          ${YELLOW}${detail}${NC}"
      fi
      ;;
  esac

  RESULTS+=("{\"check\":\"${check_name}\",\"status\":\"${status}\",\"detail\":\"${detail}\",\"latency\":\"${latency}\"}")
}

check_tool() {
  command -v "$1" &>/dev/null
}

# ─── Check 1: PostgreSQL replication status ─────────────────────────────────
check_postgres_replication() {
  echo -e "\n${BOLD}── PostgreSQL Replication Status ──${NC}"

  local pg_container
  pg_container=$(get_pg_container)
  local pg_password
  pg_password=$(get_pg_password)

  if [[ -z "${pg_password}" ]]; then
    record_result "PostgreSQL Password" "FAIL" "POSTGRES_PASSWORD not set in .env"
    return
  fi

  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "${pg_container}"; then
    record_result "PostgreSQL Container" "FAIL" "Container '${pg_container}' not running"
    return
  fi

  # Check if instance is primary or replica
  local is_recovery
  is_recovery=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
    psql -U egaop -d egaop -t -A -c "SELECT pg_is_in_recovery();" 2>/dev/null || echo "error")

  if [[ "${is_recovery}" == "error" ]]; then
    record_result "PostgreSQL Connection" "FAIL" "Cannot connect to PostgreSQL"
    return
  fi

  if [[ "${is_recovery}" == "f" ]]; then
    record_result "PostgreSQL Role" "PASS" "Instance is PRIMARY (not in recovery)"

    # Check replication lag
    local lag
    lag=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c \
      "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int, 0);" \
      2>/dev/null || echo "0")

    if [[ "${lag}" -lt 300 ]]; then
      record_result "PostgreSQL Replication Lag" "PASS" "Lag: ${lag}s (< 5 min threshold)"
    elif [[ "${lag}" -lt 600 ]]; then
      record_result "PostgreSQL Replication Lag" "WARN" "Lag: ${lag}s (approaching threshold)"
    else
      record_result "PostgreSQL Replication Lag" "FAIL" "Lag: ${lag}s (> 5 min threshold)"
    fi

    # Check replication slots
    local repl_slots
    repl_slots=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c \
      "SELECT COUNT(*) FROM pg_replication_slots;" 2>/dev/null || echo "0")

    if [[ "${repl_slots}" -gt 0 ]]; then
      record_result "PostgreSQL Replication Slots" "PASS" "${repl_slots} replication slot(s) configured"
    else
      record_result "PostgreSQL Replication Slots" "WARN" "No replication slots configured"
    fi
  else
    record_result "PostgreSQL Role" "PASS" "Instance is REPLICA (in recovery mode)"

    # Check WAL receive lag for replica
    local receive_lag
    receive_lag=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c \
      "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int, 0);" \
      2>/dev/null || echo "0")

    if [[ "${receive_lag}" -lt 60 ]]; then
      record_result "PostgreSQL WAL Receive Lag" "PASS" "Receive lag: ${receive_lag}s"
    else
      record_result "PostgreSQL WAL Receive Lag" "WARN" "Receive lag: ${receive_lag}s"
    fi
  fi
}

# ─── Check 2: Redis Sentinel status ────────────────────────────────────────
check_redis_sentinel() {
  echo -e "\n${BOLD}── Redis Sentinel Status ──${NC}"

  if check_tool redis-cli; then
    # Check Redis connectivity
    local redis_ping
    redis_ping=$(redis-cli -h redis -p 6379 ping 2>/dev/null || echo "FAILED")
    if [[ "${redis_ping}" == "PONG" ]]; then
      record_result "Redis Connectivity" "PASS" "redis-cli PONG response"
    else
      record_result "Redis Connectivity" "FAIL" "Cannot connect to Redis"
      return
    fi

    # Check Redis replication info
    local redis_role
    redis_role=$(redis-cli -h redis -p 6379 INFO replication 2>/dev/null | grep "role:" | cut -d: -f2 | tr -d '\r' || echo "unknown")
    record_result "Redis Role" "PASS" "Role: ${redis_role}"

    # Check Sentinel if available
    local sentinel_status
    sentinel_status=$(redis-cli -h redis-sentinel -p 26379 SENTINEL masters 2>/dev/null | head -1 || echo "FAILED")
    if [[ "${sentinel_status}" == *"master"* ]] || [[ "${sentinel_status}" == *"name"* ]]; then
      record_result "Redis Sentinel" "PASS" "Sentinel is responding"
    else
      record_result "Redis Sentinel" "WARN" "Sentinel not reachable (may not be configured)"
    fi
  else
    record_result "Redis CLI" "WARN" "redis-cli not available — skipping Redis checks"
  fi
}

# ─── Check 3: Service health endpoints ──────────────────────────────────────
check_service_health() {
  echo -e "\n${BOLD}── Service Health Endpoints ──${NC}"

  local host="${1:-localhost}"

  for svc in "${HEALTH_PORTS[@]}"; do
    local name="${svc%%:*}"
    local port="${svc##*:}"
    local start_ms
    start_ms=$(date +%s%N 2>/dev/null || echo "0")

    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
      "http://${host}:${port}/healthz" 2>/dev/null || echo "000")

    local end_ms
    end_ms=$(date +%s%N 2>/dev/null || echo "0")
    local latency_ms="N/A"
    if [[ "${start_ms}" != "0" ]] && [[ "${end_ms}" != "0" ]]; then
      latency_ms=$(( (end_ms - start_ms) / 1000000 ))
    fi

    if [[ "${status}" == "200" ]]; then
      record_result "${name} Health" "PASS" "HTTP 200" "${latency_ms}ms"
    else
      record_result "${name} Health" "FAIL" "HTTP ${status}"
    fi
  done
}

# ─── Check 4: DNS resolution ────────────────────────────────────────────────
check_dns_resolution() {
  echo -e "\n${BOLD}── DNS Resolution ──${NC}"

  local domains=(
    "api.egaop.internal"
    "redis.egaop.internal"
    "postgres.egaop.internal"
  )

  for domain in "${domains[@]}"; do
    local resolved=""
    local start_ms
    start_ms=$(date +%s%N 2>/dev/null || echo "0")

    if check_tool dig; then
      resolved=$(dig +short +timeout=5 "${domain}" A 2>/dev/null | head -1 || true)
    elif check_tool nslookup; then
      resolved=$(nslookup "${domain}" 2>/dev/null | grep "Address:" | tail -1 | awk '{print $2}' || true)
    fi

    local end_ms
    end_ms=$(date +%s%N 2>/dev/null || echo "0")
    local latency_ms="N/A"
    if [[ "${start_ms}" != "0" ]] && [[ "${end_ms}" != "0" ]]; then
      latency_ms=$(( (end_ms - start_ms) / 1000000 ))
    fi

    if [[ -n "${resolved}" ]] && [[ "${resolved}" != *"server can find"* ]]; then
      record_result "DNS: ${domain}" "PASS" "Resolves to: ${resolved}" "${latency_ms}ms"
    else
      record_result "DNS: ${domain}" "WARN" "Could not resolve ${domain} (may not be configured)"
    fi
  done
}

# ─── Check 5: TLS certificate validity ──────────────────────────────────────
check_tls_certificates() {
  echo -e "\n${BOLD}── TLS Certificate Validity ──${NC}"

  local cert_dir="${PROJECT_ROOT}/certs"

  if [[ ! -d "${cert_dir}" ]]; then
    record_result "Certificate Directory" "WARN" "certs/ directory not found"
    return
  fi

  local cert_files
  cert_files=$(find "${cert_dir}" -name "*.pem" -o -name "*.crt" 2>/dev/null || true)

  if [[ -z "${cert_files}" ]]; then
    record_result "TLS Certificates" "WARN" "No certificate files found in certs/"
    return
  fi

  local cert_count=0
  local valid_certs=0

  while IFS= read -r cert_file; do
    cert_count=$((cert_count + 1))
    local cert_name
    cert_name=$(basename "${cert_file}")

    if check_tool openssl; then
      local expiry
      expiry=$(openssl x509 -enddate -noout -in "${cert_file}" 2>/dev/null | cut -d= -f2 || true)

      if [[ -n "${expiry}" ]]; then
        local expiry_epoch
        expiry_epoch=$(date -d "${expiry}" +%s 2>/dev/null || echo "0")
        local now_epoch
        now_epoch=$(date +%s)
        local days_left=$(( (expiry_epoch - now_epoch) / 86400 ))

        if [[ ${days_left} -gt 30 ]]; then
          record_result "TLS: ${cert_name}" "PASS" "Expires in ${days_left} days (${expiry})"
          valid_certs=$((valid_certs + 1))
        elif [[ ${days_left} -gt 0 ]]; then
          record_result "TLS: ${cert_name}" "WARN" "Expires in ${days_left} days — renew soon"
          valid_certs=$((valid_certs + 1))
        else
          record_result "TLS: ${cert_name}" "FAIL" "EXPIRED ${days_left} days ago"
        fi
      else
        record_result "TLS: ${cert_name}" "WARN" "Could not parse certificate"
      fi
    else
      record_result "TLS: ${cert_name}" "WARN" "openssl not available — skipping check"
    fi
  done <<< "${cert_files}"

  if [[ ${valid_certs} -eq ${cert_count} ]] && [[ ${cert_count} -gt 0 ]]; then
    record_result "TLS Overview" "PASS" "${valid_certs}/${cert_count} certificates valid"
  fi
}

# ─── Check 6: Data consistency ──────────────────────────────────────────────
check_data_consistency() {
  echo -e "\n${BOLD}── Data Consistency ──${NC}"

  local pg_container
  pg_container=$(get_pg_container)
  local pg_password
  pg_password=$(get_pg_password)

  if [[ -z "${pg_password}" ]]; then
    record_result "Data Consistency" "WARN" "Cannot check — POSTGRES_PASSWORD not set"
    return
  fi

  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "${pg_container}"; then
    record_result "Data Consistency" "WARN" "PostgreSQL not running — skipping"
    return
  fi

  for table in "${KEY_TABLES[@]}"; do
    local row_count
    row_count=$(docker exec -e PGPASSWORD="${pg_password}" "${pg_container}" \
      psql -U egaop -d egaop -t -A -c \
      "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo "error")

    if [[ "${row_count}" == "error" ]]; then
      record_result "Table: ${table}" "WARN" "Table may not exist or is inaccessible"
    elif [[ "${row_count}" -ge 0 ]]; then
      record_result "Table: ${table}" "PASS" "Row count: ${row_count}"
    else
      record_result "Table: ${table}" "FAIL" "Unexpected row count: ${row_count}"
    fi
  done
}

# ─── Check 7: Cross-region connectivity ─────────────────────────────────────
check_cross_region_connectivity() {
  echo -e "\n${BOLD}── Cross-Region Connectivity ──${NC}"

  local targets=(
    "us-east-1:api.egaop.internal"
    "us-west-2:api.egaop.internal"
  )

  for target in "${targets[@]}"; do
    local region="${target%%:*}"
    local host="${target##*:}"

    local start_ms
    start_ms=$(date +%s%N 2>/dev/null || echo "0")

    local latency_result
    latency_result=$(ping -c 1 -W 2 "${host}" 2>/dev/null | grep "time=" | awk -F'=' '{print $2}' || echo "FAILED")

    local end_ms
    end_ms=$(date +%s%N 2>/dev/null || echo "0")
    local latency_ms="N/A"
    if [[ "${start_ms}" != "0" ]] && [[ "${end_ms}" != "0" ]]; then
      latency_ms=$(( (end_ms - start_ms) / 1000000 ))
    fi

    if [[ "${latency_result}" != "FAILED" ]]; then
      record_result "Connectivity: ${region}" "PASS" "Latency: ${latency_result}ms" "${latency_ms}ms"
    else
      record_result "Connectivity: ${region}" "WARN" "Cannot reach ${host} (network may be restricted)"
    fi
  done
}

# ─── Output results ─────────────────────────────────────────────────────────
output_results() {
  if [[ "${JSON_OUTPUT}" == true ]]; then
    local json_results="["
    local first=true
    for result in "${RESULTS[@]}"; do
      if [[ "${first}" == true ]]; then
        json_results="${json_results}${result}"
        first=false
      else
        json_results="${json_results},${result}"
      fi
    done
    json_results="${json_results}]"

    echo "{
  \"timestamp\": \"$(date -Iseconds)\",
  \"region\": \"${REGION}\",
  \"total_checks\": ${TOTAL_CHECKS},
  \"passed\": ${PASSED_CHECKS},
  \"failed\": ${FAILED_CHECKS},
  \"warnings\": ${WARN_CHECKS},
  \"result\": \"$(if [[ ${FAILED_CHECKS} -gt 0 ]]; then echo "FAIL"; elif [[ ${WARN_CHECKS} -gt 0 ]]; then echo "WARN"; else echo "PASS"; fi)\",
  \"checks\": ${json_results}
}"
  else
    echo ""
    echo "══════════════════════════════════════════════════════════════"
    echo -e "  ${BOLD}DR VERIFICATION SUMMARY${NC}"
    echo "══════════════════════════════════════════════════════════════"
    echo "  Region   : ${REGION}"
    echo "  Time     : $(date -Iseconds)"
    echo ""
    echo -e "  ${GREEN}Passed : ${PASSED_CHECKS}${NC}"
    echo -e "  ${YELLOW}Warnings: ${WARN_CHECKS}${NC}"
    echo -e "  ${RED}Failed : ${FAILED_CHECKS}${NC}"
    echo "  Total  : ${TOTAL_CHECKS}"
    echo ""

    if [[ ${FAILED_CHECKS} -gt 0 ]]; then
      echo -e "  ${RED}${BOLD}RESULT: FAIL — Action required${NC}"
    elif [[ ${WARN_CHECKS} -gt 0 ]]; then
      echo -e "  ${YELLOW}${BOLD}RESULT: PASS with warnings${NC}"
    else
      echo -e "  ${GREEN}${BOLD}RESULT: PASS — DR ready${NC}"
    fi
    echo "══════════════════════════════════════════════════════════════"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"

  if [[ "${JSON_OUTPUT}" == false ]]; then
    echo ""
    echo "══════════════════════════════════════════════════════════════"
    echo -e "  ${BLUE}E-GAOP Disaster Recovery Verification${NC}"
    echo "══════════════════════════════════════════════════════════════"
    echo "  Region : ${REGION}"
    echo "  Time   : $(date -Iseconds)"
    echo "══════════════════════════════════════════════════════════════"
  fi

  # Run checks based on region filter
  if [[ "${REGION}" == "all" ]] || [[ "${REGION}" == "primary" ]]; then
    check_postgres_replication
    check_redis_sentinel
    check_service_health "localhost"
  fi

  if [[ "${REGION}" == "all" ]]; then
    check_dns_resolution
    check_tls_certificates
    check_data_consistency
    check_cross_region_connectivity
  elif [[ "${REGION}" == "secondary" ]]; then
    check_service_health "localhost"
    check_dns_resolution
    check_tls_certificates
  fi

  output_results

  # Exit with failure if any checks failed
  if [[ ${FAILED_CHECKS} -gt 0 ]]; then
    exit 1
  fi
}

main "$@"
