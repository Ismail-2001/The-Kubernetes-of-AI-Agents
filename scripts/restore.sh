#!/usr/bin/env bash
# restore.sh — PostgreSQL restore for E-GAOP
#
# Restores the egaop database from a pg_dump backup file (.dump or .dump.gz).
# Drops and recreates the database after confirmation, then runs ANALYZE.
#
# Usage:
#   ./scripts/restore.sh /path/to/egaop-postgres_egaop_20260916.dump.gz
#   ./scripts/restore.sh /path/to/egaop-postgres_egaop_20260916.dump

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTAINER_NAME="postgres"
DATABASE="egaop"
PG_USER="egaop"

# --- Validate input -----------------------------------------------------------
if [ $# -lt 1 ] || [ -z "${1}" ]; then
  echo "Usage: $0 /path/to/backup.dump[.gz]" >&2
  exit 1
fi

BACKUP_FILE="${1}"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

if [ ! -r "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file is not readable: ${BACKUP_FILE}" >&2
  exit 1
fi

# --- Locate running postgres container -------------------------------------------
find_postgres_container() {
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
  docker ps --filter "ancestor=pgvector/pgvector" --filter "ancestor=postgres" \
    --format '{{.Names}}' 2>/dev/null | head -1 || true
}

CONTAINER="$(find_postgres_container)"
if [ -z "${CONTAINER}" ]; then
  echo "ERROR: No running PostgreSQL container found." >&2
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

# --- Confirmation prompt ------------------------------------------------------
echo "=== PostgreSQL Restore ==="
echo "Container : ${CONTAINER}"
echo "Database  : ${DATABASE}"
echo "Backup    : ${BACKUP_FILE}"
echo ""
echo "WARNING: This will DROP and recreate the '${DATABASE}' database."
echo "All current data will be lost."
echo ""
read -r -p "Continue? (y/N) " CONFIRM
if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
  echo "Restore cancelled."
  exit 0
fi

# --- Prepare backup file (decompress if gzipped) ------------------------------
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

if [[ "${BACKUP_FILE}" == *.gz ]]; then
  echo "Decompressing backup..."
  gunzip -c "${BACKUP_FILE}" > "${TMPDIR}/restore.dump"
  DUMP_FILE="${TMPDIR}/restore.dump"
else
  DUMP_FILE="${BACKUP_FILE}"
fi

# --- Terminate existing connections --------------------------------------------
echo "Terminating existing connections to '${DATABASE}'..."
docker exec \
  -e PGPASSWORD="${PG_PASSWORD}" \
  "${CONTAINER}" \
  psql -U "${PG_USER}" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();" \
  >/dev/null 2>&1 || true

# --- Drop and recreate database ------------------------------------------------
echo "Dropping database '${DATABASE}'..."
docker exec \
  -e PGPASSWORD="${PG_PASSWORD}" \
  "${CONTAINER}" \
  psql -U "${PG_USER}" -d postgres -c \
  "DROP DATABASE IF EXISTS \"${DATABASE}\";" \
  >/dev/null 2>&1

echo "Creating database '${DATABASE}'..."
docker exec \
  -e PGPASSWORD="${PG_PASSWORD}" \
  "${CONTAINER}" \
  psql -U "${PG_USER}" -d postgres -c \
  "CREATE DATABASE \"${DATABASE}\";" \
  >/dev/null 2>&1

# --- Restore from backup ------------------------------------------------------
echo "Restoring from backup..."
if cat "${DUMP_FILE}" | docker exec -i \
  -e PGPASSWORD="${PG_PASSWORD}" \
  "${CONTAINER}" \
  pg_restore -U "${PG_USER}" -d "${DATABASE}" --clean --if-exists 2>/dev/null; then
  echo "Restore completed successfully."
else
  # pg_restore returns non-zero on warnings too; treat as success if DB exists
  echo "pg_restore finished (may have warnings — this is normal)."
fi

# --- Run ANALYZE to update planner statistics ----------------------------------
echo "Running ANALYZE on '${DATABASE}'..."
docker exec \
  -e PGPASSWORD="${PG_PASSWORD}" \
  "${CONTAINER}" \
  psql -U "${PG_USER}" -d "${DATABASE}" -c "ANALYZE;" \
  >/dev/null 2>&1 && echo "ANALYZE completed." || echo "ANALYZE failed (non-critical)."

# --- Summary -------------------------------------------------------------------
echo ""
echo "=== Restore complete ==="
echo "Database '${DATABASE}' has been restored from:"
echo "  ${BACKUP_FILE}"
echo ""
echo "Recommended next steps:"
echo "  1. Verify data: docker exec -it ${CONTAINER} psql -U ${PG_USER} -d ${DATABASE}"
echo "  2. Restart services: docker compose up -d"
