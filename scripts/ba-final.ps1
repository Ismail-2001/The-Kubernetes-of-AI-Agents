# ba-final.ps1 — 3 independent backup->destroy->restore->content-verify cycles
param([int]$Cycles=3)
$ErrorActionPreference = "Continue"
$root = "C:\Users\Ismail Sajid\Downloads\Enterprise-Grade-Agent-Orchestration-Platform-main\Enterprise-Grade-Agent-Orchestration-Platform-main"
Set-Location $root
rm -r tmp\bk -ErrorAction SilentlyContinue; mkdir -p tmp\bk *>$null

$G = "enterprise-grade-agent-orchestration-platform-main-grafana-1"
$R = "enterprise-grade-agent-orchestration-platform-main-redis-1"
$P = "enterprise-grade-agent-orchestration-platform-main-postgres-1"
$PW = "egaop_secret_2024"
$GFU = "admin"; $GFP = "mFyPXzUf1w"; $GFPORT = "3003"

# ─── SETUP ref data ───
docker exec $R redis-cli SET bk:test:val "hello-world-42" *>$null
docker exec -i -e "PGPASSWORD=$PW" $P psql -U egaop -d egaop *@"
TRUNCATE bk_verify;
CREATE TABLE IF NOT EXISTS bk_verify (id serial primary key, val text unique);
INSERT INTO bk_verify (val) VALUES ('backup-test-record-1') ON CONFLICT (val) DO NOTHING;
"@ 2>$null

$refDS = (curl.exe -s -u "${GFU}:${GFP}" "http://localhost:${GFPORT}/api/datasources" | ConvertFrom-Json | Select-Object -First 1).name
$refOrg = (curl.exe -s -u "${GFU}:${GFP}" "http://localhost:${GFPORT}/api/org" | ConvertFrom-Json).name
$refRedis = docker exec $R redis-cli GET bk:test:val 2>$null
$refPg = docker exec -i -e "PGPASSWORD=$PW" $P psql -t -U egaop -d egaop -c "SELECT count(*)::text||' rows, val='||val FROM bk_verify ORDER BY id LIMIT 1;" 2>$null

Write-Output "Ref: DS=$refDS Org=$refOrg Redis=$refRedis PG=$($refPg.Trim())"
$pass = 0; $fail = 0

for ($c=1; $c -le $Cycles; $c++) {
  $bkdir = "tmp\bk\cycle${c}"
  mkdir -p $bkdir *>$null
  Write-Output "`n=== CYCLE ${c} ==="

  # ─── BACKUP ───
  docker exec -i -e "PGPASSWORD=$PW" $P pg_dump -U egaop -d egaop -F c > "${bkdir}\postgres_egaop.dump" *>$null
  docker exec -i -e "PGPASSWORD=$PW" $P pg_dump -U egaop -d temporal -F c > "${bkdir}\postgres_temporal.dump" *>$null
  docker exec $G sh -c "tar cz -C /var/lib/grafana --exclude=plugins --exclude=plugins-bundled ." > "${bkdir}\grafana-data.tar.gz" *>$null
  docker exec $R redis-cli SAVE *>$null
  docker exec $R sh -c "tar cz -C /data ." > "${bkdir}\redis-data.tar.gz" *>$null
  Write-Output "  BACKUP -> $(Get-ChildItem $bkdir | Measure-Object Length -Sum).Sum bytes"

  # ─── DESTROY ───
  docker exec $G sh -c "rm -f /var/lib/grafana/grafana.db && touch /var/lib/grafana/grafana.db" *>$null
  docker exec $R redis-cli DEL bk:test:val *>$null
  docker exec -i -e "PGPASSWORD=$PW" $P psql -U egaop -d egaop -c "TRUNCATE bk_verify;" *>$null
  Write-Output "  DESTROY done"

  # ─── RESTORE ───
  Get-Content "${bkdir}\grafana-data.tar.gz" | docker exec -i $G sh -c "tar xz -C /var/lib/grafana" *>$null
  Get-Content "${bkdir}\redis-data.tar.gz" | docker exec -i $R sh -c "tar xz -C /data" *>$null
  Get-Content "${bkdir}\postgres_egaop.dump" | docker exec -i -e "PGPASSWORD=$PW" $P pg_restore -U egaop -d egaop --clean --if-exists *>$null
  docker restart $G *>$null; Start-Sleep 8
  Write-Output "  RESTORE done"

  # ─── VERIFY ───
  $vDS = (curl.exe -s -u "${GFU}:${GFP}" "http://localhost:${GFPORT}/api/datasources" | ConvertFrom-Json | Select-Object -First 1).name
  $vOrg = (curl.exe -s -u "${GFU}:${GFP}" "http://localhost:${GFPORT}/api/org" | ConvertFrom-Json).name
  $vRedis = docker exec $R redis-cli GET bk:test:val 2>$null
  $vPg = docker exec -i -e "PGPASSWORD=$PW" $P psql -t -U egaop -d egaop -c "SELECT count(*)::text||' rows, val='||val FROM bk_verify ORDER BY id LIMIT 1;" 2>$null
  Write-Output "  VERIFY: DS=$vDS Org=$vOrg Redis=$vRedis PG=$($vPg.Trim())"

  $issues = @()
  if ($vDS -ne $refDS) { $issues += "ds" }
  if ($vOrg -ne $refOrg) { $issues += "org" }
  if ($vRedis -ne $refRedis) { $issues += "redis" }
  if ($vPg -ne $refPg) { $issues += "pg" }

  if ($issues.Count -eq 0) { Write-Output "  >>> CYCLE ${c}: PASS <<<"; $pass++ }
  else { Write-Output "  >>> CYCLE ${c}: FAIL ($($issues -join ',')) <<<"; $fail++ }
}

Write-Output "`n============================"
Write-Output " RESULTS: $pass/$Cycles passed, $fail/$Cycles failed"
Write-Output "============================"
