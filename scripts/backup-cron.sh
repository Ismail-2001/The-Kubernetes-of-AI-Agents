#!/bin/sh
# backup-cron.sh — runs inside a Docker container, periodically dumps Postgres & Redis
# Runs /scripts/backup.sh every 6 hours, deletes backups older than $BACKUP_RETENTION_DAYS
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backup}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
SLEEP_SECS=$((6 * 3600))

echo "backup-cron: starting, interval=${SLEEP_SECS}s, retention=${RETENTION_DAYS}d"

while true; do
  echo "=== backup-cron: $(date -Iseconds) ==="

  /scripts/backup.sh "${BACKUP_DIR}"

  echo "backup-cron: cleaning backups older than ${RETENTION_DAYS} days"
  find "${BACKUP_DIR}" -name '*.tar.gz' -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

  echo "backup-cron: sleep ${SLEEP_SECS}s"
  sleep "${SLEEP_SECS}"
done
