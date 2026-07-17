#!/bin/sh
# test-backup-restore.sh — End-to-end test of backup and restore
set -eu
cd /workspace
apk add --no-cache bash >/dev/null 2>&1 || true

echo "=== Creating backup ==="
bash scripts/backup.sh /tmp/backups 2>&1

BK=$(ls /tmp/backups/egaop-backup-*.tar.gz 2>/dev/null | head -1)
echo ""
echo "Backup file: $BK"

echo ""
echo "=== Verifying integration ==="
mkdir -p /tmp/verify
tar xzf "$BK" -C /tmp/verify
for f in /tmp/verify/*; do
  name=$(basename "$f")
  size=$(wc -c < "$f")
  echo "  $name: ${size}b"
done

echo ""
echo "=== Testing restore (non-destructive) ==="
echo "n" | bash scripts/restore.sh "$BK" 2>&1 || true
echo ""
echo "=== Checking post-restore health ==="
for svc in grafana redis; do
  CID=$(docker ps --filter "name=$(head -1 docker-compose.yml 2>/dev/null | grep -o '^[^:]*' | head -1)" --format "{{.Names}}" | grep -i "$svc" | head -1)
  if [ -n "$CID" ]; then
    HEALTH=$(docker inspect "$CID" --format '{{.State.Status}}' 2>/dev/null)
    echo "  $svc: $HEALTH"
  fi
done

echo ""
echo "=== TEST COMPLETE ==="
