#!/bin/sh
# backup.sh — Backup & disaster recovery (The Kubernetes of AI Agents)
#
# Creates a timestamped backup archive of all persistent data.
# Uses tar over docker exec pipes — avoids docker cp path issues.
#
# Usage:
#   ./backup.sh                      # backup to ./backups/
#   ./backup.sh /path/to/dir         # to custom directory
#   ./backup.sh --full /tmp/bk       # include Prometheus
#
# Restore:
#   ./restore.sh /path/to/backup.tar.gz

set -eu

BACKUP_DIR="${1:-./backups}"
FULL="${2:-}"
PROJECT="${COMPOSE_PROJECT:-enterprise-grade-agent-orchestration-platform-main}"
DATE_STAMP=$(date +%Y%m%d_%H%M%S)
OUT_FILE="${BACKUP_DIR}/egaop-backup-${DATE_STAMP}.tar"
TMPDIR=$(mktemp -d)
trap 'rm -rf "${TMPDIR}"' EXIT

mkdir -p "${BACKUP_DIR}"

echo "=== Backup: ${DATE_STAMP} ==="
echo "Project: ${PROJECT}"
echo "Output:  ${OUT_FILE}.gz"
echo ""

_find() { docker ps -a --filter "name=${PROJECT}" --format "{{.Names}}" | grep -i "$1" | grep -v "exporter" | head -1 | tr -d '\r\n' || true; }
PGSQL=$(_find postgres)
GRAFANA=$(_find grafana)
REDIS=$(_find redis)
PROM=$(_find prometheus)

# check each found container is actually running (docker exec won't work on stopped)
_is_running() { [ -n "$1" ] && docker ps --filter "name=^/$1$" --format "{{.Names}}" | head -1 | tr -d '\r\n' || true; }
PGSQL=$(_is_running "$PGSQL")
GRAFANA=$(_is_running "$GRAFANA")
REDIS=$(_is_running "$REDIS")
PROM=$(_is_running "$PROM")

# ─── 1. PostgreSQL ──────────────────────────────────────────────────────────
echo "[1/5] PostgreSQL — pg_dump..."
if [ -n "${PGSQL}" ]; then
  PW=$(grep POSTGRES_PASSWORD .env 2>/dev/null | tail -1 | cut -d= -f2-)
  if [ -n "${PW}" ]; then
    for DB in egaop temporal; do
      docker exec -e PGPASSWORD="${PW}" "${PGSQL}" \
        pg_dump -U egaop -d "${DB}" -F c \
        > "${TMPDIR}/postgres_${DB}.dump" 2>/dev/null \
      && echo "  ✓ postgres_${DB}.dump (${DB})"
    done
  else
    echo "  ⚠ POSTGRES_PASSWORD not found in .env"
  fi
else
  echo "  ⚠ Postgres container not found"
fi

# ─── 2. Grafana ─────────────────────────────────────────────────────────────
echo "[2/5] Grafana — data directory..."
if [ -n "${GRAFANA}" ]; then
  docker exec "${GRAFANA}" tar cz -C /var/lib/grafana \
    --exclude=plugins --exclude=plugins-bundled . \
    > "${TMPDIR}/grafana-data.tar.gz" 2>/dev/null \
  && echo "  ✓ grafana-data.tar.gz (sqlite + config)"
else
  echo "  ⚠ Grafana container not found"
fi

# ─── 3. Redis ───────────────────────────────────────────────────────────────
echo "[3/5] Redis — RDB snapshot..."
if [ -n "${REDIS}" ]; then
  docker exec "${REDIS}" redis-cli SAVE >/dev/null 2>&1 && echo "  ✓ SAVE"
  docker exec "${REDIS}" tar cz -C /data . \
    > "${TMPDIR}/redis-data.tar.gz" 2>/dev/null \
  && echo "  ✓ redis-data.tar.gz"
else
  echo "  ⚠ Redis container not found"
fi

# ─── 4. .env ────────────────────────────────────────────────────────────────
echo "[4/5] .env — secrets..."
if [ -f .env ]; then
  cp .env "${TMPDIR}/env.txt"
  echo "  ✓ env.txt"
else
  echo "  ⚠ .env not found"
fi

# ─── 5. Prometheus (full only) ──────────────────────────────────────────────
if [ "${FULL}" = "--full" ]; then
  echo "[5/5] Prometheus — data (full backup)..."
  if [ -n "${PROM}" ]; then
    docker exec "${PROM}" tar cz -C /prometheus --exclude=wal --exclude=chunks_head . \
      > "${TMPDIR}/prometheus-data.tar.gz" 2>/dev/null \
    && echo "  ✓ prometheus-data.tar.gz"
  else
    echo "  ⚠ Prometheus container not found"
  fi
else
  echo "[5/5] Prometheus — SKIPPED (pass --full to include)"
fi

# ─── archive ─────────────────────────────────────────────────────────────────
echo ""
echo "Packaging (gzip)..."
(cd "${TMPDIR}" && tar cf - . | gzip -9) > "${OUT_FILE}.gz"
echo "  ✓ ${OUT_FILE}.gz ($(du -h "${OUT_FILE}.gz" | cut -f1))"

echo ""
echo "Backup contents:"
tar tzf "${OUT_FILE}.gz" | sed 's/^/  /'

echo ""
echo "=== Backup complete ==="
