#!/usr/bin/env bash
# =============================================================================
# Canary Deployment Orchestrator (The Kubernetes of AI Agents)
# =============================================================================
# Deploys a new version alongside the stable instance, validates health,
# monitors error rates, and promotes or rolls back automatically.
#
# Usage:
#   ./scripts/canary-deploy.sh <image-tag> [--weight=10] [--promote-on-success]
#   ./scripts/canary-deploy.sh <image-tag> --dry-run
#   ./scripts/canary-deploy.sh --help
#
# Environment variables:
#   CANARY_WARMUP_SEC    — Seconds to wait for canary to become healthy (default: 60)
#   CANARY_MONITOR_SEC   — Seconds to monitor error rate (default: 120)
#   CANARY_HEALTH_HOST   — Health check hostname (default: 127.0.0.1)
#   CANARY_HEALTH_PORT   — Canaray health port (default: 16051)
#   CANARY_REST_PORT     — Canary REST port (default: 3101)
#   CANARY_ERROR_THRESHOLD — Max error rate % before rollback (default: 1)
#   COMPOSE_FILES        — Compose file override (default: docker-compose.yml -f docker-compose.deploy.yml -f docker-compose.canary.yml)
# =============================================================================

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─── Defaults ────────────────────────────────────────────────────────────────
CANARY_WARMUP_SEC="${CANARY_WARMUP_SEC:-60}"
CANARY_MONITOR_SEC="${CANARY_MONITOR_SEC:-120}"
CANARY_HEALTH_HOST="${CANARY_HEALTH_HOST:-127.0.0.1}"
CANARY_HEALTH_PORT="${CANARY_HEALTH_PORT:-16051}"
CANARY_REST_PORT="${CANARY_REST_PORT:-3101}"
CANARY_ERROR_THRESHOLD="${CANARY_ERROR_THRESHOLD:-1}"
COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-.}"
DRY_RUN=false
PROMOTE_ON_SUCCESS=false
WEIGHT=10

# ─── Logging ─────────────────────────────────────────────────────────────────
log() {
  local level="$1"; shift
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$level" in
    INFO)  echo -e "${BLUE}[${ts}]${NC} ${GREEN}INFO${NC}  $*" ;;
    WARN)  echo -e "${BLUE}[${ts}]${NC} ${YELLOW}WARN${NC}  $*" ;;
    ERROR) echo -e "${BLUE}[${ts}]${NC} ${RED}ERROR${NC} $*" ;;
    STEP)  echo -e "${BLUE}[${ts}]${NC} ${GREEN}==>${NC}   $*" ;;
  esac
}

die() {
  log ERROR "$@"
  exit 1
}

# ─── Cleanup ─────────────────────────────────────────────────────────────────
CANARY_STOPPED=false
cleanup() {
  if [[ "$CANARY_STOPPED" == "false" && -n "${CANARY_TAG:-}" ]]; then
    log WARN "Script interrupted — cleaning up canary..."
    stop_canary || true
  fi
}
trap cleanup EXIT

# ─── Help ────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Canary Deployment Orchestrator for E-GAOP

Usage:
  $(basename "$0") <image-tag> [options]

Arguments:
  <image-tag>          Docker image tag to deploy as canary (required)

Options:
  --weight=<N>         Traffic weight percentage for canary (default: 10)
  --promote-on-success Automatically promote canary if healthy and low error rate
  --dry-run            Show what would happen without executing
  --help               Show this help message

Environment Variables:
  CANARY_WARMUP_SEC     Health check warmup time in seconds (default: 60)
  CANARY_MONITOR_SEC    Error monitoring window in seconds (default: 120)
  CANARY_HEALTH_HOST    Canary health check host (default: 127.0.0.1)
  CANARY_HEALTH_PORT    Canary health check port (default: 16051)
  CANARY_REST_PORT      Canary REST API port (default: 3101)
  CANARY_ERROR_THRESHOLD  Max error rate % before rollback (default: 1)

Examples:
  # Deploy canary and auto-promote if healthy
  ./scripts/canary-deploy.sh abc123def --promote-on-success

  # Dry run
  ./scripts/canary-deploy.sh abc123def --dry-run

  # Deploy with longer monitoring window
  CANARY_MONITOR_SEC=300 ./scripts/canary-deploy.sh abc123def
EOF
  exit 0
}

# ─── Parse Arguments ─────────────────────────────────────────────────────────
parse_args() {
  CANARY_TAG=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --promote-on-success)
        PROMOTE_ON_SUCCESS=true
        shift
        ;;
      --weight=*)
        WEIGHT="${1#*=}"
        shift
        ;;
      -*)
        die "Unknown option: $1 (use --help for usage)"
        ;;
      *)
        if [[ -z "$CANARY_TAG" ]]; then
          CANARY_TAG="$1"
        else
          die "Unexpected argument: $1"
        fi
        shift
        ;;
    esac
  done

  [[ -z "$CANARY_TAG" ]] && die "Image tag is required. Usage: $(basename "$0") <image-tag> [--help]"
}

