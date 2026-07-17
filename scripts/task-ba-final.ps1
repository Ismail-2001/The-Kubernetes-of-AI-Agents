# task-ba-final.ps1 — 3 independent backup->destroy->restore->content-verify cycles
# Uses Grafana API (not sqlite) for production-realistic content verification
param([int]$Cycles=3)
$ErrorActionPreference = "Stop"
$root = "C:\Users\Ismail Sajid\Downloads\Enterprise-Grade-Agent-Orchestration-Platform-main\Enterprise-Grade-Agent-Orchestration-Platform-main"
Set-Location $root

mkdir -p "$root\tmp" -Force *>$null

function _cname($pat) {
    docker ps -a --filter "name=enterprise-grade" --format "{{.Names}}" | Where-Object { $_ -match $pat } | Where-Object { $_ -notmatch "exporter" } | Select-Object -First 1
}

$GRAFANA = _cname "grafana"; $REDIS = _cname "redis"; $PGSQL = _cname "postgres"
docker start $GRAFANA, $REDIS 2>$null; Start-Sleep 5

$PW = (Get-Content .env | Where-Object { $_ -match "POSTGRES_PASSWORD" } | Select-Object -Last 1) -replace ".*=",""

# ─── SETUP: create test data & capture reference content ──────────────────
Write-Output "=== SETUP: Create test data ==="

docker exec $REDIS redis-cli SET bk:test:val "hello-world-42" *>$null 2>&1
$pgInsert = @"
TRUNCATE bk_verify;
CREATE TABLE IF NOT EXISTS bk_verify (id serial primary key, val text unique);
INSERT INTO bk_verify (val) VALUES ('backup-test-record-1') ON CONFLICT (val) DO NOTHING;
"@
$pgInsert | docker exec -i -e "PGPASSWORD=$PW" $PGSQL psql -U egaop -d egaop 2>$null

# Capture reference via Grafana REST API + direct queries
$GF_KEY = "admin:admin"  # default dev credentials from docker-compose / .env
$GF_BASE = "http://localhost:3000"
$refDS = (curl -s -u $GF_KEY "$GF_BASE/api/datasources" 2>$null | ConvertFrom-Json | Select-Object -First 1).name
if (-not $refDS) { $refDS = "(check Grafana port/credentials)" }
$refOrg = (curl -s -u $GF_KEY "$GF_BASE/api/org" 2>$null | ConvertFrom-Json).name
if (-not $refOrg) { $refOrg = "(check Grafana port/credentials)" }
$refRedis = docker exec $REDIS redis-cli GET bk:test:val 2>$null
$refPg = docker exec -i -e "PGPASSWORD=$PW" $PGSQL psql -t -U egaop -d egaop -c "SELECT count(*)::text||' rows, val='||val FROM bk_verify ORDER BY id LIMIT 1;" 2>$null
$refPg = $refPg.Trim() -replace '\s+', ' '

Write-Output "  Ref Grafana DS:  $refDS"
Write-Output "  Ref Grafana Org: $refOrg"
Write-Output "  Ref Redis:       $refRedis"
Write-Output "  Ref PG:          $refPg"

$pass = 0; $fail = 0

for ($c=1; $c -le $Cycles; $c++) {
    Write-Output ""
    Write-Output "=== CYCLE $c ==="

    # ─── 1. BACKUP ───
    Remove-Item "$root\tmp\bk" -Recurse -ErrorAction SilentlyContinue
    New-Item "$root\tmp\bk" -ItemType Directory -Force *>$null
    & "$root\scripts\backup.sh" "$root\tmp\bk" *>$null
    $BK = Get-ChildItem "$root\tmp\bk\egaop-backup-*.tar.gz" | Select-Object -First 1
    Write-Output "  [1/4] BACKUP  -> $($BK.Length) bytes"

    # ─── 2. DESTROY ───
    # wipe grafana.db, delete redis key, truncate PG test table
    docker exec $GRAFANA sh -c "rm -f /var/lib/grafana/grafana.db && touch /var/lib/grafana/grafana.db" 2>$null
    docker exec $REDIS redis-cli DEL bk:test:val *>$null
    "TRUNCATE bk_verify;" | docker exec -i -e "PGPASSWORD=$PW" $PGSQL psql -U egaop -d egaop 2>$null
    # verify destruction
    $afterRedis = docker exec $REDIS redis-cli GET bk:test:val 2>$null
    $afterPg = docker exec -i -e "PGPASSWORD=$PW" $PGSQL psql -t -U egaop -d egaop -c "SELECT count(*) FROM bk_verify;" 2>$null
    $afterPg = $afterPg.Trim()
    # Grafana API should 404 or return empty after db wipe + restart
    Write-Output "  [2/4] DESTROY -> grafana.db reset, Redis($afterRedis), PG(count=$afterPg)"

    # ─── 3. RESTORE ───
    "y" | & "$root\scripts\restore.sh" $BK.FullName *>$null
    docker restart $GRAFANA *>$null
    Start-Sleep 8
    Write-Output "  [3/4] RESTORE done"

    # ─── 4. VERIFY content ───
    $vDS = (curl -s -u $GF_KEY "$GF_BASE/api/datasources" 2>$null | ConvertFrom-Json | Select-Object -First 1).name
    if (-not $vDS) { $vDS = "MISSING" }
    $vOrg = (curl -s -u $GF_KEY "$GF_BASE/api/org" 2>$null | ConvertFrom-Json).name
    if (-not $vOrg) { $vOrg = "MISSING" }
    $vRedis = docker exec $REDIS redis-cli GET bk:test:val 2>$null
    $vPg = docker exec -i -e "PGPASSWORD=$PW" $PGSQL psql -t -U egaop -d egaop -c "SELECT count(*)::text||' rows, val='||val FROM bk_verify ORDER BY id LIMIT 1;" 2>$null
    $vPg = $vPg.Trim() -replace '\s+', ' '

    Write-Output "  [4/4] VERIFY"
    Write-Output "    Grafana DS:  $vDS       (ref: $refDS)"
    Write-Output "    Grafana Org: $vOrg      (ref: $refOrg)"
    Write-Output "    Redis key:   $vRedis    (ref: $refRedis)"
    Write-Output "    PG content:  $vPg       (ref: $refPg)"

    $issues = @()
    if ($vDS -ne $refDS) { $issues += "ds" }
    if ($vOrg -ne $refOrg) { $issues += "org" }
    if ($vRedis -ne $refRedis) { $issues += "redis" }
    if ($vPg -ne $refPg) { $issues += "pg" }

    if ($issues.Count -eq 0) { Write-Output "  >>> CYCLE ${c}: PASS <<<"; $pass++ }
    else { Write-Output "  >>> CYCLE ${c}: FAIL ($($issues -join ',')) <<<"; $fail++ }
}

Write-Output ""
Write-Output "========================================"
Write-Output " RESULTS: $pass/$Cycles passed, $fail/$Cycles failed"
Write-Output "========================================"
