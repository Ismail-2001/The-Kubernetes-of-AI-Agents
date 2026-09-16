#!/usr/bin/env bash
# backup.sh — PostgreSQL backup for E-GAOP
#
# Dumps the egaop database from the Postgres Docker container using pg_dump
# in custom format (-Fc), compresses with gzip, and saves to backups/.
#
# Usage:
#   ./scripts/backup.sh              # backup with default timestamp (now)
#   ./scripts/backup.sh 20260916     # backup with custom timestamp

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${PROJECT_ROOT}/backups"
CONTAINER_NAME="postgres"
DATABASE="egaop"
PG_USER="egaop"
NETWORK="enterprise-grade-agent-orchestration-platform-main_egaop-net"

# Allow optional timestamp argument; default to current time
TIMESTAMP="${1:-$(date +%Y%m%d_%H%M%S)}"
DUMP_FILE="${BACKUP_DIR}/egaop-postgres_${DATABASE}_${TIMESTAMP}.dump"
GZ_FILE="${DUMP_FILE}.gz"

mkdir -p "${BACKUP_DIR}"

# --- Locate running postgres container -------------------------------------------
find_postgres_container() {
  # Try common container name patterns used by docker-compose
  local candidates=(
    "enterprise-grade-agent-orchestration-platform-main-postgres-1"
    "k8s-ai-agents-postgres-1"
    "postgres"
  )
  for name in "${candidates[@]}"; do
    if docker ps --filter "name=^/${name}$" --format '{{.Names}}' 2>/dev/null | grep -q .; then
      echo "${name}"
      return 0
    fi
  done
  # Fallback: find any running container with "postgres" in the image or name
  docker ps --filter "ancestor=pgvector/pgvector" --filter "ancestor=postgres" \
    --format '{{.Names}}' 2>/dev/null | head -1 || true
}

CONTAINER="$(find_postgres_container)"
if [ -z "${CONTAINER}" ]; then
  echo "ERROR: No running PostgreSQL container found." >&2
  echo "Expected one of: ${candidates[*]:-postgres}" >&2
  echo "Searched using image filters (pgvector, postgres)." >&2
  exit 1
fi

# --- Read password from .env --------------------------------------------------
if [ -f "${PROJECT_ROOT}/.env" ]; then
  PG_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "${PROJECT_ROOT}/.env" | tail -1 | cut -d= -f2-)"
else
  echo "ERROR: .env file not found at ${PROJECT_ROOT}/.env" >&2
  exit 1
fi

if [ -z "${PG_PASSWORD}" ]; then
  echo "ERROR: POSTGRES_PASSWORD not set in .env" >&2
  exit 1
fi

# --- Perform backup ------------------------------------------------------------
echo "=== PostgreSQL Backup ==="
echo "Container : ${CONTAINER}"
echo "Database  : ${DATABASE}"
echo "Timestamp : ${TIMESTAMP}"
echo "Output    : ${GZ_FILE}"
echo ""

# Run pg_dump inside the container with custom format (-Fc)
# Custom format supports pg_restore with selective restore and parallel options
if docker exec \
  -e PGPASSWORD="${PG_PASSWORD}" \
  "${CONTAINER}" \
  pg_dump -U "${PG_USER}" -d "${DATABASE}" -Fc \
  > "${DUMP_FILE}" 2>/dev/null; then
  echo "pg_dump completed successfully."
else
  echo "ERROR: pg_dump failed." >&2
  rm -f "${DUMP_FILE}"
  exit 1
fi

# --- Compress with gzip -------------------------------------------------------
if gzip -9 "${DUMP_FILE}"; then
  echo "Compression completed."
else
  echo "ERROR: gzip compression failed." >&2
  rm -f "${GZ_FILE}"
  exit 1
fi

# --- Report -------------------------------------------------------------------
BACKUP_SIZE="$(du -h "${GZ_FILE}" | cut -f1)"
echo ""
echo "Backup saved: ${GZ_FILE}"
echo "Backup size : ${BACKUP_SIZE}"
echo "=== Backup complete ==="