# ─── Pre-flight Checks ──────────────────────────────────────────────────────
preflight() {
  log STEP "Running pre-flight checks..."

  if ! command -v docker &>/dev/null; then
    die "Docker is not installed or not in PATH"
  fi

  if ! docker info &>/dev/null; then
    die "Docker daemon is not running or current user lacks permissions"
  fi

  if ! docker compose version &>/dev/null; then
    die "Docker Compose v2 is not available"
  fi

  if [[ ! -f "${COMPOSE_PROJECT_DIR}/docker-compose.yml" ]]; then
    die "docker-compose.yml not found in ${COMPOSE_PROJECT_DIR}"
  fi

  log INFO "Pre-flight checks passed"
}

# ─── Docker Compose Helper ──────────────────────────────────────────────────
dc() {
  docker compose \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.yml" \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.deploy.yml" \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.canary.yml" \
    --profile canary \
    "$@"
}

# ─── Pull Canary Image ──────────────────────────────────────────────────────
pull_canary() {
  log STEP "Pulling canary image: ghcr.io/${IMAGE_NAMESPACE:-${GITHUB_REPOSITORY:-egaop}}/api-server:${CANARY_TAG}"

  local full_image="ghcr.io/${IMAGE_NAMESPACE:-${GITHUB_REPOSITORY:-egaop}}/api-server:${CANARY_TAG}"

  if [[ "$DRY_RUN" == "true" ]]; then
    log INFO "[DRY RUN] Would pull: ${full_image}"
    return 0
  fi

  if ! docker pull "$full_image"; then
    die "Failed to pull canary image: ${full_image}"
  fi

  log INFO "Canary image pulled successfully"
}

# ─── Start Canary ────────────────────────────────────────────────────────────
start_canary() {
  log STEP "Starting canary container alongside stable..."

  export CANARY_IMAGE_TAG="$CANARY_TAG"
  export CANARY_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ "$DRY_RUN" == "true" ]]; then
    log INFO "[DRY RUN] Would start canary with tag: ${CANARY_TAG}"
    log INFO "[DRY RUN] Would use ports: REST=${CANARY_REST_PORT}, Health=${CANARY_HEALTH_PORT}"
    return 0
  fi

  cd "$COMPOSE_PROJECT_DIR"
  dc up -d api-server-canary

  log INFO "Canary container started"
}

# ─── Stop Canary ─────────────────────────────────────────────────────────────
stop_canary() {
  log STEP "Stopping canary container..."

  if [[ "$DRY_RUN" == "true" ]]; then
    log INFO "[DRY RUN] Would stop canary container"
    return 0
  fi

  cd "$COMPOSE_PROJECT_DIR"
  dc down api-server-canary 2>/dev/null || true

  CANARY_STOPPED=true
  log INFO "Canary container stopped"
}

# ─── Health Check ────────────────────────────────────────────────────────────
health_check() {
  log STEP "Polling canary health endpoint for ${CANARY_WARMUP_SEC}s..."

  local url="http://${CANARY_HEALTH_HOST}:${CANARY_HEALTH_PORT}/healthz"
  local elapsed=0
  local interval=5

  if [[ "$DRY_RUN" == "true" ]]; then
    log INFO "[DRY RUN] Would poll: ${url}"
    log INFO "[DRY RUN] Would wait up to ${CANARY_WARMUP_SEC}s"
    return 0
  fi

  while [[ $elapsed -lt $CANARY_WARMUP_SEC ]]; do
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

    if [[ "$status" == "200" ]]; then
      log INFO "Canary is healthy (HTTP ${status}) after ${elapsed}s"
      return 0
    fi

    log INFO "Waiting... (attempt at ${elapsed}s, HTTP ${status})"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  log ERROR "Canary failed to become healthy within ${CANARY_WARMUP_SEC}s"
  return 1
}

