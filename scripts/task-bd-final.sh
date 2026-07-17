#!/bin/sh
# task-bd-final.sh — 3 independent backup->destroy->restore->verify cycles
set -u
cd /workspace

apk add --no-cache sqlite >/dev/null 2>&1 || true

_cname() { docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | grep -i "$1" | grep -v exporter | head -1 | tr -d '\r\n'; }
_is_running() { docker ps --filter "name=^/$1$" --format "{{.Names}}" | head -1 | tr -d '\r\n' || true; }

GRAFANA=$(_cname grafana)
REDIS=$(_cname redis)
PGSQL=$(_cname postgres)
PW=$(grep POSTGRES_PASSWORD .env 2>/dev/null | tail -1 | cut -d= -f2-)

docker start "$GRAFANA" "$REDIS" 2>/dev/null || true
sleep 5

# --- SETUP test data & capture reference ---
docker exec "$REDIS" redis-cli SET bk:test:val "hello-world-42" >/dev/null 2>&1
echo "TRUNCATE bk_verify; CREATE TABLE IF NOT EXISTS bk_verify (id serial primary key, val text unique); INSERT INTO bk_verify (val) VALUES ('backup-test-record-1') ON CONFLICT (val) DO NOTHING;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null

docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/_ref.db 2>/dev/null
REF_DS=$(sqlite3 /tmp/_ref.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null || echo "UNKNOWN")
REF_ORG=$(sqlite3 /tmp/_ref.db "SELECT name FROM org LIMIT 1;" 2>/dev/null || echo "UNKNOWN")
REF_REDIS=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null || echo "UNKNOWN")
REF_PG=$(echo "SELECT COALESCE(count(*)::text||' rows, val='||val, '0 rows') FROM bk_verify ORDER BY id LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ')
rm -f /tmp/_ref.db

echo "=== REFERENCE VALUES ==="
echo "  Grafana DS:  $REF_DS"
echo "  Grafana Org: $REF_ORG"
echo "  Redis key:   $REF_REDIS"
echo "  PG content:  $REF_PG"
echo ""

PASS=0; FAIL=0

for CYCLE in 1 2 3; do
  echo "=== CYCLE $CYCLE ==="

  # --- 1. BACKUP ---
  rm -rf /tmp/bk; mkdir -p /tmp/bk
  sh scripts/backup.sh /tmp/bk >/tmp/bk.log 2>&1 || true
  BK=$(ls /tmp/bk/egaop-backup-*.tar.gz 2>/dev/null | head -1 || echo "")
  if [ -z "$BK" ]; then echo "  BACKUP FAILED"; cat /tmp/bk.log; exit 1; fi
  echo "  [1/4] BACKUP -> $(wc -c < $BK) bytes"

  # --- 2. DESTROY ---
  docker exec "$GRAFANA" sh -c 'rm -f /var/lib/grafana/grafana.db && touch /var/lib/grafana/grafana.db' 2>/dev/null || true
  docker exec "$REDIS" redis-cli DEL bk:test:val >/dev/null 2>&1 || true
  echo "TRUNCATE bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null || true
  echo "  [2/4] DESTROY -> grafana.db emptied, redis key deleted, pg truncated"

  # --- 3. RESTORE ---
  echo "y" | sh scripts/restore.sh "$BK" >/tmp/rest.log 2>&1 || true
  sleep 12
  echo "  [3/4] RESTORE done"

  # --- 4. VERIFY ---
  docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/_v.db 2>/dev/null || true
  V_DS=$(sqlite3 /tmp/_v.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null || echo "MISSING")
  V_ORG=$(sqlite3 /tmp/_v.db "SELECT name FROM org LIMIT 1;" 2>/dev/null || echo "MISSING")
  V_REDIS=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null || echo "MISSING")
  V_PG=$(echo "SELECT COALESCE(count(*)::text||' rows, val='||val, '0 rows') FROM bk_verify ORDER BY id LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "MISSING")
  rm -f /tmp/_v.db

  ISSUES=""
  [ "$V_DS" != "$REF_DS" ]   && ISSUES="$ISSUES ds($V_DS!=$REF_DS)"
  [ "$V_ORG" != "$REF_ORG" ]  && ISSUES="$ISSUES org($V_ORG!=$REF_ORG)"
  [ "$V_REDIS" != "$REF_REDIS" ] && ISSUES="$ISSUES redis($V_REDIS!=$REF_REDIS)"
  [ "$V_PG" != "$REF_PG" ]    && ISSUES="$ISSUES pg($V_PG!=$REF_PG)"

  echo "  [4/4] VERIFY"
  echo "    Grafana DS:  $V_DS      (expected: $REF_DS)"
  echo "    Grafana Org: $V_ORG     (expected: $REF_ORG)"
  echo "    Redis key:   $V_REDIS   (expected: $REF_REDIS)"
  echo "    PG content:  $V_PG      (expected: $REF_PG)"

  if [ -z "$ISSUES" ]; then
    echo "  >>> CYCLE $CYCLE: PASS <<<"
    PASS=$((PASS + 1))
  else
    echo "  >>> CYCLE $CYCLE: FAIL ($ISSUES) <<<"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "========================================"
echo " RESULTS: $PASS/3 passed, $FAIL/3 failed"
echo "========================================"

# Cleanup test data
echo "TRUNCATE bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null || true
docker exec "$REDIS" redis-cli DEL bk:test:val >/dev/null 2>&1 || true
