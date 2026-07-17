#!/bin/sh
# full-backup-test.sh — setup test data, run N cycles, report results
set -u
cd /workspace

apk add --no-cache sqlite >/dev/null 2>&1 || true

_cname() { docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | grep -i "$1" | grep -v exporter | head -1 | tr -d '\r\n'; }
_is_running() { docker ps --filter "name=^/$1$" --format "{{.Names}}" | head -1 | tr -d '\r\n' || true; }

GRAFANA=$(_cname grafana)
REDIS=$(_cname redis)
PGSQL=$(_cname postgres)
PW=$(grep POSTGRES_PASSWORD .env 2>/dev/null | tail -1 | cut -d= -f2-)

# Ensure services are running
docker start "$GRAFANA" "$REDIS" 2>/dev/null || true
echo "  Waiting for services to be ready..."
for i in 1 2 3 4 5 6 7 8; do
  sleep 2
  if docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/_check.db 2>/dev/null && [ -s /tmp/_check.db ]; then
    CHECK_DS=$(sqlite3 /tmp/_check.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null)
    if [ -n "$CHECK_DS" ]; then echo "  Grafana ready (DS=$CHECK_DS)"; break; fi
  fi
  echo "  Waiting... ($i)"
done
rm -f /tmp/_check.db

# ─── SETUP TEST DATA ──────────────────────────────────────────────────────────
echo "=== SETUP: Creating test data ==="

# Grafana: copy DB and record state
docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/ref_grafana.db 2>/dev/null
REF_DS=$(sqlite3 /tmp/ref_grafana.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null)
REF_ORG=$(sqlite3 /tmp/ref_grafana.db "SELECT name FROM org LIMIT 1;" 2>/dev/null)
echo "  Grafana: DS=$REF_DS Org=$REF_ORG"

# Redis
docker exec "$REDIS" redis-cli SET bk:test:val "hello-world-42" >/dev/null 2>&1
REF_REDIS=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null)
echo "  Redis: key=$REF_REDIS"

# Postgres
echo "TRUNCATE bk_verify; CREATE TABLE IF NOT EXISTS bk_verify (id serial primary key, val text unique); INSERT INTO bk_verify (val) VALUES ('backup-test-record-1') ON CONFLICT (val) DO NOTHING;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null
REF_PG_COUNT=$(echo "SELECT count(*) FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ')
REF_PG_VAL=$(echo "SELECT val FROM bk_verify ORDER BY id DESC LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ')
echo "  Postgres: count=$REF_PG_COUNT val=$REF_PG_VAL"

rm -f /tmp/ref_grafana.db

if [ -z "$REF_DS" ] || [ -z "$REF_REDIS" ] || [ "$REF_PG_COUNT" != "1" ]; then
  echo "FATAL: Test data setup failed"; exit 1
fi

# ─── RUN CYCLES ───────────────────────────────────────────────────────────────
MAX="${1:-3}"
RESULTS=""
PASS_COUNT=0
FAIL_COUNT=0

for CYCLE in $(seq 1 $MAX); do
  echo ""
  echo "======================================================================"
  echo " CYCLE $CYCLE OF $MAX"
  echo "======================================================================"

  # 1. BACKUP
  rm -f /tmp/bk/*.tar.gz 2>/dev/null; mkdir -p /tmp/bk
  sh scripts/backup.sh /tmp/bk > /tmp/bk.log 2>&1
  BK=$(ls /tmp/bk/egaop-backup-*.tar.gz 2>/dev/null | head -1 || echo "")
  if [ -z "$BK" ]; then echo "  BACKUP FAILED"; cat /tmp/bk.log; exit 1; fi
  echo "  Backup: $(wc -c < $BK) bytes"

  # 2. DESTROY
  docker exec "$GRAFANA" sh -c 'rm -f /var/lib/grafana/grafana.db && touch /var/lib/grafana/grafana.db' 2>/dev/null || true
  docker exec "$REDIS" redis-cli DEL bk:test:val >/dev/null 2>&1 || true
  echo "TRUNCATE bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null || true
  echo "  Destroyed: grafana.db, redis key, pg bk_verify"

  # 3. RESTORE
  echo "y" | sh scripts/restore.sh "$BK" > /tmp/restore.log 2>&1 || true
  # Wait for services to come up
  sleep 5

  # 4. VERIFY
  FAIL=0

  # Grafana
  rm -f /tmp/post_grafana.db
  docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/post_grafana.db 2>/dev/null || FAIL=1
  POST_DS=$(sqlite3 /tmp/post_grafana.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null || echo "MISSING")
  POST_ORG=$(sqlite3 /tmp/post_grafana.db "SELECT name FROM org LIMIT 1;" 2>/dev/null || echo "MISSING")

  # Redis
  POST_REDIS=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null || echo "MISSING")

  # Postgres
  POST_PG_COUNT=$(echo "SELECT count(*) FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "ERR")
  POST_PG_VAL=$(echo "SELECT val FROM bk_verify ORDER BY id DESC LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "ERR")

  rm -f /tmp/post_grafana.db

  echo "  Grafana DS:  '$POST_DS' (expected: '$REF_DS')"
  echo "  Grafana Org: '$POST_ORG' (expected: '$REF_ORG')"
  echo "  Redis key:   '$POST_REDIS' (expected: '$REF_REDIS')"
  echo "  PG count:    '$POST_PG_COUNT' (expected: '$REF_PG_COUNT')"
  echo "  PG val:      '$POST_PG_VAL' (expected: '$REF_PG_VAL')"

  if [ "$POST_DS" != "$REF_DS" ]; then echo "  FAIL Grafana DS"; FAIL=1; fi
  if [ "$POST_ORG" != "$REF_ORG" ]; then echo "  FAIL Grafana Org"; FAIL=1; fi
  if [ "$POST_REDIS" != "$REF_REDIS" ]; then echo "  FAIL Redis"; FAIL=1; fi
  if [ "$POST_PG_COUNT" != "$REF_PG_COUNT" ]; then echo "  FAIL PG count"; FAIL=1; fi
  if [ "$POST_PG_VAL" != "$REF_PG_VAL" ]; then echo "  FAIL PG val"; FAIL=1; fi

  if [ "$FAIL" = "0" ]; then
    echo "  >>> CYCLE $CYCLE: PASS <<<"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  >>> CYCLE $CYCLE: FAIL <<<"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo ""
echo "================================================"
echo " RESULTS: $PASS_COUNT/$MAX passed, $FAIL_COUNT/$MAX failed"
echo "================================================"

# Cleanup
rm -f /tmp/bk.log /tmp/restore.log
rm -rf /tmp/bk

# Remove test data post-cycles
echo "DELETE FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null || true
docker exec "$REDIS" redis-cli DEL bk:test:val >/dev/null 2>&1 || true

exit $FAIL_COUNT
