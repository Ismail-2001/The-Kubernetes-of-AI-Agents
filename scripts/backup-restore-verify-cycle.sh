#!/bin/sh
# backup-restore-verify-cycle.sh — one full cycle: backup → destroy → restore → content-verify
# Usage: ./scripts/backup-restore-verify-cycle.sh <cycle-number>
set -u
cd /workspace

CYCLE="${1:-1}"
apk add --no-cache sqlite >/dev/null 2>&1 || true

_cname() { docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | grep -i "$1" | grep -v exporter | head -1 | tr -d '\r\n'; }

GRAFANA=$(_cname grafana)
REDIS=$(_cname redis)
PGSQL=$(_cname postgres)

echo "=== CYCLE $CYCLE: containers=[$GRAFANA] [$REDIS] [$PGSQL] ==="

PW=$(grep POSTGRES_PASSWORD .env 2>/dev/null | tail -1 | cut -d= -f2-)

# ─── PRE-CAPTURE ───────────────────────────────────────────────────────────
rm -f /tmp/pre_grafana.db 2>/dev/null || true
docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/pre_grafana.db 2>/dev/null || true
if [ -f /tmp/pre_grafana.db ]; then
  PRE_GRAFANA_DS=$(sqlite3 /tmp/pre_grafana.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null || echo "ERR")
  PRE_GRAFANA_ORG=$(sqlite3 /tmp/pre_grafana.db "SELECT name FROM org LIMIT 1;" 2>/dev/null || echo "ERR")
else
  echo "FATAL: cannot copy grafana.db"; exit 1
fi

PRE_REDIS_KEY=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null || echo "")
PRE_PG_COUNT=$(echo "SELECT count(*) FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "ERR")
PRE_PG_VAL=$(echo "SELECT val FROM bk_verify ORDER BY id DESC LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "ERR")

echo "  Grafana DS: $PRE_GRAFANA_DS | Org: $PRE_GRAFANA_ORG"
echo "  Redis key: $PRE_REDIS_KEY"
echo "  Postgres bk_verify: count=$PRE_PG_COUNT val=$PRE_PG_VAL"

# ─── BACKUP ────────────────────────────────────────────────────────────────
rm -f /tmp/bk/*.tar.gz 2>/dev/null || true
mkdir -p /tmp/bk
sh scripts/backup.sh /tmp/bk > /tmp/bk.log 2>&1
BK=$(ls /tmp/bk/egaop-backup-*.tar.gz 2>/dev/null | head -1 || echo "")
if [ -z "$BK" ]; then echo "BACKUP FAILED"; cat /tmp/bk.log; exit 1; fi
echo "  Backup: $BK ($(wc -c < $BK) bytes)"

# ─── DESTROY ───────────────────────────────────────────────────────────────
docker exec "$GRAFANA" sh -c 'rm -f /var/lib/grafana/grafana.db && touch /var/lib/grafana/grafana.db' 2>/dev/null || true
docker exec "$REDIS" redis-cli DEL bk:test:val >/dev/null 2>&1 || true
echo "TRUNCATE bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null || true
echo "  Destroyed: grafana.db, redis key, pg bk_verify"

# ─── VERIFY DESTROY ────────────────────────────────────────────────────────
GRAFANA_DESTROYED=$(docker exec "$GRAFANA" wc -c /var/lib/grafana/grafana.db 2>/dev/null | awk '{print $1}' || echo "0")
REDIS_DESTROYED=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null || echo "")
PG_DESTROYED=$(echo "SELECT count(*) FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "?")
echo "  Verify destroyed: grafana=$GRAFANA_DESTROYED redis='$REDIS_DESTROYED' pg_count=$PG_DESTROYED"

# ─── RESTORE ───────────────────────────────────────────────────────────────
echo "y" | sh scripts/restore.sh "$BK" 2>&1 || true
sleep 3

# ─── VERIFY RESTORE ────────────────────────────────────────────────────────
FAIL=0
rm -f /tmp/post_grafana.db 2>/dev/null || true
docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/post_grafana.db 2>/dev/null || FAIL=1
if [ -f /tmp/post_grafana.db ]; then
  POST_GRAFANA_DS=$(sqlite3 /tmp/post_grafana.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null || echo "ERR")
  POST_GRAFANA_ORG=$(sqlite3 /tmp/post_grafana.db "SELECT name FROM org LIMIT 1;" 2>/dev/null || echo "ERR")
else
  POST_GRAFANA_DS="ERR"; POST_GRAFANA_ORG="ERR"
fi

POST_REDIS_KEY=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null || echo "")
POST_PG_COUNT=$(echo "SELECT count(*) FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "ERR")
POST_PG_VAL=$(echo "SELECT val FROM bk_verify ORDER BY id DESC LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "ERR")

echo ""
echo "=== CYCLE $CYCLE: RESULTS ==="
echo "  Grafana DS:  $POST_GRAFANA_DS (expected: $PRE_GRAFANA_DS)"
echo "  Grafana Org: $POST_GRAFANA_ORG (expected: $PRE_GRAFANA_ORG)"
echo "  Redis key:   $POST_REDIS_KEY (expected: $PRE_REDIS_KEY)"
echo "  PG count:    $POST_PG_COUNT (expected: $PRE_PG_COUNT)"
echo "  PG val:      $POST_PG_VAL (expected: $PRE_PG_VAL)"

if [ "$POST_GRAFANA_DS" != "$PRE_GRAFANA_DS" ]; then echo "FAIL Grafana DS"; FAIL=1; fi
if [ "$POST_GRAFANA_ORG" != "$PRE_GRAFANA_ORG" ]; then echo "FAIL Grafana Org"; FAIL=1; fi
if [ "$POST_REDIS_KEY" != "$PRE_REDIS_KEY" ]; then echo "FAIL Redis key"; FAIL=1; fi
if [ "$POST_PG_COUNT" != "$PRE_PG_COUNT" ]; then echo "FAIL PG count"; FAIL=1; fi
if [ "$POST_PG_VAL" != "$PRE_PG_VAL" ]; then echo "FAIL PG val"; FAIL=1; fi

rm -f /tmp/pre_grafana.db /tmp/post_grafana.db /tmp/bk.log
if [ "$FAIL" = "0" ]; then echo "=== CYCLE $CYCLE: PASSED ==="; else echo "=== CYCLE $CYCLE: FAILED ==="; exit 1; fi
