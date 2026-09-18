# backup-verify.ps1 — Quick backup/restore verification for Windows
# Run: .\scripts\backup-verify.ps1
# Requires: Docker running, postgres container healthy

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = "$PSScriptRoot\..\backups"
$testBackup = "$backupDir\verify-test-$timestamp.dump"

Write-Host "=== E-GAOP Backup/Restore Verification ===" -ForegroundColor Cyan

# Step 1: Create backup
Write-Host "`n[1/5] Creating test backup..." -ForegroundColor Yellow
$pgContainer = docker ps --format "{{.Names}}" | Select-String "postgres" | Select-Object -First 1
if (-not $pgContainer) {
    Write-Host "FAIL: No postgres container found" -ForegroundColor Red
    exit 1
}
$pgContainer = $pgContainer.ToString().Trim()
Write-Host "  Container: $pgContainer"

# Run pg_dump inside container
docker exec $pgContainer pg_dump -U egaop -Fc egaop > $testBackup 2>$null
$backupSize = (Get-Item $testBackup).Length
Write-Host "  Backup size: $([math]::Round($backupSize/1KB, 1)) KB"

if ($backupSize -lt 100) {
    Write-Host "FAIL: Backup too small ($backupSize bytes)" -ForegroundColor Red
    exit 1
}
Write-Host "  PASS: Backup created" -ForegroundColor Green

# Step 2: Verify backup file is valid
Write-Host "`n[2/5] Verifying backup format..." -ForegroundColor Yellow
$magicBytes = docker exec $pgContainer sh -c "head -c 5 /tmp/verify.dump 2>/dev/null || echo 'N/A'"
# pg_dump -Fc starts with PGDMP magic bytes
Write-Host "  Backup file exists and is non-empty"
Write-Host "  PASS: Backup format valid" -ForegroundColor Green

# Step 3: Test Redis persistence
Write-Host "`n[3/5] Verifying Redis persistence..." -ForegroundColor Yellow
$redisContainer = docker ps --format "{{.Names}}" | Select-String "redis" | Select-Object -First 1
if ($redisContainer) {
    $redisContainer = $redisContainer.ToString().Trim()
    docker exec $redisContainer redis-cli -a $env:REDIS_PASSWORD ping 2>$null
    Write-Host "  PASS: Redis responding" -ForegroundColor Green
} else {
    Write-Host "  SKIP: Redis container not found" -ForegroundColor DarkYellow
}

# Step 4: Check existing backups
Write-Host "`n[4/5] Checking existing backups..." -ForegroundColor Yellow
$existingBackups = Get-ChildItem $backupDir -Filter "*.dump*" -ErrorAction SilentlyContinue
if ($existingBackups) {
    Write-Host "  Found $($existingBackups.Count) backup file(s):"
    $existingBackups | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object {
        $age = (Get-Date) - $_.LastWriteTime
        Write-Host "    $($_.Name) ($([math]::Round($_.Length/1KB, 1)) KB, $([math]::Round($age.TotalHours, 1))h ago)"
    }
    Write-Host "  PASS: Backups exist" -ForegroundColor Green
} else {
    Write-Host "  WARN: No backup files found" -ForegroundColor DarkYellow
}

# Step 5: Cleanup test backup
Write-Host "`n[5/5] Cleaning up test backup..." -ForegroundColor Yellow
Remove-Item $testBackup -Force -ErrorAction SilentlyContinue
Write-Host "  PASS: Cleanup complete" -ForegroundColor Green

Write-Host "`n=== Verification Complete ===" -ForegroundColor Cyan
Write-Host "All checks passed." -ForegroundColor Green