# ─── Monitor Error Rate ─────────────────────────────────────────────────────
monitor_errors() {
  log STEP "Monitoring canary error rate for ${CANARY_MONITOR_SEC}s..."

  local url="http://${CANARY_HEALTH_HOST}:${CANARY_REST_PORT}/healthz"
  local elapsed=0
  local interval=10
  local total_requests=0
  local error_requests=0

  if [[ "$DRY_RUN" == "true" ]]; then
    log INFO "[DRY RUN] Would monitor errors at: ${url}"
    log INFO "[DRY RUN] Would monitor for ${CANARY_MONITOR_SEC}s, threshold: ${CANARY_ERROR_THRESHOLD}%"
    return 0
  fi

  while [[ $elapsed -lt $CANARY_MONITOR_SEC ]]; do
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
    total_requests=$((total_requests + 1))

    if [[ "$status" != "200" ]]; then
      error_requests=$((error_requests + 1))
    fi

    # Calculate error rate
    if [[ $total_requests -gt 0 ]]; then
      local error_rate
      error_rate=$(awk "BEGIN {printf \"%.1f\", ($error_requests / $total_requests) * 100}")
      log INFO "  Request ${total_requests}: HTTP ${status} | Error rate: ${error_rate}% (${error_requests}/${total_requests})"

      # Check threshold
      local exceeds
      exceeds=$(awk "BEGIN {print ($error_rate > $CANARY_ERROR_THRESHOLD) ? 1 : 0}")
      if [[ "$exceeds" == "1" && $total_requests -ge 5 ]]; then
        log ERROR "Error rate ${error_rate}% exceeds threshold ${CANARY_ERROR_THRESHOLD}%"
        return 1
      fi
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  if [[ $total_requests -eq 0 ]]; then
    log WARN "No requests were made during monitoring window"
    return 1
  fi

  local final_error_rate
  final_error_rate=$(awk "BEGIN {printf \"%.1f\", ($error_requests / $total_requests) * 100}")
  log INFO "Monitoring complete: ${final_error_rate}% error rate (${error_requests}/${total_requests} requests)"
  return 0
}

# ─── Promote Canary ─────────────────────────────────────────────────────────
promote_canary() {
  log STEP "Promoting canary to stable..."

  if [[ "$DRY_RUN" == "true" ]]; then
    log INFO "[DRY RUN] Would promote canary (tag: ${CANARY_TAG}) to stable"
    return 0
  fi

  bash "${COMPOSE_PROJECT_DIR}/scripts/canary-promote.sh" "$CANARY_TAG"
}

# ─── Rollback Canary ────────────────────────────────────────────────────────
rollback_canary() {
  log STEP "Rolling back canary..."

  if [[ "$DRY_RUN" == "true" ]]; then
    log INFO "[DRY RUN] Would rollback canary and keep stable"
    return 0
  fi

  bash "${COMPOSE_PROJECT_DIR}/scripts/canary-rollback.sh" "$CANARY_TAG"
}

# ─── Print Summary ───────────────────────────────────────────────────────────
print_summary() {
  local result="$1"
  local duration="$2"

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  if [[ "$result" == "success" ]]; then
    echo -e "  ${GREEN}CANARY DEPLOYMENT — SUCCESS${NC}"
  else
    echo -e "  ${RED}CANARY DEPLOYMENT — FAILED${NC}"
  fi
  echo "══════════════════════════════════════════════════════════════"
  echo "  Image tag:   ${CANARY_TAG}"
  echo "  Duration:    ${duration}s"
  echo "  Promoted:    $([ "$result" == "success" ] && echo "Yes" || echo "No (rolled back)")"
  echo "  Timestamp:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "══════════════════════════════════════════════════════════════"
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  local start_time
  start_time=$(date +%s)

  parse_args "$@"
  preflight

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  CANARY DEPLOYMENT — E-GAOP"
  echo "══════════════════════════════════════════════════════════════"
  echo "  Target image:  ghcr.io/.../api-server:${CANARY_TAG}"
  echo "  Warmup:        ${CANARY_WARMUP_SEC}s"
  echo "  Monitor:       ${CANARY_MONITOR_SEC}s"
  echo "  Threshold:     ${CANARY_ERROR_THRESHOLD}%"
  echo "  Dry run:       ${DRY_RUN}"
  echo "══════════════════════════════════════════════════════════════"
  echo ""

  # Step 1: Pull canary image
  pull_canary

  # Step 2: Start canary alongside stable
  start_canary
  CANARY_STOPPED=false

  # Step 3: Health check loop
  if ! health_check; then
    log ERROR "Canary is unhealthy — rolling back"
    rollback_canary
    local end_time
    end_time=$(date +%s)
    print_summary "failure" "$((end_time - start_time))"
    exit 1
  fi

  # Step 4: Monitor error rate
  if ! monitor_errors; then
    log ERROR "Canary error rate too high — rolling back"
    rollback_canary
    local end_time
    end_time=$(date +%s)
    print_summary "failure" "$((end_time - start_time))"
    exit 1
  fi

  # Step 5: Decide outcome
  if [[ "$PROMOTE_ON_SUCCESS" == "true" ]]; then
    log INFO "Canary healthy with acceptable error rate — promoting"
    promote_canary
    CANARY_STOPPED=true
    local end_time
    end_time=$(date +%s)
    print_summary "success" "$((end_time - start_time))"
  else
    log INFO "Canary is healthy and monitoring passed"
    log INFO "Run $(basename "$0") --promote-on-success or canary-promote.sh to promote"
    local end_time
    end_time=$(date +%s)
    print_summary "success" "$((end_time - start_time))"
  fi
}

main "$@"
