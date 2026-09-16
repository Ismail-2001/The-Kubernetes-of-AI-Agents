#!/usr/bin/env bash
# backup-cron.sh — Automated daily PostgreSQL backup with retention for E-GAOP
#
# Designed to be run via cron. Executes the backup script, then prunes
# backups older than 7 days. Logs everything to backups/cron.log.
#
# Crontab installation (run from project root):
#   crontab -e
#   # Add this line to run daily at 2 AM:
#   0 2 * * * /path/to/Enterprise-Grade-Agent-Orchestration-Platform-main/scripts/backup-cron.sh
#
# To verify crontab:
#   crontab -l
#
# To remove:
#   crontab -l | grep -v backup-cron | crontab -

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${PROJECT_ROOT}/backups"
LOG_FILE="${BACKUP_DIR}/cron.log"
RETENTION_DAYS=7

mkdir -p "${BACKUP_DIR}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

log "=== Backup cron started ==="

# --- Run backup ---------------------------------------------------------------
if bash "${SCRIPT_DIR}/backup.sh" 2>&1 | tee -a "${LOG_FILE}"; then
  log "Backup completed successfully."
else
  log "ERROR: Backup script failed with exit code $?."
fi

# --- Prune old backups --------------------------------------------------------
log "Pruning backups older than ${RETENTION_DAYS} days..."
PRUNED=0

# Find and delete .dump.gz files older than retention period
while IFS= read -r -d '' old_file; do
  log "Removing old backup: ${old_file}"
  rm -f "${old_file}"
  PRUNED=$((PRUNED + 1))
done < <(find "${BACKUP_DIR}" -maxdepth 1 -name 'egaop-postgres_*.dump.gz' -type f -mtime "+${RETENTION_DAYS}" -print0 2>/dev/null)

if [ "${PRUNED}" -gt 0 ]; then
  log "Pruned ${PRUNED} old backup(s)."
else
  log "No backups to prune."
fi

# --- Disk usage report --------------------------------------------------------
BACKUP_COUNT="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'egaop-postgres_*.dump.gz' -type f 2>/dev/null | wc -l)"
DISK_USAGE="$(du -sh "${BACKUP_DIR}" 2>/dev/null | cut -f1)"
log "Current backups: ${BACKUP_COUNT}, Total disk usage: ${DISK_USAGE}"
log "=== Backup cron finished ==="
