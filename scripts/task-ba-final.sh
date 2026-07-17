#!/bin/sh
# task-ba-final.sh — 3 independent backup→destroy→restore→content-verify cycles
set -u
cd /workspace
apk add --no-cache sqlite >/dev/null 2>&1 || true

_cname() { docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | grep -i "$1" | grep -v exporter | head -1 | tr -d '\r\n'; }
_is_running() { docker ps --filter "name=^/$1$" --format "{{.Names}}" | head -1 | tr -d '\r\n' || true; }

GRAFANA=$(_cname grafana); REDIS=$(_cname redis); PGSQL=$(_cname postgres)
docker start "$GRAFANA" "$REDIS" 2>/dev/null || true
sleep 5

PW=$(grep POSTGRES_PASSWORD .env 2>/dev/null | tail -1 | cut -d= -f2-)

# ─── SETUP ────────────────────────────────────────────────────────────────────
echo "=== SETUP: Create test data ==="
docker exec "$REDIS" redis-cli SET bk:test:val "hello-world-42" >/dev/null 2>&1
echo "TRUNCATE bk_verify; CREATE TABLE IF NOT EXISTS bk_verify (id serial primary key, val text unique); INSERT INTO bk_verify (val) VALUES ('backup-test-record-1') ON CONFLICT (val) DO NOTHING;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null
docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/_ref.db 2>/dev/null
REF_DS=$(sqlite3 /tmp/_ref.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null)
REF_ORG=$(sqlite3 /tmp/_ref.db "SELECT name FROM org LIMIT 1;" 2>/dev/null)
echo "  Grafana DS=$REF_DS Org=$REF_ORG"
echo "  Redis: $(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null)"
echo "  PG: $(echo "SELECT count(*)||' rows, val='||val FROM bk_verify ORDER BY id LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ')"
rm -f /tmp/_ref.db

for CYCLE in 1 2 3; do
  echo ""
  echo "=== CYCLE $CYCLE ==="

  # BACKUP
  rm -rf /tmp/bk; mkdir -p /tmp/bk
  sh scripts/backup.sh /tmp/bk > /tmp/bk.log 2>&1
  BK=$(ls /tmp/bk/egaop-backup-*.tar.gz 2>/dev/null | head -1)
  echo "  [1/4] BACKUP  -> $(wc -c < $BK) bytes"

  # DESTROY
  docker exec "$GRAFANA" sh -c 'rm -f /var/lib/grafana/grafana.db && touch /var/lib/grafana/grafana.db' 2>/dev/null
  docker exec "$REDIS" redis-cli DEL bk:test:val >/dev/null 2>&1
  echo "TRUNCATE bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -U egaop -d egaop 2>/dev/null
  echo "  [2/4] DESTROY -> grafana.db emptied, redis key deleted, pg truncated"

  # RESTORE
  echo "y" | sh scripts/restore.sh "$BK" > /tmp/rest.log 2>&1
  sleep 5
  echo "  [3/4] RESTORE done"

  # VERIFY
  docker cp "$GRAFANA":/var/lib/grafana/grafana.db /tmp/_v.db 2>/dev/null
  V_DS=$(sqlite3 /tmp/_v.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null || echo "MISSING")
  V_ORG=$(sqlite3 /tmp/_v.db "SELECT name FROM org LIMIT 1;" 2>/dev/null || echo "MISSING")
  V_REDIS=$(docker exec "$REDIS" redis-cli GET bk:test:val 2>/dev/null || echo "MISSING")
  V_PG=$(echo "SELECT count(*)||' rows, val='||val FROM bk_verify ORDER BY id LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGSQL" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "MISSING")
  rm -f /tmp/_v.db

  echo "  [4/4] VERIFY"
  echo "    Grafana DS:  $V_DS       (expected: $REF_DS)"
  echo "    Grafana Org: $V_ORG      (expected: $REF_ORG)"
  echo "    Redis key:   $V_REDIS    (expected: hello-world-42)"
  echo "    PG content:  $V_PG       (expected: 1 rows, val=backup-test-record-1)"

  FAIL=""
  [ "$V_DS" != "$REF_DS" ]    && FAIL="$FAIL ds"
  [ "$V_ORG" != "$REF_ORG" ]  && FAIL="$FAIL org"
  [ "$V_REDIS" != "hello-world-42" ] && FAIL="$FAIL redis"
  [ "$V_PG" != *"1 rows"* ]   && FAIL="$FAIL pg"

  if [ -z "$FAIL" ]; then echo "  >>> PASS <<<"; else echo "  >>> FAIL: $FAIL <<<"; fi
done
