#!/usr/bin/env bash
# =============================================================================
# Canary Rollback Script (The Kubernetes of AI Agents)
# =============================================================================
# Stops a canary instance and verifies the stable api-server is still healthy.
#
# Usage:
#   ./scripts/canary-rollback.sh [image-tag] [--help]
#
# What this does:
#   1. Stops the canary container
#   2. Verifies the stable api-server is still healthy
#   3. Logs the rollback event
# =============================================================================

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ─── Defaults ────────────────────────────────────────────────────────────────
COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-.}"
ROLLBACK_HEALTH_TIMEOUT="${ROLLBACK_HEALTH_TIMEOUT:-30}"
ROLLBACK_HEALTH_INTERVAL="${ROLLBACK_HEALTH_INTERVAL:-5}"
STABLE_HEALTH_HOST="${STABLE_HEALTH_HOST:-127.0.0.1}"
STABLE_HEALTH_PORT="${STABLE_HEALTH_PORT:-15051}"

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

# ─── Help ────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Canary Rollback Script for E-GAOP

Usage:
  $(basename "$0") [image-tag] [options]

Arguments:
  image-tag    The image tag of the canary being rolled back (optional, logged only)

Options:
  --help       Show this help message

Environment Variables:
  ROLLBACK_HEALTH_TIMEOUT   Seconds to wait for stable health check (default: 30)
  ROLLBACK_HEALTH_INTERVAL  Seconds between health check attempts (default: 5)
  STABLE_HEALTH_HOST        Stable health check host (default: 127.0.0.1)
  STABLE_HEALTH_PORT        Stable health check port (default: 15051)

What this does:
  1. Stops the canary container
  2. Verifies the stable api-server is still healthy
  3. Logs the rollback event

Examples:
  ./scripts/canary-rollback.sh
  ./scripts/canary-rollback.sh abc123def
EOF
  exit 0
}

# ─── Parse Arguments ─────────────────────────────────────────────────────────
ROLLBACK_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      ;;
    -*)
      die "Unknown option: $1 (use --help for usage)"
      ;;
    *)
      if [[ -z "$ROLLBACK_TAG" ]]; then
        ROLLBACK_TAG="$1"
      else
        die "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

# ─── Pre-flight ──────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  die "Docker is not installed or not in PATH"
fi

if ! docker info &>/dev/null; then
  die "Docker daemon is not running or current user lacks permissions"
fi

# ─── Docker Compose Helper ──────────────────────────────────────────────────
dc() {
  docker compose \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.yml" \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.deploy.yml" \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.canary.yml" \
    --profile canary \
    "$@"
}

# ─── Rollback Steps ─────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  CANARY ROLLBACK — E-GAOP"
echo "══════════════════════════════════════════════════════════════"
echo "  Rolling back canary: ${ROLLBACK_TAG:-unknown}"
echo "  Timestamp:           $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "══════════════════════════════════════════════════════════════"
echo ""

# Step 1: Stop canary
log STEP "Stopping canary container..."
cd "$COMPOSE_PROJECT_DIR"
dc down api-server-canary 2>/dev/null || log WARN "Canary container was not running"
log INFO "Canary container stopped"

# Step 2: Verify stable health
log STEP "Verifying stable api-server health..."
elapsed=0
while [[ $elapsed -lt $ROLLBACK_HEALTH_TIMEOUT ]]; do
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://${STABLE_HEALTH_HOST}:${STABLE_HEALTH_PORT}/healthz" 2>/dev/null || echo "000")

  if [[ "$status" == "200" ]]; then
    log INFO "Stable api-server is healthy (HTTP ${status})"
    break
  fi

  log INFO "Waiting for stable... (at ${elapsed}s, HTTP ${status})"
  sleep "$ROLLBACK_HEALTH_INTERVAL"
  elapsed=$((elapsed + ROLLBACK_HEALTH_INTERVAL))
done

if [[ $elapsed -ge $ROLLBACK_HEALTH_TIMEOUT ]]; then
  log ERROR "Stable api-server is NOT healthy after canary rollback"
  log ERROR "Manual intervention required"
  exit 1
fi

# Step 3: Log rollback event
log STEP "Logging rollback event..."

ROLLBACK_LOG="${COMPOSE_PROJECT_DIR}/.canary-rollbacks.log"
cat >> "$ROLLBACK_LOG" <<EOF
$(date -u +%Y-%m-%dT%H:%M:%SZ) ROLLBACK tag=${ROLLBACK_TAG:-unknown} status=success stable_healthy=true hostname=$(hostname 2>/dev/null || echo "unknown")
EOF

log INFO "Rollback event logged to ${ROLLBACK_LOG}"

# Summary
echo ""
echo "══════════════════════════════════════════════════════════════"
echo -e "  ${GREEN}CANARY ROLLBACK — COMPLETE${NC}"
echo "══════════════════════════════════════════════════════════════"
echo "  Canary:         Stopped"
echo "  Stable:         Healthy"
echo "  Rolled back:    ${ROLLBACK_TAG:-unknown}"
echo "  Timestamp:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "══════════════════════════════════════════════════════════════"
