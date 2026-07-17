#!/bin/sh
# task-bd-v2.sh — 3 backup->destroy->restore->verify cycles with content comparison
set -u
cd /workspace
apk add --no-cache sqlite >/dev/null 2>&1 || true

GFN=$(docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | grep -i grafana | grep -v exporter | head -1 | tr -d '\r\n')
RDN=$(docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | grep -i redis | grep -v exporter | head -1 | tr -d '\r\n')
PGN=$(docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | grep -i postgres | grep -v exporter | head -1 | tr -d '\r\n')
PW=$(grep POSTGRES_PASSWORD .env 2>/dev/null | tail -1 | cut -d= -f2-)

docker start "$GFN" "$RDN" 2>/dev/null || true
sleep 5

# --- REFERENCE ---
docker exec "$RDN" redis-cli SET bk:test:val "hello-world-42" >/dev/null 2>&1
echo "TRUNCATE bk_verify; CREATE TABLE IF NOT EXISTS bk_verify (id serial primary key, val text unique); INSERT INTO bk_verify (val) VALUES ('backup-test-record-1') ON CONFLICT (val) DO NOTHING;" | docker exec -i -e PGPASSWORD="$PW" "$PGN" psql -U egaop -d egaop 2>/dev/null

docker cp "$GFN":/var/lib/grafana/grafana.db /tmp/ref.db 2>/dev/null
REF_DS=$(sqlite3 /tmp/ref.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null)
REF_ORG=$(sqlite3 /tmp/ref.db "SELECT name FROM org LIMIT 1;" 2>/dev/null)
REF_REDIS=$(docker exec "$RDN" redis-cli GET bk:test:val 2>/dev/null)
REF_PG=$(echo "SELECT count(*)||' rows' FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGN" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ')
REF_PG_VAL=$(echo "SELECT val FROM bk_verify LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGN" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ')
rm -f /tmp/ref.db

echo "=== REFERENCE ==="
echo "  Grafana DS:  [$REF_DS]"
echo "  Grafana Org: [$REF_ORG]"
echo "  Redis key:   [$REF_REDIS]"
echo "  PG rows:     [$REF_PG]"
echo "  PG val:      [$REF_PG_VAL]"
echo ""

PASS=0; FAIL=0

for C in 1 2 3; do
  echo "=== CYCLE $C ==="

  # BACKUP
  rm -rf /tmp/bk; mkdir -p /tmp/bk
  sh scripts/backup.sh /tmp/bk >/tmp/bk.log 2>&1 || true
  BK=$(ls /tmp/bk/egaop-backup-*.tar.gz 2>/dev/null | head -1)
  echo "  [1/4] BACKUP -> $(wc -c < $BK) bytes"

  # DESTROY
  docker exec "$GFN" sh -c 'rm -f /var/lib/grafana/grafana.db && touch /var/lib/grafana/grafana.db' 2>/dev/null || true
  docker exec "$RDN" redis-cli DEL bk:test:val >/dev/null 2>&1 || true
  echo "TRUNCATE bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGN" psql -U egaop -d egaop 2>/dev/null || true
  echo "  [2/4] DESTROY done"

  # RESTORE
  echo "y" | sh scripts/restore.sh "$BK" >/tmp/rest.log 2>&1 || true
  sleep 12
  echo "  [3/4] RESTORE done"

  # VERIFY
  docker cp "$GFN":/var/lib/grafana/grafana.db /tmp/v.db 2>/dev/null || true
  V_DS=$(sqlite3 /tmp/v.db "SELECT name FROM data_source LIMIT 1;" 2>/dev/null || echo "MISSING")
  V_ORG=$(sqlite3 /tmp/v.db "SELECT name FROM org LIMIT 1;" 2>/dev/null || echo "MISSING")
  V_REDIS=$(docker exec "$RDN" redis-cli GET bk:test:val 2>/dev/null || echo "MISSING")
  V_PG=$(echo "SELECT count(*)||' rows' FROM bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGN" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "MISSING")
  V_PG_VAL=$(echo "SELECT val FROM bk_verify LIMIT 1;" | docker exec -i -e PGPASSWORD="$PW" "$PGN" psql -t -U egaop -d egaop 2>/dev/null | tr -d ' ' || echo "MISSING")
  rm -f /tmp/v.db

  echo "  [4/4] VERIFY"
  echo "    Grafana DS:  [$V_DS]  (ref: [$REF_DS])"
  echo "    Grafana Org: [$V_ORG] (ref: [$REF_ORG])"
  echo "    Redis key:   [$V_REDIS] (ref: [$REF_REDIS])"
  echo "    PG rows:     [$V_PG]   (ref: [$REF_PG])"
  echo "    PG val:      [$V_PG_VAL]  (ref: [$REF_PG_VAL])"

  ISSUES=""
  [ "$V_DS" != "$REF_DS" ] && ISSUES="$ISSUES ds"
  [ "$V_ORG" != "$REF_ORG" ] && ISSUES="$ISSUES org"
  [ "$V_REDIS" != "$REF_REDIS" ] && ISSUES="$ISSUES redis"
  [ "$V_PG" != "$REF_PG" ] && ISSUES="$ISSUES pg_cnt"
  [ "$V_PG_VAL" != "$REF_PG_VAL" ] && ISSUES="$ISSUES pg_val"

  if [ -z "$ISSUES" ]; then
    echo "  >>> CYCLE $C: PASS <<<"; PASS=$((PASS + 1))
  else
    echo "  >>> CYCLE $C: FAIL ($ISSUES) <<<"; FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "========================================"
echo " RESULTS: $PASS/3 passed, $FAIL/3 failed"
echo "========================================"

# cleanup
docker exec "$RDN" redis-cli DEL bk:test:val >/dev/null 2>&1 || true
echo "TRUNCATE bk_verify;" | docker exec -i -e PGPASSWORD="$PW" "$PGN" psql -U egaop -d egaop 2>/dev/null || true
