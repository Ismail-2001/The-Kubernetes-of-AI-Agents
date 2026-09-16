#!/usr/bin/env bash
# =============================================================================
# Canary Promotion Script (The Kubernetes of AI Agents)
# =============================================================================
# Promotes a healthy canary instance to stable by stopping the old stable
# container and starting a new stable container with the canary's image.
#
# Usage:
#   ./scripts/canary-promote.sh <image-tag> [--help]
#
# What this does:
#   1. Stops the stable api-server container
#   2. Starts a new stable api-server with the canary image tag
#   3. Waits for the new stable to become healthy
#   4. Stops the canary container
#   5. Logs the promotion event
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
PROMOTE_HEALTH_TIMEOUT="${PROMOTE_HEALTH_TIMEOUT:-60}"
PROMOTE_HEALTH_INTERVAL="${PROMOTE_HEALTH_INTERVAL:-5}"

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
Canary Promotion Script for E-GAOP

Usage:
  $(basename "$0") <image-tag> [options]

Arguments:
  <image-tag>    The image tag currently running as canary to promote (required)

Options:
  --help         Show this help message

Environment Variables:
  PROMOTE_HEALTH_TIMEOUT   Seconds to wait for new stable to become healthy (default: 60)
  PROMOTE_HEALTH_INTERVAL  Seconds between health check attempts (default: 5)

What this does:
  1. Stops the current stable api-server
  2. Starts a new stable api-server with the canary's image tag
  3. Verifies the new stable is healthy
  4. Stops the canary container
  5. Logs the promotion event

Examples:
  ./scripts/canary-promote.sh abc123def
  PROMOTE_HEALTH_TIMEOUT=120 ./scripts/canary-promote.sh abc123def
EOF
  exit 0
}

# ─── Parse Arguments ─────────────────────────────────────────────────────────
PROMOTE_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      ;;
    -*)
      die "Unknown option: $1 (use --help for usage)"
      ;;
    *)
      if [[ -z "$PROMOTE_TAG" ]]; then
        PROMOTE_TAG="$1"
      else
        die "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[[ -z "$PROMOTE_TAG" ]] && die "Image tag is required. Usage: $(basename "$0") <image-tag>"

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

dc_stable() {
  docker compose \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.yml" \
    -f "${COMPOSE_PROJECT_DIR}/docker-compose.deploy.yml" \
    "$@"
}

# ─── Promotion Steps ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  CANARY PROMOTION — E-GAOP"
echo "══════════════════════════════════════════════════════════════"
echo "  Promoting tag: ${PROMOTE_TAG}"
echo "  Timestamp:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "══════════════════════════════════════════════════════════════"
echo ""

# Step 1: Stop the stable api-server
log STEP "Stopping stable api-server..."
cd "$COMPOSE_PROJECT_DIR"
dc_stable stop api-server 2>/dev/null || log WARN "Stable api-server was not running"
log INFO "Stable api-server stopped"

# Step 2: Update .env with new tag
log STEP "Updating IMAGE_TAG in .env to ${PROMOTE_TAG}..."
if [[ -f .env ]]; then
  # Backup current .env
  cp .env .env.canary-backup.$(date +%s)
  # Replace IMAGE_TAG line
  if grep -q "^IMAGE_TAG=" .env; then
    sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${PROMOTE_TAG}/" .env
  else
    echo "IMAGE_TAG=${PROMOTE_TAG}" >> .env
  fi
  log INFO ".env updated"
else
  log WARN ".env not found — creating minimal .env with IMAGE_TAG"
  echo "IMAGE_TAG=${PROMOTE_TAG}" > .env
fi

# Step 3: Start new stable with canary image
log STEP "Starting new stable api-server with tag ${PROMOTE_TAG}..."
export IMAGE_TAG="$PROMOTE_TAG"
dc_stable up -d api-server
log INFO "New stable api-server started"

# Step 4: Verify health
log STEP "Verifying new stable api-server health..."
elapsed=0
while [[ $elapsed -lt $PROMOTE_HEALTH_TIMEOUT ]]; do
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://127.0.0.1:15051/healthz" 2>/dev/null || echo "000")

  if [[ "$status" == "200" ]]; then
    log INFO "New stable api-server is healthy (HTTP ${status})"
    break
  fi

  log INFO "Waiting for stable... (at ${elapsed}s, HTTP ${status})"
  sleep "$PROMOTE_HEALTH_INTERVAL"
  elapsed=$((elapsed + PROMOTE_HEALTH_INTERVAL))
done

if [[ $elapsed -ge $PROMOTE_HEALTH_TIMEOUT ]]; then
  log ERROR "New stable api-server failed to become healthy within ${PROMOTE_HEALTH_TIMEOUT}s"
  log ERROR "Manual intervention required — .env has been updated to ${PROMOTE_TAG}"
  exit 1
fi

# Step 5: Stop canary
log STEP "Stopping canary container..."
dc down api-server-canary 2>/dev/null || log WARN "Canary container was not running"
log INFO "Canary container stopped"

# Step 6: Log promotion event
log STEP "Logging promotion event..."

PROMOTION_LOG="${COMPOSE_PROJECT_DIR}/.canary-promotions.log"
cat >> "$PROMOTION_LOG" <<EOF
$(date -u +%Y-%m-%dT%H:%M:%SZ) PROMOTE tag=${PROMOTE_TAG} status=success hostname=$(hostname 2>/dev/null || echo "unknown")
EOF

log INFO "Promotion event logged to ${PROMOTION_LOG}"

# Summary
echo ""
echo "══════════════════════════════════════════════════════════════"
echo -e "  ${GREEN}CANARY PROMOTION — COMPLETE${NC}"
echo "══════════════════════════════════════════════════════════════"
echo "  Stable image tag: ${PROMOTE_TAG}"
echo "  Canary:           Stopped"
echo "  Health:           Verified"
echo "  Timestamp:        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "══════════════════════════════════════════════════════════════"
