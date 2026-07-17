#!/bin/sh
# restore.sh — E-GAOP restore from backup archive
#
# Restores all persistent data from a backup .tar.gz created by backup.sh.
# Uses tar pipes over docker exec — avoids docker cp path issues.
# Target services should be RUNNING (restore writes into running containers).
#
# Usage:
#   ./restore.sh /path/to/egaop-backup-20260714_120000.tar.gz
#
# WARNING: Destroys current data and replaces with backup content.
#          For Postgres the script prompts for confirmation.

set -eu

BACKUP_FILE="${1:-}"
if [ -z "${BACKUP_FILE}" ] || [ ! -f "${BACKUP_FILE}" ]; then
  echo "Usage: $0 /path/to/egaop-backup-<stamp>.tar.gz"
  exit 1
fi

PROJECT="${COMPOSE_PROJECT:-enterprise-grade-agent-orchestration-platform-main}"
TMPDIR=$(mktemp -d)
trap 'rm -rf "${TMPDIR}"' EXIT

echo "=== E-GAOP Restore ==="
echo "Source:  ${BACKUP_FILE}"
echo "Project: ${PROJECT}"
echo ""

tar xzf "${BACKUP_FILE}" -C "${TMPDIR}"
echo "Extracted $(find "${TMPDIR}" -type f | wc -l) files"

_find() { docker ps -a --filter "name=${PROJECT}" --format "{{.Names}}" | grep -i "$1" | grep -v "exporter" | head -1 | tr -d '\r\n' || true; }
PGSQL=$(_find postgres)
GRAFANA=$(_find grafana)
REDIS=$(_find redis)
PROM=$(_find prometheus)

# ─── 1. PostgreSQL ──────────────────────────────────────────────────────────
if [ -f "${TMPDIR}/postgres_egaop.dump" ] || [ -f "${TMPDIR}/postgres_temporal.dump" ]; then
  echo "[1/5] PostgreSQL — pg_restore..."
  if [ -z "${PGSQL}" ]; then
    echo "  ⚠ Postgres container not found — skipping"
  else
    echo "  ⚠ This will DROP and recreate databases. Continue? (y/N) "
    read -r CONFIRM
    if [ "${CONFIRM}" != "y" ] && [ "${CONFIRM}" != "Y" ]; then
      echo "  ✗ Skipped"
    else
      PW=$(grep POSTGRES_PASSWORD .env 2>/dev/null | tail -1 | cut -d= -f2-)
      if [ -z "${PW}" ]; then
        echo "  ✗ POSTGRES_PASSWORD not found"
      else
        for DB in egaop temporal; do
          DUMP="${TMPDIR}/postgres_${DB}.dump"
          [ ! -f "${DUMP}" ] && echo "  ⚠ ${DB} dump not found" && continue
          echo "  Restoring ${DB}..."
          # terminate connections
          docker exec -e PGPASSWORD="${PW}" "${PGSQL}" \
            psql -U egaop -d postgres \
            -c "SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = '${DB}' AND pid <> pg_backend_pid()" \
            >/dev/null 2>&1 || true
          docker exec -e PGPASSWORD="${PW}" "${PGSQL}" \
            psql -U egaop -d postgres -c "DROP DATABASE IF EXISTS \"${DB}\"" >/dev/null 2>&1 || true
          docker exec -e PGPASSWORD="${PW}" "${PGSQL}" \
            psql -U egaop -d postgres -c "CREATE DATABASE \"${DB}\"" >/dev/null 2>&1
          # restore from dump via pipe
          cat "${DUMP}" | docker exec -i -e PGPASSWORD="${PW}" "${PGSQL}" \
            pg_restore -U egaop -d "${DB}" --clean --if-exists \
            && echo "  ✓ ${DB} restored"
        done
      fi
    fi
  fi
else
  echo "[1/5] PostgreSQL — no dump files in backup, skipping"
fi

# ─── 2. Grafana ─────────────────────────────────────────────────────────────
if [ -f "${TMPDIR}/grafana-data.tar.gz" ]; then
  echo "[2/5] Grafana — restoring data..."
  if [ -n "${GRAFANA}" ]; then
    docker stop "${GRAFANA}" >/dev/null && echo "  ✓ stopped grafana"
    # use volumes-from to access the stopped container's volume
    docker run -i --rm --volumes-from "${GRAFANA}" alpine:3.19 \
      sh -c "tar xzf - -C /var/lib/grafana" \
      < "${TMPDIR}/grafana-data.tar.gz" \
    && echo "  ✓ restored"
    docker start "${GRAFANA}" >/dev/null && echo "  ✓ started grafana"
  else
    echo "  ⚠ Grafana container not found"
  fi
else
  echo "[2/5] Grafana — no backup data, skipping"
fi

# ─── 3. Redis ───────────────────────────────────────────────────────────────
if [ -f "${TMPDIR}/redis-data.tar.gz" ]; then
  echo "[3/5] Redis — restoring RDB..."
  if [ -n "${REDIS}" ]; then
    docker stop "${REDIS}" >/dev/null && echo "  ✓ stopped redis"
    docker run -i --rm --volumes-from "${REDIS}" alpine:3.19 \
      sh -c "tar xzf - -C /data" \
      < "${TMPDIR}/redis-data.tar.gz" \
    && echo "  ✓ restored"
    docker start "${REDIS}" >/dev/null && echo "  ✓ started redis"
  fi
else
  echo "[3/5] Redis — no backup data, skipping"
fi

# ─── 4. .env ────────────────────────────────────────────────────────────────
if [ -f "${TMPDIR}/env.txt" ]; then
  echo "[4/5] .env — restoring secrets..."
  cp "${TMPDIR}/env.txt" .env.restored 2>/dev/null && echo "  ✓ .env.restored written (review and copy to .env)" || echo "  ⚠ Could not write .env.restored (CWD is read-only)"
else
  echo "[4/5] .env — no backup, skipping"
fi

# ─── 5. Prometheus ──────────────────────────────────────────────────────────
if [ -f "${TMPDIR}/prometheus-data.tar.gz" ]; then
  echo "[5/5] Prometheus — restoring data..."
  if [ -n "${PROM}" ]; then
    docker stop "${PROM}" >/dev/null && echo "  ✓ stopped prometheus"
    docker run -i --rm --volumes-from "${PROM}" alpine:3.19 \
      sh -c "tar xzf - -C /prometheus" \
      < "${TMPDIR}/prometheus-data.tar.gz" \
    && echo "  ✓ restored"
    docker start "${PROM}" >/dev/null && echo "  ✓ started prometheus"
  fi
else
  echo "[5/5] Prometheus — no backup data, skipping"
fi

echo ""
echo "=== Restore complete ==="
echo "Next steps:"
echo "  1. Restart remaining services: docker compose up -d"
echo "  2. Review .env.restored and copy to .env if needed"
echo "  3. Re-run grafana init if needed: node scripts/grafana-init.mjs"
