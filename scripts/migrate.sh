#!/usr/bin/env bash
# =============================================================================
# Migration wrapper (The Kubernetes of AI Agents)
# =============================================================================
# Runs the Node.js migration engine inside Docker or natively.
# Usage: bash scripts/migrate.sh <command> [options]
#   Commands: up, down, status, create
#   Options:  --name=<name>, --count=<N>, --dry-run, --connection=<str>
#
# Environment:
#   POSTGRES_URL  Connection string (required for up/down/status)
#   MIGRATIONS_DIR  Migration files directory (default: migrations/)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Use POSTGRES_URL from env or build from components
if [ -z "${POSTGRES_URL:-}" ]; then
  PG_HOST="${POSTGRES_HOST:-localhost}"
  PG_PORT="${POSTGRES_PORT:-5432}"
  PG_USER="${POSTGRES_USER:-egaop}"
  PG_PASSWORD="${POSTGRES_PASSWORD:-egaop}"
  PG_DB="${POSTGRES_DB:-egaop}"
  export POSTGRES_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}"
fi

export POSTGRES_URL

echo "═══ Migration: $1 ═══"
echo "  Host: $(echo "$POSTGRES_URL" | sed 's/:[^:@]*@/:****@/')"
echo "  Dir:  ${MIGRATIONS_DIR:-${PROJECT_DIR}/migrations}"
echo ""

exec node "$PROJECT_DIR/scripts/migrate.mjs" "$@"
